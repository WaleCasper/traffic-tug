import { loadConfig, playerId, subscribe, merge, fmtBytes, fmtInt } from './net.js';
import { createTugScene, createHeistScene, tugResult, heistResult, GAME_INFO } from './scenes.js';

const $ = id => document.getElementById(id);
const cfg = await loadConfig();
const params = new URLSearchParams(location.search);
let team = (params.get('team') || '').toUpperCase();
if (!team) { try { team = localStorage.getItem('tt_team') || ''; } catch (_) {} }
if (team !== 'A' && team !== 'B') { location.href = '/'; }
if (team !== cfg.team) { location.href = `${cfg.public_urls[team]}/play?team=${team}`; }
try { localStorage.setItem('tt_team', team); } catch (_) {}

const pid = playerId();
const t = team.toLowerCase();
$('teamBadge').classList.add(t);
$('teamName').textContent = `${team} 隊`;
$('tapBtn').classList.add(t);
$('switchTeam').href = cfg.join_url || '/';

let view = 'lobby';           // 'lobby' 或遊戲代號
let manualLobby = false;      // 玩家自己按回大廳
let scene = null;
let sceneGame = null;
let latest = null;
let myTaps = 0;
let lastTap = 0;
let busy = false;

function showLobby() {
  view = 'lobby';
  $('lobby').classList.remove('hidden');
  $('game').classList.add('hidden');
}

function showGame(game) {
  view = game;
  $('lobby').classList.add('hidden');
  $('game').classList.remove('hidden');
  if (sceneGame !== game) {
    scene = game === 'tug' ? createTugScene($('scene')) : createHeistScene($('scene'));
    sceneGame = game;
    myTaps = 0;
  }
  $('gameTitle').textContent = `${GAME_INFO[game].icon} ${GAME_INFO[game].title}`;
  if (latest) render(latest);
}

for (const card of document.querySelectorAll('.card')) {
  card.addEventListener('click', () => {
    const m = latest;
    if (!m || m.game !== card.dataset.game) {
      card.classList.add('shake'); setTimeout(() => card.classList.remove('shake'), 300);
      return;
    }
    manualLobby = false;
    showGame(card.dataset.game);
  });
}
$('backBtn').addEventListener('click', () => { manualLobby = true; showLobby(); });

// ---------- 點擊 ----------
async function sendTap(game) {
  const res = await fetch(`/api/tap?game=${game}`, {
    method: 'POST', headers: { 'X-Player-Id': pid }, cache: 'no-store',
  });
  if (res.ok) { await res.arrayBuffer(); return 'ok'; }
  const data = await res.json().catch(() => ({}));
  return data.error || 'error';
}

const HINTS = {
  too_fast: '太快了!照節奏點', server_busy: '伺服器忙碌中', bandwidth_cap: '已達流量上限',
  caught: '被抓到了,等下一回合', escaped: '已經得手!', not_running: '回合還沒開始',
  unknown_player: '連線中,請稍候', error: '連線失敗',
};

$('tapBtn').addEventListener('pointerdown', async e => {
  e.preventDefault();
  const m = latest;
  if (!m || view !== m.game || m.phase !== 'running') return;
  const own = m[team];
  const perSec = m.game === 'tug' ? own.client.tug_taps_per_sec : own.client.heist_taps_per_sec;
  const now = performance.now();
  const btn = $('tapBtn');
  btn.classList.add('pressed'); setTimeout(() => btn.classList.remove('pressed'), 90);
  if (now - lastTap < 1000 / perSec || busy) {
    $('tapHint').textContent = HINTS.too_fast;
    return;
  }
  lastTap = now;
  busy = true;
  if (navigator.vibrate) navigator.vibrate(12);
  const burst = m.game === 'tug' ? own.client.tug_burst : 1;
  try {
    const results = await Promise.all(Array.from({ length: burst }, () => sendTap(m.game)));
    const ok = results.filter(r => r === 'ok').length;
    if (ok) { myTaps++; $('myTaps').textContent = fmtInt(myTaps); $('tapHint').textContent = ''; }
    else $('tapHint').textContent = HINTS[results[0]] || HINTS.error;
  } catch (_) {
    $('tapHint').textContent = HINTS.error;
  } finally {
    busy = false;
  }
});

// ---------- 畫面 ----------
function renderLobby(m) {
  for (const card of document.querySelectorAll('.card')) {
    const g = card.dataset.game;
    const open = m.game === g;
    card.classList.toggle('live', open);
    card.classList.toggle('locked', !open);
    const label = !open ? '尚未開放' : m.phase === 'running' ? '進行中' : m.phase === 'countdown' ? '即將開始' : m.phase === 'finished' ? '已結束' : '開放中';
    card.querySelector('.state').textContent = label;
  }
}

