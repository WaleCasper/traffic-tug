import { loadConfig, subscribe, fmtBytes, fmtInt } from './net.js';

const $ = id => document.getElementById(id);
const cfg = await loadConfig();
const LABELS = {
  tug_duration: '拔河秒數', tug_a_bytes: 'A 隊每次回應 bytes(大包)', tug_b_bytes: 'B 隊每次回應 bytes(小包)',
  tug_b_burst: 'B 隊每次點擊連發請求數', tug_taps_per_sec: '拔河每人每秒點擊上限',
  heist_duration: '偷鑽石秒數', heist_step_bytes: '偷鑽石每步回應 bytes', heist_taps_per_sec: '偷鑽石每人每秒點擊上限',
  heist_group_size: '偷鑽石幾人為一級', heist_allow_per_group_mbps: '每級允許流量 Mbps(加在背景之上)',
  heist_goal_per_group_mb: '每級終點距離 MB', heist_grace_sec: '超過門檻幾秒觸發',
  max_rps: '每台每秒請求上限', max_mbps: '每台應用層流量上限 Mbps',
};

try { $('token').value = sessionStorage.getItem('tt_admin') || ''; } catch (_) {}
$('saveToken').addEventListener('click', () => {
  $('token').value = $('token').value.trim();
  try { sessionStorage.setItem('tt_admin', $('token').value); } catch (_) {}
  log('已記住密碼(關閉分頁後清除)');
});

function log(msg) {
  const time = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  $('log').textContent = `[${time}] ${msg}\n` + $('log').textContent;
}

function headers() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${$('token').value.trim()}` };
}

async function both(path, body) {
  const calls = ['A', 'B'].map(async t => {
    try {
      const res = await fetch(`${cfg.public_urls[t]}${path}`, {
        method: 'POST', headers: headers(), body: JSON.stringify(body || {}),
      });
      const data = await res.json().catch(() => ({}));
      const why = { unauthorized: '密碼錯誤', server_token_not_set: '伺服器沒有設定 ADMIN_TOKEN' }[data.error] || data.error || res.status;
      return `${t}:${res.ok ? 'OK' : `失敗(${why})`}`;
    } catch (e) {
      return `${t}:無法連線`;
    }
  });
  log(`${path} → ${(await Promise.all(calls)).join(',')}`);
}

for (const btn of document.querySelectorAll('[data-act]')) {
  btn.addEventListener('click', () => {
    const act = btn.dataset.act;
    if (act === 'reset' && !confirm('確定要重置本回合的分數?')) return;
    both(`/api/admin/${act}`, act === 'select' ? { game: btn.dataset.game } : act === 'start' ? { countdown: 3 } : {});
  });
}

async function loadParams() {
  try {
    const res = await fetch(`${cfg.public_urls.A}/api/admin/params`, { headers: headers() });
    const data = await res.json();
    if (!data.ok) { log('讀取參數失敗:密碼錯誤?'); return; }
    $('params').innerHTML = Object.entries(data.params).map(([k, v]) =>
      `<label>${LABELS[k] || k}<input data-key="${k}" value="${v}" inputmode="decimal"></label>`).join('');
    log('已從 A 讀取參數');
  } catch (_) { log('讀取參數失敗:無法連線'); }
}

$('loadParams').addEventListener('click', loadParams);
$('applyParams').addEventListener('click', () => {
  const body = {};
  for (const input of document.querySelectorAll('#params input')) body[input.dataset.key] = Number(input.value);
  if (!Object.keys(body).length) { log('請先讀取參數'); return; }
  both('/api/admin/params', body);
});

subscribe(cfg, { role: 'viewer' }, state => {
  $('status').innerHTML = ['A', 'B'].map(t => {
    const s = state[t];
    if (!s) return `<tr><td>${t}</td><td>${state.conn[t] ? '🟢' : '🔴'}</td><td colspan="9" class="muted">尚無資料</td></tr>`;
    return `<tr><td>${t}</td><td>${state.conn[t] ? '🟢' : '🔴'}</td><td>${s.game || '-'}</td><td>${s.phase}${s.revealed ? '(已反轉)' : ''}</td>
      <td class="num">${s.phase === 'running' ? Math.ceil(s.time_left) + 's' : '-'}</td><td class="num">${s.players}</td>
      <td class="num">${s.live.mbps.toFixed(2)}</td><td class="num">${fmtInt(s.live.pps)}</td>
      <td class="num">${fmtBytes(s.round.bytes)}</td><td class="num">${fmtInt(s.round.packets)}</td><td>${s.source === 'nic' ? '網卡實測' : '應用層估算'}</td></tr>`;
  }).join('');
});

if ($('token').value) loadParams();
