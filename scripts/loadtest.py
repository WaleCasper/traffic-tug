#!/usr/bin/env python3
"""負載測試 / 模擬玩家(只用 Python 標準函式庫)。

模擬每隊 N 位玩家:先連上 /events 註冊為玩家,回合進行中就照設定頻率點擊。
可用來做 60 人負載測試,或在沒有觀眾時錄製展示備案影片。

範例:
  python3 scripts/loadtest.py --a https://tug-a.example.com --b https://tug-b.example.com --players 30
  python3 scripts/loadtest.py --a http://127.0.0.1:8100 --b http://127.0.0.1:8101 --players 10 --heist-ratio-a 0.5
"""
from __future__ import annotations

import argparse
import http.client
import json
import secrets
import ssl
import threading
import time
from urllib.parse import urlparse

STATE = {"A": {}, "B": {}}
STOP = threading.Event()
COUNTS = {"A": {"ok": 0, "fail": 0}, "B": {"ok": 0, "fail": 0}}
LOCK = threading.Lock()


def conn_for(url: str) -> tuple[http.client.HTTPConnection, str]:
    u = urlparse(url)
    if u.scheme == "https":
        c = http.client.HTTPSConnection(u.hostname, u.port or 443, timeout=10, context=ssl.create_default_context())
    else:
        c = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=10)
    return c, u.path.rstrip("/")


def sse_listener(url: str, team: str, pid: str, keep_state: bool) -> None:
    while not STOP.is_set():
        try:
            c, base = conn_for(url)
            c.request("GET", f"{base}/events?role=player&team={team}&pid={pid}")
            resp = c.getresponse()
            while not STOP.is_set():
                line = resp.fp.readline()
                if not line:
                    break
                if keep_state and line.startswith(b"data: "):
                    STATE[team] = json.loads(line[6:])
        except Exception:
            time.sleep(1)


def player(url: str, team: str, rate_scale: float, heist_ratio: float, lead: bool) -> None:
    pid = secrets.token_hex(12)
    threading.Thread(target=sse_listener, args=(url, team, pid, lead), daemon=True).start()
    c, base = conn_for(url)
    while not STOP.is_set():
        s = STATE.get(team) or {}
        if s.get("phase") != "running":
            time.sleep(0.2)
            continue
        game = s["game"]
        cl = s["client"]
        if game == "heist":
            h = s["heist"]
            if h["caught"] or h["escaped"]:
                time.sleep(0.5)
                continue
            per_sec = cl["heist_taps_per_sec"] * heist_ratio
            burst = 1
        else:
            per_sec = cl["tug_taps_per_sec"]
            burst = cl["tug_burst"]
        per_sec *= rate_scale
        started = time.monotonic()
        for _ in range(burst):
            try:
                c.request("POST", f"{base}/api/tap?game={game}", headers={"X-Player-Id": pid, "Content-Length": "0"})
                r = c.getresponse()
                r.read()
                with LOCK:
                    COUNTS[team]["ok" if r.status == 200 else "fail"] += 1
            except Exception:
                with LOCK:
                    COUNTS[team]["fail"] += 1
                c, base = conn_for(url)
        time.sleep(max(0.0, 1.0 / max(per_sec, 0.1) - (time.monotonic() - started)))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", required=True, help="A 隊伺服器網址")
    ap.add_argument("--b", required=True, help="B 隊伺服器網址")
    ap.add_argument("--players", type=int, default=30, help="每隊模擬人數")
    ap.add_argument("--players-a", type=int, default=None, help="A 隊人數(覆蓋 --players)")
    ap.add_argument("--players-b", type=int, default=None, help="B 隊人數(覆蓋 --players)")
    ap.add_argument("--rate-scale", type=float, default=0.9, help="點擊速度 = 上限 × 此倍率")
    ap.add_argument("--heist-ratio-a", type=float, default=1.0, help="偷鑽石時 A 隊的速度倍率(<1 代表小心)")
    ap.add_argument("--heist-ratio-b", type=float, default=0.5, help="偷鑽石時 B 隊的速度倍率")
    ap.add_argument("--minutes", type=float, default=10, help="模擬多久後自動結束")
    args = ap.parse_args()

    counts = {"A": args.players_a or args.players, "B": args.players_b or args.players}
    for team, url, ratio in (("A", args.a, args.heist_ratio_a), ("B", args.b, args.heist_ratio_b)):
        for i in range(counts[team]):
            threading.Thread(target=player, args=(url, team, args.rate_scale, ratio, i == 0), daemon=True).start()
            time.sleep(0.02)
    print(f"已啟動 A 隊 {counts['A']} 人、B 隊 {counts['B']} 人,請在管理頁開始回合。Ctrl+C 結束。")
    end = time.time() + args.minutes * 60
    try:
        while time.time() < end:
            time.sleep(2)
            a, b = STATE["A"], STATE["B"]
            if a and b:
                ha, hb = a["heist"], b["heist"]
                extra = (f" | 偷鑽石 A 門檻{ha['threshold_mbps']:.2f} 進度{ha['progress_bytes']/max(1,ha['goal_bytes']):.0%} 抓{int(ha['caught'])}"
                         f" B 門檻{hb['threshold_mbps']:.2f} 進度{hb['progress_bytes']/max(1,hb['goal_bytes']):.0%} 抓{int(hb['caught'])}") if a.get("game") == "heist" else ""
                print(f"[{a.get('game')}/{a.get('phase')}] "
                      f"A 玩家{a['players']} {a['live']['mbps']:.2f}Mbps {a['live']['pps']}pps 回合{a['round']['bytes']/1e6:.2f}MB/{a['round']['packets']}包 "
                      f"| B 玩家{b['players']} {b['live']['mbps']:.2f}Mbps {b['live']['pps']}pps 回合{b['round']['bytes']/1e6:.2f}MB/{b['round']['packets']}包 "
                      f"| 成功 A{COUNTS['A']['ok']} B{COUNTS['B']['ok']} 拒絕 A{COUNTS['A']['fail']} B{COUNTS['B']['fail']}{extra}",
                      flush=True)
    except KeyboardInterrupt:
        pass
    STOP.set()


if __name__ == "__main__":
    main()