function renderVersus(m) {
  const a = m.A, b = m.B;
  if (!a || !b) return;
  if (m.game === 'tug') {
    const key = m.revealed ? 'packets' : 'bytes';
    const f = key === 'bytes' ? fmtBytes : n => `${fmtInt(n)} 包`;
    $('versus').innerHTML = `
      <div class="va"><span class="team-a">A 隊 · ${a.players} 人</span><br><b class="num">${f(a.round[key])}</b><br><span class="muted num">${a.live.mbps.toFixed(2)} Mbps · ${fmtInt(a.live.pps)} pps</span></div>
      <div class="vb"><span class="team-b">B 隊 · ${b.players} 人</span><br><b class="num">${f(b.round[key])}</b><br><span class="muted num">${b.live.mbps.toFixed(2)} Mbps · ${fmtInt(b.live.pps)} pps</span></div>`;
  } else {
    const row = (s, cls) => `<span class="team-${cls}">${s.team} 隊 · ${s.players} 人</span><br><b class="num">${Math.round(Math.min(1, s.heist.progress_bytes / Math.max(1, s.heist.goal_bytes)) * 100)}%</b><br><span class="muted num">噪音 ${s.heist.noise_mbps.toFixed(2)} / ${s.heist.threshold_mbps.toFixed(2)} Mbps</span>`;
    $('versus').innerHTML = `<div class="va">${row(a, 'a')}</div><div class="vb">${row(b, 'b')}</div>`;
  }
}

function renderResult(m) {
  const box = $('result');
  let html = '';
  if (m.game === 'tug' && m.phase === 'finished' && m.A && m.B) {
    const r = tugResult(m);
    const name = w => (w ? `${w} 隊勝` : '平手');
    html = m.revealed
      ? `以封包數計算<big>${name(r.packets)}!</big>A ${fmtInt(r.a.packets)} 包 vs B ${fmtInt(r.b.packets)} 包<br><span class="muted">流量大不等於封包多</span>`
      : `以流量計算<big>${name(r.bytes)}!</big>A ${fmtBytes(r.a.bytes)} vs B ${fmtBytes(r.b.bytes)}<br><span class="muted">等等……如果比的是封包數呢?</span>`;
  } else if (m.game === 'heist' && m.A && m.B) {
    const r = heistResult(m);
    const own = m[team].heist;
    if (m.phase === 'finished' || r.winner) html = `<big>${r.text}</big>`;
    else if (own.caught) html = '<big>你們被監視器抓到了!</big>';
  }
  box.innerHTML = html;
  box.classList.toggle('hidden', !html);
}

function renderButton(m) {
  const btn = $('tapBtn');
  const own = m[team];
  btn.classList.remove('caution', 'danger');
  let label = GAME_INFO[m.game]?.verb || '等待';
  let disabled = m.phase !== 'running';
  if (m.phase === 'countdown') label = '準備';
  if (m.phase === 'finished') label = '結束';
  if (m.phase === 'idle') label = '等待';
  if (m.game === 'heist' && own) {
    const h = own.heist;
    const ratio = h.noise_mbps / Math.max(0.001, h.threshold_mbps);
    if (h.caught) { disabled = true; label = '被抓了'; }
    else if (h.escaped) { disabled = true; label = '得手!'; }
    else if (m.phase === 'running' && ratio >= 1) btn.classList.add('danger');
    else if (m.phase === 'running' && ratio >= 0.75) btn.classList.add('caution');
    if (m.phase === 'running' && !h.caught && !h.escaped) {
      $('tapHint').textContent = ratio >= 1 ? '太大聲了!全隊放慢!' : ratio >= 0.75 ? '快接近門檻,小心' : $('tapHint').textContent;
    }
  }
  btn.disabled = disabled;
  btn.textContent = label;
}

function render(state) {
  const m = merge(state);
  $('connDot').classList.toggle('on', !!state.conn[team]);
  if (!m) return;
  latest = m;
  $('players').textContent = `A ${m.A?.players ?? 0} 人 · B ${m.B?.players ?? 0} 人`;
  renderLobby(m);

  // 自動切換:倒數或進行中就進入遊戲;換遊戲且閒置時回大廳
  if (m.game && (m.phase === 'countdown' || m.phase === 'running') && view !== m.game) {
    manualLobby = false;
    showGame(m.game);
  } else if (view !== 'lobby' && view !== m.game) {
    showLobby();
  }

  const cd = $('countdown');
  if (m.phase === 'countdown' && view === m.game) {
    cd.classList.remove('hidden');
    $('countNum').textContent = Math.max(1, Math.ceil(m.countdown));
    $('countMsg').textContent = m.game === 'tug' ? '準備好拼命按!' : '小心,別太大聲';
  } else cd.classList.add('hidden');

  if (view === 'lobby' || !scene) return;
  scene.update(m);
  $('timeLeft').textContent = m.phase === 'running' ? Math.ceil(m.timeLeft) : m.phase === 'countdown' ? '…' : '--';
  $('teamMbps').textContent = (m[team]?.live.mbps ?? 0).toFixed(2);
  renderVersus(m);
  renderResult(m);
  renderButton(m);
}

subscribe(cfg, { role: 'player', team, pid }, render);
