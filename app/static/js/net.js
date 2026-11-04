// 連線工具:讀取設定、產生玩家代碼、同時訂閱 A、B 兩台伺服器的即時資料。

export async function loadConfig() {
  const res = await fetch('/api/config', { cache: 'no-store' });
  return res.json();
}

export function playerId() {
  let id = null;
  try { id = localStorage.getItem('tt_pid'); } catch (_) {}
  if (!id) {
    const rand = crypto.getRandomValues(new Uint8Array(12));
    id = Array.from(rand, b => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem('tt_pid', id); } catch (_) {}
  }
  return id;
}

// 同時連到兩台伺服器的 /events,任一台更新就呼叫 onUpdate(state)
export function subscribe(cfg, { role = 'viewer', team = '', pid = '' }, onUpdate) {
  const state = { A: null, B: null, conn: { A: false, B: false } };
  for (const t of ['A', 'B']) {
    const qs = new URLSearchParams({ role, team, pid });
    const url = `${cfg.public_urls[t]}/events?${qs}`;
    const es = new EventSource(url);
    es.onmessage = e => {
      state[t] = JSON.parse(e.data);
      state.conn[t] = true;
      onUpdate(state);
    };
    es.onerror = () => { state.conn[t] = false; onUpdate(state); };
  }
  return state;
}

// 把兩台的狀態合併成畫面需要的整體狀態
export function merge(state) {
  const a = state.A, b = state.B;
  const any = a || b;
  if (!any) return null;
  const phases = [a?.phase, b?.phase];
  const order = ['running', 'countdown', 'finished', 'idle'];
  const phase = order.find(p => phases.includes(p)) || 'idle';
  return {
    A: a, B: b,
    game: a?.game || b?.game || null,
    phase,
    countdown: Math.max(a?.countdown_left || 0, b?.countdown_left || 0),
    timeLeft: Math.max(a?.time_left || 0, b?.time_left || 0),
    revealed: !!(a?.revealed || b?.revealed),
    alert: a?.zabbix_alert || b?.zabbix_alert || null,
    estimated: (a?.source === 'app') || (b?.source === 'app'),
  };
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function fmtInt(n) { return Math.round(n || 0).toLocaleString('en-US'); }
