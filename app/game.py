"""遊戲狀態、網卡流量取樣、限速。

比分以「網卡實際收送的 Bytes / Packets」計算:
每秒讀取 /sys/class/net/<IFACE>/statistics/ 的計數器,
這是作業系統量到的真實網路數據,與 Zabbix agent 讀的是同一張網卡。
METRIC_SOURCE=app 時改用應用層估算,只供沒有獨立網卡的本機測試使用。
"""
from __future__ import annotations

import asyncio
import math
import os
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

from .config import settings

GAMES = ("tug", "heist")
TCP_MSS = 1448          # 估算模式用:每個 TCP 封包可承載的資料量
HEADER_OVERHEAD = 320   # 估算模式用:HTTP 請求 + 回應標頭約略大小


class NicReader:
    def __init__(self, iface: str) -> None:
        self.base = Path("/sys/class/net") / iface / "statistics"

    @property
    def available(self) -> bool:
        return self.base.exists()

    def read(self) -> tuple[int, int, int, int]:
        def r(name: str) -> int:
            return int((self.base / name).read_text().strip())

        return r("rx_bytes"), r("tx_bytes"), r("rx_packets"), r("tx_packets")


@dataclass
class AppCounters:
    """應用層統計(提供 /stats,也是估算模式的資料來源)。"""

    total_requests: int = 0
    bytes_received: int = 0
    bytes_sent: int = 0
    est_packets: int = 0
    rejected_requests: int = 0

    def record(self, body_in: int, body_out: int) -> None:
        self.total_requests += 1
        self.bytes_received += body_in
        self.bytes_sent += body_out
        wire = body_in + body_out + HEADER_OVERHEAD
        # 請求 1 個、回應 ceil(n/MSS) 個、對應的 ACK 約一半
        data_pkts = 1 + max(1, math.ceil((body_out + 200) / TCP_MSS))
        self.est_packets += data_pkts + math.ceil(data_pkts / 2)
        self._wire_bytes = getattr(self, "_wire_bytes", 0) + wire

    @property
    def wire_bytes(self) -> int:
        return getattr(self, "_wire_bytes", 0)


@dataclass
class RoundState:
    game: str | None = None
    phase: str = "idle"           # idle / countdown / running / finished
    countdown_end: float = 0.0
    start_at: float = 0.0
    end_at: float = 0.0
    duration: int = 0
    bytes: int = 0
    packets: int = 0
    requests: int = 0
    series: list = field(default_factory=list)   # 每秒 [秒數, Mbps, pps]
    revealed: bool = False
    # 偷鑽石
    over_since: float | None = None
    caught: bool = False
    caught_at: float | None = None
    escaped: bool = False
    escaped_at: float | None = None
    peak_mbps: float = 0.0
    players_locked: int = 0          # 開始時鎖定的本隊人數
    groups: int = 1                  # 以幾級計算(每級 heist_group_size 人)
    baseline_samples: list = field(default_factory=list)
    baseline_mbps: float = 0.0       # 倒數期間量到的背景流量
    threshold_mbps: float = 0.0      # 本回合實際門檻 = 背景 + 每級額度 × 級數
    goal_bytes: int = 0              # 本回合終點
    progress_bytes: int = 0          # 扣掉背景流量後的前進量


class TokenBucket:
    __slots__ = ("rate", "capacity", "tokens", "updated")

    def __init__(self, rate: float, capacity: float) -> None:
        self.rate = rate
        self.capacity = capacity
        self.tokens = capacity
        self.updated = time.monotonic()

    def take(self, amount: float = 1.0) -> bool:
        now = time.monotonic()
        self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
        self.updated = now
        if self.tokens >= amount:
            self.tokens -= amount
            return True
        return False


