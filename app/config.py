"""讀取 .env 與環境變數,集中管理所有可調參數。"""
from __future__ import annotations

import os
from dataclasses import dataclass, field, asdict
from pathlib import Path


def _clean(value: str) -> str:
    """去掉行尾註解(空白後的 #)、前後空白與引號。
    systemd 的 EnvironmentFile 不會處理行尾註解,這裡補上,避免密碼被附上註解文字。"""
    if " #" in value or "\t#" in value:
        value = value.split("#", 1)[0]
    return value.strip().strip('"').strip("'").strip()


def _load_dotenv(path: Path) -> None:
    """簡易 .env 讀取:KEY=VALUE,# 開頭為註解。已存在的環境變數優先。"""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = _clean(value)
        os.environ.setdefault(key, value)


_load_dotenv(Path(os.environ.get("ENV_FILE", Path(__file__).resolve().parent.parent / ".env")))


def _s(name: str, default: str) -> str:
    return _clean(os.environ.get(name, default))


def _i(name: str, default: int) -> int:
    try:
        return int(_clean(str(os.environ.get(name, default))))
    except ValueError:
        return default


def _f(name: str, default: float) -> float:
    try:
        return float(_clean(str(os.environ.get(name, default))))
    except ValueError:
        return default


@dataclass
class GameParams:
    """管理頁可以即時調整的遊戲參數(重啟服務後會回到 .env 的值)。"""

    # 拔河
    tug_duration: int = _i("TUG_DURATION", 30)            # 回合秒數
    tug_a_bytes: int = _i("TUG_A_BYTES", 6144)            # A 隊每次點擊的回應大小(大包)
    tug_b_bytes: int = _i("TUG_B_BYTES", 16)              # B 隊每個請求的回應大小(小包)
    tug_b_burst: int = _i("TUG_B_BURST", 4)               # B 隊每次點擊連發幾個請求
    tug_taps_per_sec: float = _f("TUG_TAPS_PER_SEC", 2)   # 每位玩家每秒最多點擊次數
    # 偷鑽石
    heist_duration: int = _i("HEIST_DURATION", 45)
    heist_step_bytes: int = _i("HEIST_STEP_BYTES", 4096)  # 每次點擊的回應大小
    heist_taps_per_sec: float = _f("HEIST_TAPS_PER_SEC", 3)
    heist_group_size: int = _i("HEIST_GROUP_SIZE", 5)               # 幾人為一級
    heist_allow_per_group_mbps: float = _f("HEIST_ALLOW_PER_GROUP_MBPS", 0.3)  # 每一級允許的額外流量
    heist_goal_per_group_mb: float = _f("HEIST_GOAL_PER_GROUP_MB", 1.2)        # 每一級的終點距離(MB)
    heist_grace_sec: float = _f("HEIST_GRACE_SEC", 2)     # 連續超過門檻幾秒才觸發
    # 全域保護(每台 VM)
    max_rps: int = _i("MAX_RPS", 300)                     # 每秒最多處理的點擊請求數
    max_mbps: float = _f("MAX_MBPS", 4.5)                 # 每秒最多送出的應用層資料量

    def to_dict(self) -> dict:
        return asdict(self)

    def update(self, data: dict) -> dict:
        changed = {}
        for key, value in data.items():
            if not hasattr(self, key):
                continue
            current = getattr(self, key)
            try:
                new = type(current)(value)
            except (TypeError, ValueError):
                continue
            if isinstance(new, (int, float)) and new < 0:
                continue
            setattr(self, key, new)
            changed[key] = new
        return changed


@dataclass
class Settings:
    team: str = _s("TEAM", "A").upper()
    host: str = _s("HOST", "0.0.0.0")
    port: int = _i("PORT", 8100)
    iface: str = _s("IFACE", "ens33")
    metric_source: str = _s("METRIC_SOURCE", "nic")   # nic:讀網卡計數器;app:應用層估算(本機測試用)
    public_url_a: str = _s("PUBLIC_URL_A", "http://127.0.0.1:8100").rstrip("/")
    public_url_b: str = _s("PUBLIC_URL_B", "http://127.0.0.1:8101").rstrip("/")
    join_url: str = _s("JOIN_URL", "").rstrip("/")
    extra_origins: list[str] = field(
        default_factory=lambda: [o.strip().rstrip("/") for o in _s("EXTRA_ORIGINS", "").split(",") if o.strip()]
    )
    admin_token: str = _s("ADMIN_TOKEN", "")
    alert_token: str = _s("ALERT_TOKEN", "")
    trust_cf_ip: bool = _s("TRUST_CF_CONNECTING_IP", "true").lower() == "true"
    per_ip_max_rps: int = _i("PER_IP_MAX_RPS", 0)    # 0 = 不限制(同校網路常共用 IP)
    params: GameParams = field(default_factory=GameParams)

    @property
    def allowed_origins(self) -> list[str]:
        return sorted({self.public_url_a, self.public_url_b, *self.extra_origins})

    @property
    def effective_join_url(self) -> str:
        return self.join_url or self.public_url_a


settings = Settings()
if settings.team not in ("A", "B"):
    raise SystemExit("TEAM 必須是 A 或 B")
