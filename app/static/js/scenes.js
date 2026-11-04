// 兩個遊戲的動畫場景(手機與投影共用)以及勝負判定。
import { fmtBytes, fmtInt } from './net.js';

const SVG = 'http://www.w3.org/2000/svg';
const A = '#ff7a45', B = '#2ec5ff';

function el(root, sel) { return root.querySelector(sel); }

// ======================= 拔河 =======================
function puller(x, color, mirror, cls) {
  const s = mirror ? -1 : 1;
  return `
  <g transform="translate(${x},0) scale(${s},1)">
    <g class="puller ${cls}">
      <line x1="10" y1="232" x2="34" y2="290" stroke="${color}" stroke-width="9" stroke-linecap="round"/>
      <line x1="10" y1="232" x2="-16" y2="290" stroke="${color}" stroke-width="9" stroke-linecap="round"/>
      <line x1="10" y1="234" x2="-14" y2="176" stroke="${color}" stroke-width="12" stroke-linecap="round"/>
      <line x1="-12" y1="184" x2="30" y2="201" stroke="${color}" stroke-width="7" stroke-linecap="round"/>
      <circle cx="-20" cy="158" r="17" fill="${color}"/>
      <rect x="-37" y="150" width="34" height="6" rx="3" fill="#0b1020" opacity=".55"/>
    </g>
  </g>`;
}

export function createTugScene(container) {
  container.innerHTML = `
  <svg viewBox="0 0 1000 380" role="img" aria-label="拔河即時畫面" style="overflow:hidden">
    <defs>
      <linearGradient id="tugGround" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="#26326a"/><stop offset="1" stop-color="#151d3f"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="500" height="380" fill="${A}" opacity=".07"/>
    <rect x="500" y="0" width="500" height="380" fill="${B}" opacity=".07"/>
    <rect x="0" y="292" width="1000" height="88" fill="url(#tugGround)"/>
    <line x1="500" y1="70" x2="500" y2="300" stroke="#eef2ff" stroke-width="3" stroke-dasharray="10 10" opacity=".45"/>
    <line x1="360" y1="250" x2="360" y2="300" stroke="${A}" stroke-width="4" opacity=".6"/>
    <line x1="640" y1="250" x2="640" y2="300" stroke="${B}" stroke-width="4" opacity=".6"/>
    <text x="40" y="52" font-size="30" font-weight="900" fill="${A}">A 隊</text>
    <text x="960" y="52" font-size="30" font-weight="900" fill="${B}" text-anchor="end">B 隊</text>
    <text class="metric-label" x="500" y="44" font-size="24" font-weight="700" fill="#eef2ff" text-anchor="middle">比較:流量 Bytes</text>
    <g class="rope-group">
      <line x1="-300" y1="200" x2="1300" y2="200" stroke="#c9a26b" stroke-width="11" stroke-linecap="round"/>
      <line x1="-300" y1="200" x2="1300" y2="200" stroke="#8a6a3f" stroke-width="11" stroke-dasharray="4 14" opacity=".7"/>
      <rect x="494" y="170" width="12" height="64" rx="4" fill="#ff4d6d"/>
      <circle cx="500" cy="200" r="13" fill="#ff4d6d" stroke="#fff" stroke-width="3"/>
      ${puller(190, A, false, 'ra')}${puller(260, A, false, 'ra')}${puller(330, A, false, 'ra')}
      ${puller(810, B, true, 'rb')}${puller(740, B, true, 'rb')}${puller(670, B, true, 'rb')}
    </g>
    <text class="val-a num" x="40" y="352" font-size="22" font-weight="700" fill="${A}">0</text>
    <text class="val-b num" x="960" y="352" font-size="22" font-weight="700" fill="${B}" text-anchor="end">0</text>
  </svg>`;
  const svg = container.querySelector('svg');
  return {
    update(m) {
      const metric = m.revealed ? 'packets' : 'bytes';
      const va = m.A?.round?.[metric] || 0, vb = m.B?.round?.[metric] || 0;
      const total = va + vb;
      const p = total > 0 ? (va - vb) / total : 0;           // A 多 → 繩子往左
      const shift = -150 * Math.tanh(3 * p);                   // 放大小差距,最多移 150
      const rope = el(svg, '.rope-group');
      rope.style.transitionDuration = m.revealed !== this._rev ? '2.4s' : '1s';
      this._rev = m.revealed;
      rope.style.transform = `translateX(${shift.toFixed(1)}px)`;
      el(svg, '.metric-label').textContent = m.revealed ? '比較:封包數 Packets' : '比較:流量 Bytes';
      const f = metric === 'bytes' ? fmtBytes : (n => `${fmtInt(n)} 個封包`);
      el(svg, '.val-a').textContent = f(va);
      el(svg, '.val-b').textContent = f(vb);
      svg.classList.toggle('running', m.phase === 'running');
    },
  };
}