class Engine:
    def __init__(self) -> None:
        self.params = settings.params
        self.nic = NicReader(settings.iface)
        self.source = "nic" if settings.metric_source == "nic" and self.nic.available else "app"
        self.app = AppCounters()
        self.round = RoundState()
        self.live_mbps = 0.0
        self.live_pps = 0.0
        self.recent_mbps: deque[float] = deque(maxlen=2)
        self.rps_window: deque[int] = deque(maxlen=5)
        self._last_counts: tuple[int, int] | None = None
        self._last_req = 0
        self.players: dict[str, int] = {}      # pid -> 連線數(只算本隊)
        self.listeners: set[asyncio.Queue] = set()
        self.player_buckets: dict[str, TokenBucket] = {}
        self.ip_buckets: dict[str, TokenBucket] = {}
        self.global_req = TokenBucket(self.params.max_rps, self.params.max_rps)
        self.global_bytes = TokenBucket(self.params.max_mbps * 125_000, self.params.max_mbps * 125_000)
        self.zabbix_alert: dict | None = None
        self._payload_cache: dict[int, bytes] = {}
        self.started = time.time()

    # ---------- 計數 ----------
    def _counts(self) -> tuple[int, int]:
        """回傳 (累計 bytes, 累計 packets)。"""
        if self.source == "nic":
            rxb, txb, rxp, txp = self.nic.read()
            return rxb + txb, rxp + txp
        return self.app.wire_bytes, self.app.est_packets

    def nic_raw(self) -> dict | None:
        if not self.nic.available:
            return None
        rxb, txb, rxp, txp = self.nic.read()
        return {"iface": settings.iface, "rx_bytes": rxb, "tx_bytes": txb, "rx_packets": rxp, "tx_packets": txp}

    def payload(self, size: int) -> bytes:
        size = max(0, min(size, 1_000_000))
        if size not in self._payload_cache:
            # 隨機資料無法被壓縮,實際傳輸量才會接近設定值
            self._payload_cache[size] = os.urandom(size)
        return self._payload_cache[size]

    # ---------- 回合控制 ----------
    def select(self, game: str) -> None:
        if game not in GAMES:
            raise ValueError("unknown game")
        self.round = RoundState(game=game)

    def start(self, countdown: float = 3.0) -> None:
        if not self.round.game:
            raise ValueError("請先選擇遊戲")
        game = self.round.game
        self.round = RoundState(game=game, phase="countdown")
        self.round.duration = self.params.tug_duration if game == "tug" else self.params.heist_duration
        self.round.countdown_end = time.time() + countdown
        if game == "heist":
            self._lock_heist_scale()
        self.player_buckets.clear()

    def _lock_heist_scale(self) -> None:
        """依本隊人數(每 heist_group_size 人一級)決定門檻與終點,整回合固定。"""
        r, p = self.round, self.params
        size = max(1, p.heist_group_size)
        r.players_locked = len(self.players)
        r.groups = max(1, math.ceil(r.players_locked / size))
        r.goal_bytes = int(p.heist_goal_per_group_mb * r.groups * 1_000_000)
        r.threshold_mbps = round(r.baseline_mbps + p.heist_allow_per_group_mbps * r.groups, 3)

    def stop(self) -> None:
        if self.round.phase in ("countdown", "running"):
            self.round.phase = "finished"
            self.round.end_at = time.time()

    def reveal(self) -> None:
        if self.round.game != "tug" or self.round.phase != "finished":
            raise ValueError("拔河回合結束後才能反轉")
        self.round.revealed = True

    def reset(self) -> None:
        self.round = RoundState(game=self.round.game)
        self.zabbix_alert = None

    def apply_params(self, data: dict) -> dict:
        changed = self.params.update(data)
        self.global_req = TokenBucket(self.params.max_rps, self.params.max_rps)
        rate = self.params.max_mbps * 125_000
        self.global_bytes = TokenBucket(rate, rate)
        self.player_buckets.clear()
        return changed

    # ---------- 點擊 ----------
    def tap_allowed(self, game: str, pid: str, ip: str | None, size: int) -> tuple[bool, str]:
        r = self.round
        if r.game != game or r.phase != "running":
            return False, "not_running"
        if game == "heist" and (r.caught or r.escaped):
            return False, "caught" if r.caught else "escaped"
        if pid not in self.players:
            return False, "unknown_player"
        p = self.params
        if game == "tug":
            per_sec = p.tug_taps_per_sec * (p.tug_b_burst if settings.team == "B" else 1)
        else:
            per_sec = p.heist_taps_per_sec
        bucket = self.player_buckets.get(pid)
        if bucket is None or abs(bucket.rate - per_sec * 1.3) > 1e-6:
            bucket = TokenBucket(per_sec * 1.3, max(2.0, per_sec * 1.3))
            self.player_buckets[pid] = bucket
        if not bucket.take():
            return False, "too_fast"
        if ip and settings.per_ip_max_rps > 0:
            ib = self.ip_buckets.setdefault(ip, TokenBucket(settings.per_ip_max_rps, settings.per_ip_max_rps))
            if not ib.take():
                return False, "ip_limit"
        if not self.global_req.take():
            return False, "server_busy"
        if not self.global_bytes.take(min(size, self.global_bytes.capacity)):
            return False, "bandwidth_cap"
        return True, "ok"

    def tap_size(self, game: str) -> int:
        p = self.params
        if game == "tug":
            return p.tug_a_bytes if settings.team == "A" else p.tug_b_bytes
        return p.heist_step_bytes

    # ---------- 每秒取樣 ----------
    def tick(self) -> None:
        now = time.time()
        r = self.round
        bytes_total, packets_total = self._counts()
        if self._last_counts is None:
            self._last_counts = (bytes_total, packets_total)
        d_bytes = max(0, bytes_total - self._last_counts[0])
        d_packets = max(0, packets_total - self._last_counts[1])
        self._last_counts = (bytes_total, packets_total)
        self.live_mbps = d_bytes * 8 / 1_000_000
        self.live_pps = float(d_packets)
        self.recent_mbps.append(self.live_mbps)
        self.rps_window.append(self.app.total_requests - self._last_req)
        self._last_req = self.app.total_requests

        if r.phase == "countdown" and r.game == "heist":
            r.baseline_samples.append(self.live_mbps)
        if r.phase == "countdown" and now >= r.countdown_end:
            if r.game == "heist":
                # 倒數期間玩家還不能點,量到的就是背景流量(即時畫面推送、監控等)
                samples = r.baseline_samples[1:] or r.baseline_samples or [0.0]
                r.baseline_mbps = round(sum(samples) / len(samples), 3)
                self._lock_heist_scale()
            r.phase = "running"
            r.start_at = r.countdown_end
            r.end_at = r.countdown_end + r.duration
        elif r.phase == "running":
            r.bytes += d_bytes
            r.packets += d_packets
            r.peak_mbps = max(r.peak_mbps, self.live_mbps)
            r.series.append([round(now - r.start_at), round(self.live_mbps, 3), int(self.live_pps)])
            if r.game == "heist":
                base_bytes = r.baseline_mbps * 125_000
                r.progress_bytes += int(max(0.0, d_bytes - base_bytes))
                self._heist_tick(now)
            if now >= r.end_at:
                r.phase = "finished"
                r.end_at = now

    def _heist_tick(self, now: float) -> None:
        r, p = self.round, self.params
        if r.caught or r.escaped:
            return
        noise = sum(self.recent_mbps) / max(1, len(self.recent_mbps))
        if noise > r.threshold_mbps:
            if r.over_since is None:
                r.over_since = now
            elif now - r.over_since >= p.heist_grace_sec - 0.05:
                r.caught = True
                r.caught_at = now
        else:
            r.over_since = None
        if not r.caught and r.progress_bytes >= r.goal_bytes:
            r.escaped = True
            r.escaped_at = now

    # ---------- 對外資料 ----------
    def snapshot(self, with_series: bool = False) -> dict:
        r, p, now = self.round, self.params, time.time()
        noise = sum(self.recent_mbps) / max(1, len(self.recent_mbps))
        data = {
            "team": settings.team,
            "server_time": now,
            "source": self.source,
            "game": r.game,
            "phase": r.phase,
            "countdown_left": max(0.0, round(r.countdown_end - now, 1)) if r.phase == "countdown" else 0,
            "time_left": max(0.0, round(r.end_at - now, 1)) if r.phase == "running" else 0,
            "duration": r.duration,
            "players": len(self.players),
            "live": {"mbps": round(self.live_mbps, 3), "pps": int(self.live_pps)},
            "round": {"bytes": r.bytes, "packets": r.packets, "peak_mbps": round(r.peak_mbps, 3)},
            "revealed": r.revealed,
            "heist": {
                "threshold_mbps": r.threshold_mbps or self._preview_threshold(),
                "goal_bytes": r.goal_bytes or self._preview_goal(),
                "progress_bytes": r.progress_bytes,
                "players_locked": r.players_locked,
                "groups": r.groups if r.players_locked else self._groups(len(self.players)),
                "group_size": p.heist_group_size,
                "baseline_mbps": r.baseline_mbps,
                "allow_per_group_mbps": p.heist_allow_per_group_mbps,
                "noise_mbps": round(noise, 3),
                "warning": r.over_since is not None,
                "caught": r.caught,
                "caught_at": r.caught_at,
                "escaped": r.escaped,
                "escaped_at": r.escaped_at,
            },
            "client": {
                "tug_taps_per_sec": p.tug_taps_per_sec,
                "tug_burst": p.tug_b_burst if settings.team == "B" else 1,
                "heist_taps_per_sec": p.heist_taps_per_sec,
            },
            "zabbix_alert": self.zabbix_alert,
        }
        if with_series:
            data["series"] = r.series[-120:]
        return data

    def _groups(self, n: int) -> int:
        return max(1, math.ceil(n / max(1, self.params.heist_group_size)))

    def _preview_threshold(self) -> float:
        """回合開始前的預估門檻(尚未量測背景流量)。"""
        return round(self.params.heist_allow_per_group_mbps * self._groups(len(self.players)), 3)

    def _preview_goal(self) -> int:
        return int(self.params.heist_goal_per_group_mb * self._groups(len(self.players)) * 1_000_000)

    def stats(self) -> dict:
        rps = sum(self.rps_window) / max(1, len(self.rps_window))
        r = self.round
        return {
            "team": settings.team,
            "game": r.game,
            "phase": r.phase,
            "round_active": r.phase == "running",
            "players": len(self.players),
            "total_requests": self.app.total_requests,
            "requests_per_second": round(rps, 1),
            "rejected_requests": self.app.rejected_requests,
            "application_bytes_received": self.app.bytes_received,
            "application_bytes_sent": self.app.bytes_sent,
            "metric_source": self.source,
            "live_mbps": round(self.live_mbps, 3),
            "live_pps": int(self.live_pps),
            "round_bytes": r.bytes,
            "round_packets": r.packets,
            "heist_noise_mbps": self.snapshot()["heist"]["noise_mbps"],
            "heist_threshold_mbps": r.threshold_mbps,
            "heist_baseline_mbps": r.baseline_mbps,
            "heist_groups": r.groups,
            "heist_progress_bytes": r.progress_bytes,
            "heist_caught": int(r.caught),
            "heist_escaped": int(r.escaped),
            "zabbix_alert": int(bool(self.zabbix_alert)),
            "nic": self.nic_raw(),
            "uptime_sec": int(time.time() - self.started),
        }


engine = Engine()
