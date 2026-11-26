"""FastAPI-Backend: MQTT -> WebSocket, plus REST-Anreicherung."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import config
from feed import Feed
from rest import RisRest
from store import Store

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("server")

BASE_DIR = Path(__file__).resolve().parent
store = Store()
rest = RisRest()
clients: set[WebSocket] = set()


async def broadcaster() -> None:
    while True:
        await asyncio.sleep(config.WS_INTERVAL)
        if not clients:
            continue
        store.prune()
        payload = json.dumps(
            {
                "type": "snapshot",
                "ts": time.time(),
                "stats": store.stats(),
                "positions": store.snapshot(),
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
        dead = []
        for ws in list(clients):
            try:
                await asyncio.wait_for(ws.send_text(payload), timeout=3)
            except Exception:
                dead.append(ws)
        for ws in dead:
            clients.discard(ws)


@asynccontextmanager
async def lifespan(app: FastAPI):
    feed = Feed(store)
    feed.start()
    task = asyncio.create_task(broadcaster())
    # Linien-Cache im Hintergrund aufwaermen (17 Requests, einmalig).
    asyncio.create_task(run_in_threadpool(rest.line_catalog))
    asyncio.create_task(run_in_threadpool(rest.organizational_units))
    log.info("Server bereit - http://127.0.0.1:8000")
    yield
    feed.stop()
    task.cancel()


app = FastAPI(title="Zuglage", lifespan=lifespan)

# Das statische Frontend auf GitHub Pages spricht die API unter einer anderen
# Origin an. Alle Endpunkte sind oeffentliche, schreibgeschuetzte Daten.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.middleware("http")
async def revalidate_frontend(request, call_next):
    """HTML/JS/CSS immer revalidieren, damit Deploys nicht an Caches hängen."""
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith((".html", ".js", ".css")):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


@app.get("/api/health")
async def health():
    return {"ok": True, "stats": store.stats()}


@app.get("/api/positions")
async def positions():
    return {"stats": store.stats(), "positions": store.snapshot()}


@app.get("/api/trails")
async def trails():
    return {"trails": store.trails()}


@app.get("/api/regions")
async def regions():
    ou = await run_in_threadpool(rest.organizational_units)
    admin_to_region: dict[str, str] = {}
    for name, ids in ou.items():
        for admin in ids:
            admin_to_region.setdefault(admin, name)
    return {"regions": ou, "adminToRegion": admin_to_region}


@app.get("/api/catalog")
async def catalog():
    lines = await run_in_threadpool(rest.line_catalog)
    return {"lines": lines}


@app.get("/api/geometry/{journey_id}")
async def geometry(journey_id: str):
    try:
        return await run_in_threadpool(rest.journey_geometry, journey_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.websocket("/ws")
async def websocket(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    try:
        await ws.send_text(
            json.dumps(
                {
                    "type": "hello",
                    "stats": store.stats(),
                    "positions": store.snapshot(),
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        while True:
            await ws.receive_text()  # Client schickt nur Keepalives
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        clients.discard(ws)


@app.get("/")
async def index():
    return FileResponse(BASE_DIR / "web" / "index.html")


app.mount("/", StaticFiles(directory=BASE_DIR / "web", html=True), name="web")