export function tugResult(m) {
  const a = m.A?.round || {}, b = m.B?.round || {};
  const pick = (x, y) => (x === y ? null : x > y ? 'A' : 'B');
  return {
    bytes: pick(a.bytes || 0, b.bytes || 0),
    packets: pick(a.packets || 0, b.packets || 0),
    a, b,
  };
}

// ======================= 偷鑽石 =======================
function thief(color) {
  return `
    <g class="walk">
      <line class="leg1" x1="-4" y1="-6" x2="-12" y2="16" stroke="#0d0f1c" stroke-width="7" stroke-linecap="round"/>
      <line class="leg2" x1="4" y1="-6" x2="12" y2="16" stroke="#0d0f1c" stroke-width="7" stroke-linecap="round"/>
      <circle cx="-20" cy="-26" r="14" fill="#3a2f5a" stroke="#0d0f1c" stroke-width="3"/>
      <rect x="-11" y="-40" width="22" height="36" rx="9" fill="#0d0f1c"/>
      <circle cx="4" cy="-52" r="13" fill="#0d0f1c"/>
      <rect x="-9" y="-57" width="26" height="8" rx="4" fill="${color}"/>
      <circle cx="11" cy="-53" r="2.4" fill="#fff"/>
    </g>
    <text class="tag" x="0" y="-78" font-size="22" font-weight="900" text-anchor="middle" fill="#fff"></text>`;
}

function lane(team, y, color) {
  const id = team.toLowerCase();
  return `
  <g class="lane lane-${id}">
    <rect x="30" y="${y - 62}" width="940" height="118" rx="18" fill="${color}" opacity=".10"/>
    <rect class="flash" x="30" y="${y - 62}" width="940" height="118" rx="18" fill="#ff4d6d" opacity="0"/>
    <text x="52" y="${y - 30}" font-size="24" font-weight="900" fill="${color}">${team} 隊</text>
    <text class="lane-info num" x="470" y="${y + 46}" font-size="16" fill="#c7cfee"></text>
    <line x1="90" y1="${y + 22}" x2="850" y2="${y + 22}" stroke="#eef2ff" stroke-width="3" stroke-dasharray="6 12" opacity=".25"/>
    <text x="470" y="${y - 38}" font-size="15" fill="#95a0c8">噪音</text>
    <rect x="510" y="${y - 50}" width="240" height="14" rx="7" fill="#0b1020" opacity=".7"/>
    <rect class="noise" x="510" y="${y - 50}" width="0" height="14" rx="7" fill="#3ddc97"/>
    <line x1="${510 + 180}" y1="${y - 56}" x2="${510 + 180}" y2="${y - 30}" stroke="#ff4d6d" stroke-width="3"/>
    <text class="noise-txt num" x="762" y="${y - 38}" font-size="15" fill="#95a0c8">0 Mbps</text>
    <g transform="translate(905,${y + 22})">
      <rect x="-26" y="-6" width="52" height="34" rx="4" fill="#3a4677"/>
      <rect x="-22" y="-62" width="44" height="56" rx="6" fill="#bfe9ff" opacity=".14" stroke="#bfe9ff" stroke-opacity=".5"/>
      <polygon class="gem" points="0,-52 15,-36 0,-14 -15,-36" fill="#7df9ff" stroke="#fff" stroke-width="2"/>
    </g>
    <g class="thief" transform="translate(90,${y + 22})">${thief(color)}</g>
    <text class="pct num" x="52" y="${y + 46}" font-size="16" fill="#95a0c8">0%</text>
  </g>`;
}

