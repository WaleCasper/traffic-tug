"""流量拔河 / 偷鑽石 伺服器(Starlette + uvicorn)。

同一份程式部署到兩台 VM,以 TEAM=A / TEAM=B 切換隊伍。
即時比分使用 Server-Sent Events(/events)推送,點擊使用一般 HTTP POST。
"""
from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import time
from pathlib import Path

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response, StreamingResponse, RedirectResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from .config import settings
from .game import GAMES, engine

STATIC = Path(__file__).resolve().parent / "static"
NO_CACHE = {"Cache-Control": "no-store, no-transform"}


# ---------- 工具 ----------
def _client_ip(request: Request) -> str | None:
    if settings.trust_cf_ip:
        ip = request.headers.get("cf-connecting-ip")
        if ip:
            return ip
    return request.client.host if request.client else None


def _check_token(request: Request, expected: str) -> bool:
    if not expected:
        return False
    auth = request.headers.get("authorization", "")
    token = (auth[7:] if auth.lower().startswith("bearer ") else "").strip()
    return hmac.compare_digest(token.encode(), expected.encode())


def _deny(expected: str = "x") -> JSONResponse:
    # 伺服器沒有設定密碼時回傳不同的錯誤,方便排查(不會透露密碼內容)
    error = "server_token_not_set" if not expected else "unauthorized"
    return JSONResponse({"ok": False, "error": error}, status_code=401)


def _page(name: str):
    async def handler(request: Request) -> Response:
        return FileResponse(STATIC / name, headers={"Cache-Control": "no-cache"})
    return handler


# ---------- 公開 API ----------
async def api_config(request: Request) -> Response:
    return JSONResponse({
        "team": settings.team,
        "public_urls": {"A": settings.public_url_a, "B": settings.public_url_b},
        "join_url": settings.effective_join_url,
    }, headers=NO_CACHE)


async def stats(request: Request) -> Response:
    return JSONResponse(engine.stats(), headers=NO_CACHE)


async def events(request: Request) -> Response:
    """SSE:每秒推送一次本隊狀態。role=player&team=X&pid=... 的連線會被算成玩家。"""
    role = request.query_params.get("role", "viewer")
    pid = request.query_params.get("pid", "")[:64]
    team = request.query_params.get("team", "").upper()
    is_player = role == "player" and team == settings.team and len(pid) >= 8
    with_series = role == "board"
    queue: asyncio.Queue = asyncio.Queue(maxsize=5)
    engine.listeners.add(queue)
    if is_player:
        engine.players[pid] = engine.players.get(pid, 0) + 1

    async def stream():
        try:
            yield "retry: 2000\n\n"
            yield f"data: {json.dumps(engine.snapshot(with_series))}\n\n"
            while True:
                try:
                    await asyncio.wait_for(queue.get(), timeout=15)
                    yield f"data: {json.dumps(engine.snapshot(with_series))}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                if await request.is_disconnected():
                    break
        finally:
            engine.listeners.discard(queue)
            if is_player:
                left = engine.players.get(pid, 1) - 1
                if left <= 0:
                    engine.players.pop(pid, None)
                else:
                    engine.players[pid] = left

    headers = {"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "Connection": "keep-alive"}
    return StreamingResponse(stream(), media_type="text/event-stream", headers=headers)


async def tap(request: Request) -> Response:
    game = request.query_params.get("game", "")
    pid = request.headers.get("x-player-id", "")[:64]
    body = await request.body()
    if game not in GAMES:
        return JSONResponse({"ok": False, "error": "bad_game"}, status_code=400)
    size = engine.tap_size(game)
    ok, reason = engine.tap_allowed(game, pid, _client_ip(request), size)
    if not ok:
        engine.app.rejected_requests += 1
        status = 429 if reason in ("too_fast", "server_busy", "bandwidth_cap", "ip_limit") else 409
        return JSONResponse({"ok": False, "error": reason}, status_code=status, headers=NO_CACHE)
    payload = engine.payload(size)
    engine.app.record(len(body), len(payload))
    return Response(payload, media_type="application/octet-stream", headers=NO_CACHE)


# ---------- 管理 API ----------
async def admin_action(request: Request) -> Response:
    if not _check_token(request, settings.admin_token):
        return _deny(settings.admin_token)
    action = request.path_params["action"]
    try:
        data = await request.json() if request.headers.get("content-length", "0") != "0" else {}
    except json.JSONDecodeError:
        data = {}
    try:
        if action == "select":
            engine.select(str(data.get("game", "")))
        elif action == "start":
            engine.start(float(data.get("countdown", 3)))
        elif action == "stop":
            engine.stop()
        elif action == "reveal":
            engine.reveal()
        elif action == "reset":
            engine.reset()
        elif action == "params":
            changed = engine.apply_params(data)
            return JSONResponse({"ok": True, "changed": changed, "params": engine.params.to_dict()})
        else:
            return JSONResponse({"ok": False, "error": "unknown_action"}, status_code=404)
    except ValueError as exc:
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)
    await broadcast()
    return JSONResponse({"ok": True, "state": engine.snapshot()})


