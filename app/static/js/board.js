import { loadConfig, subscribe, merge, fmtBytes, fmtInt } from './net.js';
import { createTugScene, createHeistScene, tugResult, heistResult, GAME_INFO } from './scenes.js';

const $ = id => document.getElementById(id);
const cfg = await loadConfig();
const joinUrl = cfg.join_url;
$('joinUrl').textContent = joinUrl.replace(/^https?:\/\//, '');

// QR Code:從 cdnjs 載入產生器,載入失敗就只顯示網址
(function drawQr() {
  const s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
  s.onload = () => {
    const qr = window.qrcode(0, 'M');
    qr.addData(joinUrl);
    qr.make();
    $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  };
  s.onerror = () => { $('qr').style.display = 'none'; };
  document.head.appendChild(s);
})();

let scene = null, sceneGame = null;

function spark(seriesA, seriesB, idx) {
  const max = Math.max(0.01, ...seriesA.map(p => p[idx]), ...seriesB.map(p => p[idx]));
  const len = Math.max(10, seriesA.length, seriesB.length);
  return s => {
    if (!s.length) return '';
    const pts = s.map((p, i) => `${(i / (len - 1)) * 300},${50 - (p[idx] / max) * 46}`).join(' ');
    return `<svg class="spark" viewBox="0 0 300 54" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2.5" vector-effect="non-scaling-stroke"/></svg>`;
  };
}

function renderPanels(m) {
  const sa = m.A?.series || [], sb = m.B?.series || [];
  const usePps = m.game === 'tug' && m.revealed;
  const draw = spark(sa, sb, usePps ? 2 : 1);
  for (const t of ['A', 'B']) {
    const s = m[t];
    const panel = $(`panel${t}`);
    if (!s) { panel.innerHTML = `<h3>${t} 隊 <span class="muted" style="font-size:16px">未連線</span></h3>`; continue; }
    const color = t === 'A' ? 'var(--a)' : 'var(--b)';
    const extra = m.game === 'heist'
      ? `<div class="metric"><b class="num">${s.heist.noise_mbps.toFixed(2)}</b><span>噪音 Mbps(門檻 ${s.heist.threshold_mbps.toFixed(2)})</span></div>`
      : `<div class="metric"><b class="num">${fmtInt(s.round.packets)}</b><span>本回合封包數</span></div>`;
    panel.innerHTML = `
      <h3><span style="color:${color}">${t} 隊</span><span class="num" style="font-size:18px;font-weight:700">${s.players} 人</span></h3>
      <div class="metric"><b class="num">${s.live.mbps.toFixed(2)}</b><span>即時 Mbps</span></div>
      <div class="metric"><b class="num">${fmtInt(s.live.pps)}</b><span>即時封包/秒</span></div>
      <div class="metric"><b class="num">${fmtBytes(s.round.bytes)}</b><span>本回合流量</span></div>
      ${extra}
      <div style="color:${color}">${draw(s.series || [])}</div>`;
  }
}

function renderBanner(m) {
  const box = $('banner');
  let html = '';
  if (m.game === 'tug' && m.phase === 'finished' && m.A && m.B) {
    const r = tugResult(m);
    const name = w => (w ? `${w} 隊勝!` : '平手!');
    html = m.revealed
      ? `但如果比的是<b>封包數</b>……<big>${name(r.packets)}</big><span class="num">A ${fmtInt(r.a.packets)} 包 vs B ${fmtInt(r.b.packets)} 包</span><br><span class="muted">大包流量大、封包少;小包流量小、封包多</span>`
      : `以<b>流量 Bytes</b> 計算<big>${name(r.bytes)}</big><span class="num">A ${fmtBytes(r.a.bytes)} vs B ${fmtBytes(r.b.bytes)}</span>`;
  } else if (m.game === 'heist' && m.A && m.B) {
    const r = heistResult(m);
    if (m.phase === 'finished' || r.winner) html = `偷鑽石<big>${r.text}</big>`;
  }
  box.innerHTML = html;
  box.classList.toggle('hidden', !html);
  box.classList.toggle('top', m.game === 'heist');
}

function render(state) {
  const m = merge(state);
  if (!m) return;
  $('players').textContent = `A ${m.A?.players ?? 0} 人 · B ${m.B?.players ?? 0} 人`;
  const alert = m.alert;
  $('zbx').classList.toggle('hidden', !alert);
  if (alert) $('zbx').textContent = `⚠ Zabbix 告警:${alert.name}`;

  if (m.game) {
    $('title').textContent = `${GAME_INFO[m.game].icon} ${GAME_INFO[m.game].title}`;
    $('sub').textContent = m.estimated
      ? '(本機測試:數值為應用層估算)'
      : m.game === 'tug' ? 'A 隊:每次一大包 · B 隊:每次連發小封包 · 數據來自伺服器網卡實測'
        : `依各隊人數自動調整:每 ${m.A?.heist.group_size ?? 5} 人一級,人越多門檻越高、終點越遠`;
    if (sceneGame !== m.game) {
      scene = m.game === 'tug' ? createTugScene($('scene')) : createHeistScene($('scene'));
      sceneGame = m.game;
    }
    $('idle').classList.add('hidden');
    $('scene').classList.remove('hidden');
    scene.update(m);
  } else {
    $('title').textContent = '網路流量大作戰';
    $('sub').textContent = '掃描 QR Code 加入,選擇你的隊伍';
    $('idle').classList.remove('hidden');
    $('scene').classList.add('hidden');
  }

  $('timer').textContent = m.phase === 'running' ? `${Math.ceil(m.timeLeft)}s` : '';
  const cd = $('countdown');
  cd.classList.toggle('hidden', m.phase !== 'countdown');
  if (m.phase === 'countdown') $('countNum').textContent = Math.max(1, Math.ceil(m.countdown));
  renderPanels(m);
  renderBanner(m);
}

subscribe(cfg, { role: 'board' }, render);