export function createHeistScene(container) {
  container.innerHTML = `
  <svg viewBox="0 0 1000 470" role="img" aria-label="偷鑽石即時畫面">
    <defs>
      <linearGradient id="beamGrad" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="#fff3a8" stop-opacity=".55"/>
        <stop offset="1" stop-color="#fff3a8" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="beamRed" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="#ff4d6d" stop-opacity=".7"/>
        <stop offset="1" stop-color="#ff4d6d" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect width="1000" height="470" fill="#0e1533"/>
    <rect y="430" width="1000" height="40" fill="#151d3f"/>
    ${lane('A', 190, A)}
    ${lane('B', 360, B)}
    <polygon class="beam" points="500,52 430,470 570,470" fill="url(#beamGrad)"/>
    <g transform="translate(500,40)">
      <rect x="-30" y="-16" width="60" height="26" rx="6" fill="#d9deef"/>
      <circle cx="0" cy="12" r="10" fill="#0b1020" stroke="#d9deef" stroke-width="4"/>
      <circle class="cam-led" cx="20" cy="-6" r="4" fill="#3ddc97"/>
    </g>
    <text class="goal num" x="985" y="465" font-size="13" fill="#95a0c8" text-anchor="end"></text>
  </svg>`;
  const svg = container.querySelector('svg');
  const lanes = { A: { y: 190 }, B: { y: 360 } };
  return {
    update(m) {
      let alarm = false;
      for (const t of ['A', 'B']) {
        const s = m[t];
        const g = el(svg, `.lane-${t.toLowerCase()}`);
        if (!s) continue;
        const h = s.heist;
        const prog = Math.min(1, (h.progress_bytes || 0) / Math.max(1, h.goal_bytes));
        const x = 90 + prog * 760;
        el(g, '.thief').setAttribute('transform', `translate(${x.toFixed(1)},${lanes[t].y + 22})`);
        el(g, '.walk').style.animationPlayState = (m.phase === 'running' && !h.caught && !h.escaped && s.live.mbps > 0.05) ? 'running' : 'paused';
        el(g, '.pct').textContent = `${Math.round(prog * 100)}%  ·  ${fmtBytes(h.progress_bytes || 0)} / ${fmtBytes(h.goal_bytes)}`;
        const counted = h.groups * h.group_size;
        const people = h.players_locked || s.players;
        el(g, '.lane-info').textContent = `${people} 人 · 以 ${counted} 人計 · 門檻 ${h.threshold_mbps.toFixed(2)} Mbps`;
        const ratio = h.noise_mbps / Math.max(0.001, h.threshold_mbps);
        const w = Math.min(240, ratio * 180);
        const noise = el(g, '.noise');
        noise.setAttribute('width', w.toFixed(1));
        noise.setAttribute('fill', ratio >= 1 ? '#ff4d6d' : ratio >= 0.75 ? '#ffc53d' : '#3ddc97');
        el(g, '.noise-txt').textContent = `${h.noise_mbps.toFixed(2)} Mbps`;
        const tag = el(g, '.tag');
        const flash = el(g, '.flash');
        flash.classList.remove('lane-flash');
        flash.setAttribute('opacity', '0');
        el(g, '.gem').style.display = h.escaped ? 'none' : '';
        if (h.caught) {
          tag.textContent = '被偵測!'; tag.setAttribute('fill', '#ff4d6d');
          flash.setAttribute('opacity', '.35'); flash.classList.add('lane-flash'); alarm = true;
        } else if (h.escaped) {
          tag.textContent = '得手 💎'; tag.setAttribute('fill', '#7df9ff');
        } else if (h.warning) {
          tag.textContent = '噪音過大!'; tag.setAttribute('fill', '#ffc53d');
          flash.setAttribute('fill', '#ffc53d'); flash.setAttribute('opacity', '.2'); flash.classList.add('lane-flash');
        } else {
          tag.textContent = ''; flash.setAttribute('fill', '#ff4d6d');
        }
      }
      svg.classList.toggle('alarm', alarm);
      el(svg, '.beam').setAttribute('fill', alarm ? 'url(#beamRed)' : 'url(#beamGrad)');
      el(svg, '.cam-led').setAttribute('fill', alarm ? '#ff4d6d' : '#3ddc97');
      const ref = m.A || m.B;
      if (ref) {
        const h = ref.heist;
        const base = h.baseline_mbps ? `背景 ${h.baseline_mbps.toFixed(2)} Mbps + ` : '';
        el(svg, '.goal').textContent = `門檻 = ${base}每 ${h.group_size} 人 ${h.allow_per_group_mbps} Mbps(超過連續 2 秒觸發)`;
      }
    },
  };
}

export function heistResult(m) {
  const a = m.A?.heist, b = m.B?.heist;
  if (!a || !b) return { winner: null, text: '' };
  if (a.escaped && b.escaped) {
    const w = a.escaped_at <= b.escaped_at ? 'A' : 'B';
    return { winner: w, text: `${w} 隊先偷到鑽石!` };
  }
  if (a.escaped) return { winner: 'A', text: 'A 隊偷到鑽石,成功脫逃!' };
  if (b.escaped) return { winner: 'B', text: 'B 隊偷到鑽石,成功脫逃!' };
  if (m.phase !== 'finished') return { winner: null, text: '' };
  // 人數不同時終點也不同,所以比較的是完成百分比
  const pa = a.caught ? -1 : (a.progress_bytes || 0) / Math.max(1, a.goal_bytes);
  const pb = b.caught ? -1 : (b.progress_bytes || 0) / Math.max(1, b.goal_bytes);
  if (pa < 0 && pb < 0) return { winner: null, text: '兩隊都觸發警報,平手!' };
  if (pa === pb) return { winner: null, text: '平手!' };
  const w = pa > pb ? 'A' : 'B';
  const reason = (w === 'A' ? b.caught : a.caught) ? `,${w === 'A' ? 'B' : 'A'} 隊被偵測` : ',離鑽石最近';
  return { winner: w, text: `${w} 隊勝${reason}` };
}

export const GAME_INFO = {
  tug: { title: '流量拔河', icon: '🪢', verb: '拉!', desc: 'A 隊每次拉一大包資料,B 隊每次連發好幾個小封包。誰會贏?' },
  heist: { title: '偷鑽石', icon: '💎', verb: '前進', desc: '每點一次就前進一步並產生流量。太大聲會被監視器偵測!' },
};