async def admin_params(request: Request) -> Response:
    if not _check_token(request, settings.admin_token):
        return _deny(settings.admin_token)
    return JSONResponse({"ok": True, "params": engine.params.to_dict(), "team": settings.team})


async def alert(request: Request) -> Response:
    """Zabbix Action 呼叫:{"status": "PROBLEM" | "OK", "name": "觸發器名稱"}"""
    if not _check_token(request, settings.alert_token):
        return _deny(settings.alert_token)
    try:
        data = await request.json()
    except json.JSONDecodeError:
        data = {}
    status = str(data.get("status", "PROBLEM")).upper()
    if status in ("OK", "RESOLVED"):
        engine.zabbix_alert = None
    else:
        engine.zabbix_alert = {"name": str(data.get("name", "Zabbix 告警"))[:80], "at": time.time()}
    await broadcast()
    return JSONResponse({"ok": True})


async def health(request: Request) -> Response:
    return JSONResponse({"ok": True, "team": settings.team})


async def root(request: Request) -> Response:
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


# ---------- 背景工作 ----------
async def broadcast() -> None:
    for q in list(engine.listeners):
        if q.full():
            continue
        q.put_nowait(1)


async def ticker() -> None:
    while True:
        started = time.monotonic()
        try:
            engine.tick()
            await broadcast()
        except Exception as exc:  # 取樣失敗不應讓服務停止
            print("tick error:", exc, flush=True)
        await asyncio.sleep(max(0.05, 1.0 - (time.monotonic() - started)))


@contextlib.asynccontextmanager
async def lifespan(app):
    task = asyncio.create_task(ticker())
    print(f"[traffic-tug] TEAM={settings.team} PORT={settings.port} metric={engine.source} "
          f"iface={settings.iface} origins={settings.allowed_origins} "
          f"admin_token={'已設定(' + str(len(settings.admin_token)) + ' 字元)' if settings.admin_token else '未設定'}", flush=True)
    if not settings.admin_token:
        print("[traffic-tug] 警告:未設定 ADMIN_TOKEN,管理功能將全部拒絕", flush=True)
    yield
    task.cancel()


routes = [
    Route("/", root),
    Route("/play", _page("play.html")),
    Route("/board", _page("board.html")),
    Route("/admin", _page("admin.html")),
    Route("/healthz", health),
    Route("/stats", stats),
    Route("/events", events),
    Route("/api/config", api_config),
    Route("/api/tap", tap, methods=["POST"]),
    Route("/api/admin/params", admin_params, methods=["GET"]),
    Route("/api/admin/{action}", admin_action, methods=["POST"]),
    Route("/api/alert", alert, methods=["POST"]),
    Mount("/static", StaticFiles(directory=STATIC), name="static"),
]

middleware = [
    Middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Player-Id"],
        max_age=600,
    )
]

app = Starlette(routes=routes, middleware=middleware, lifespan=lifespan)
