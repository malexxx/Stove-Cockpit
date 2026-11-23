"""
Sous-routeur SPA, PWA, Healthcheck, flux temps réel SSE (/api/events),
et endpoints tableau de bord (/api/latest, /api/dashboard, /api/poll-now).
"""
import asyncio
from datetime import datetime
import json
import logging
import os
import re
import time
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse

from analytics import enrich_telemetry_record
from clients import agua_client
from config import APP_VERSION, DOCKER_VERSION, FRONTEND_DIST_DIR, MODE_DB_PATHS, STATIC_DIR
from database import (
    get_active_mode,
    get_db,
    get_public_settings_dict,
    query_dashboard_series_range,
    read_registers_from_conn,
)
from services.installer_auth import _get_client_ip
from services.silence_service import get_silence_status
from services.storage_service import inspect_storage_persistence
from telemetry import collect_telemetry_cycle, get_comm_status, sse_subscribers

logger = logging.getLogger("nobis.dashboard")
router = APIRouter(tags=["Dashboard & SPA"])

MAX_SSE_SUBSCRIBERS = 32
MAX_SSE_PER_IP = 8
_sse_subscribers_by_ip: dict[str, set[asyncio.Queue]] = {}
_is_shutting_down = False
_INCLUDE_RE = re.compile(r"<!--\s*@include\s+([a-zA-Z0-9_./-]+)\s*-->")
_STATIC_VERSION_RE = re.compile(r'(/static/[a-zA-Z0-9_./-]+\.(?:css|js)\?v=)[^"\'\s>]+')
_SW_CACHE_RE = re.compile(r"(const\s+CACHE_NAME\s*=\s*['\"][^'\"]+)(['\"])")
_spa_html_cache: dict = {"sig": None, "html": ""}


def set_shutting_down(value: bool) -> None:
    """Positionne l'indicateur global d'arrêt serveur pour interrompre les boucles SSE."""
    global _is_shutting_down
    _is_shutting_down = value


def notify_sse_shutdown() -> None:
    """Notifie l'ensemble des clients SSE de l'arrêt imminent du serveur."""
    global _is_shutting_down
    _is_shutting_down = True
    msg = json.dumps({"event": "shutdown", "message": "Arrêt du serveur en cours..."})
    for q in list(sse_subscribers):
        try:
            q.put_nowait(msg)
        except Exception as exc:
            logger.debug("Queue SSE pleine lors de l'arrêt: %s", exc)


def render_spa_html() -> str:
    """Charge le build statique Vite (FRONTEND_DIST_DIR/index.html) ou un repli minimal."""
    for base_dir in (FRONTEND_DIST_DIR, STATIC_DIR):
        index_file = os.path.join(base_dir, "index.html")
        if os.path.isfile(index_file):
            with open(index_file, encoding="utf-8") as f:
                return f.read()
    return "<h1>Stove Cockpit Server API Active</h1>"


@router.get("/", response_class=HTMLResponse)
@router.head("/", response_class=HTMLResponse, include_in_schema=False)
async def serve_spa():
    """Sert l'interface utilisateur web monopage (SPA) assemblée à partir de index.html et ses partiels."""
    no_cache = {"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"}
    html = await asyncio.to_thread(render_spa_html)
    return HTMLResponse(content=html, headers=no_cache)


@router.get("/manifest.json", responses={200: {"content": {"application/manifest+json": {}}}})
@router.head("/manifest.json", include_in_schema=False)
async def serve_manifest():
    """Sert le fichier de configuration PWA manifest.json."""
    manifest_file = os.path.join(STATIC_DIR, "manifest.json")
    if await asyncio.to_thread(os.path.exists, manifest_file):
        return FileResponse(
            manifest_file,
            media_type="application/manifest+json",
            headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
        )
    raise HTTPException(status_code=404, detail="manifest.json introuvable")


def _read_sw_with_bust(sw_file: str, safe_bust: str) -> str:
    with open(sw_file, encoding="utf-8") as fh:
        raw_sw = fh.read()
    return _SW_CACHE_RE.sub(lambda m: f"{m.group(1)}-{safe_bust}{m.group(2)}", raw_sw, count=1)


@router.get("/sw.js", responses={200: {"content": {"application/javascript": {}}}})
@router.head("/sw.js", include_in_schema=False)
async def serve_service_worker():
    """Sert le script du Service Worker PWA sw.js (avec invalidation de cache post-MAJ interne)."""
    sw_file = os.path.join(STATIC_DIR, "sw.js")
    if await asyncio.to_thread(os.path.exists, sw_file):
        sw_headers = {
            "Service-Worker-Allowed": "/",
            "Cache-Control": "no-cache, no-store, must-revalidate",
        }
        asset_bust = os.environ.get("NOBIS_ASSET_BUST", "").strip()
        if asset_bust:
            safe_bust = re.sub(r"[^A-Za-z0-9._-]+", "-", asset_bust).strip("-")
            if safe_bust:
                patched = await asyncio.to_thread(_read_sw_with_bust, sw_file, safe_bust)
                return Response(content=patched, media_type="application/javascript", headers=sw_headers)
        return FileResponse(
            sw_file,
            media_type="application/javascript",
            headers=sw_headers,
        )
    raise HTTPException(status_code=404, detail="sw.js introuvable")


@router.get("/health")
async def healthcheck():
    """Point de contrôle de santé (healthcheck) pour Docker et les sondes de disponibilité."""
    mode = await asyncio.to_thread(get_active_mode)
    storage = await asyncio.to_thread(inspect_storage_persistence)
    return {
        "status": "healthy",
        "version": APP_VERSION,
        "docker_version": DOCKER_VERSION,
        "active_release_id": os.environ.get("NOBIS_ACTIVE_RELEASE_ID", "").strip(),
        "self_update_supported": os.environ.get("NOBIS_SUPERVISOR_ENABLED") == "1",
        "timestamp": datetime.now().isoformat(),
        "active_mode": mode,
        "active_db": os.path.basename(MODE_DB_PATHS.get(mode, MODE_DB_PATHS["simulation"])),
        "storage_status": storage["status"],
        "storage_persistent": storage["persistent"],
        "comm_status": get_comm_status(),
    }


async def _sse_event_stream(request: Request, queue: asyncio.Queue, client_ip: str):
    idle_ticks = 0
    try:
        active_mode = await asyncio.to_thread(get_active_mode)
        yield f"data: {json.dumps({'event': 'connected', 'active_mode': active_mode, 'docker_version': DOCKER_VERSION})}\n\n"
        while not _is_shutting_down:
            if await request.is_disconnected():
                break
            try:
                msg = await asyncio.wait_for(queue.get(), timeout=2.0)
                if msg is None or _is_shutting_down:
                    break
                idle_ticks = 0
                yield f"data: {msg}\n\n"
            except TimeoutError:
                idle_ticks += 1
                if idle_ticks >= 12:
                    idle_ticks = 0
                    yield ": keepalive\n\n"
    except (asyncio.CancelledError, GeneratorExit):
        pass
    finally:
        sse_subscribers.discard(queue)
        ip_set = _sse_subscribers_by_ip.get(client_ip)
        if ip_set is not None:
            ip_set.discard(queue)
            if not ip_set:
                _sse_subscribers_by_ip.pop(client_ip, None)


@router.get(
    "/api/events",
    responses={
        200: {"content": {"text/event-stream": {}}},
        429: {"description": "Trop de connexions SSE simultanées depuis cette IP"},
        503: {"description": "Trop de connexions SSE simultanées"},
    },
)
async def api_sse_events(request: Request):
    """Flux temps réel Server-Sent Events (SSE) poussant chaque mise à jour de télémétrie."""
    if len(sse_subscribers) >= MAX_SSE_SUBSCRIBERS:
        raise HTTPException(status_code=503, detail="Trop de connexions SSE simultanées.")
    client_ip = _get_client_ip(request)
    ip_queues = _sse_subscribers_by_ip.setdefault(client_ip, set())
    if len(ip_queues) >= MAX_SSE_PER_IP:
        raise HTTPException(status_code=429, detail="Trop de connexions SSE ouvertes depuis cette adresse IP.")

    queue: asyncio.Queue = asyncio.Queue(maxsize=10)
    sse_subscribers.add(queue)
    ip_queues.add(queue)

    return StreamingResponse(
        _sse_event_stream(request, queue, client_ip),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _load_latest_snapshot() -> dict:
    active_mode = get_active_mode()
    conn = get_db(active_mode)
    try:
        latest = conn.execute("SELECT * FROM telemetry ORDER BY epoch DESC LIMIT 1").fetchone()
        latest_dict = dict(latest) if latest else {}
        if latest_dict:
            enrich_telemetry_record(conn, latest_dict)
        registers = read_registers_from_conn(conn)
    finally:
        conn.close()

    stats = {
        "conso_week_kg": latest_dict.get("conso_week_kg", 0.0),
        "conso_month_kg": latest_dict.get("conso_month_kg", 0.0),
    }
    pub_settings = get_public_settings_dict()
    return {
        "version": APP_VERSION,
        "docker_version": DOCKER_VERSION,
        "active_mode": active_mode,
        "active_db_file": os.path.basename(MODE_DB_PATHS.get(active_mode, MODE_DB_PATHS["simulation"])),
        "stove_name": pub_settings.get("stove_name") or agua_client.stove_name or "Poêle Micronova",
        "capabilities": agua_client.get_capabilities(pub_settings),
        "latest": latest_dict,
        "comm_status": get_comm_status(),
        "settings": pub_settings,
        "registers": registers,
        "consumption_stats": stats,
        "pellet_quality": latest_dict.get("pellet_quality"),
        "exhaust_quality": latest_dict.get("exhaust_quality"),
        "silence_mode": get_silence_status(),
    }


@router.get("/api/latest")
async def api_latest():
    """Endpoint ultra-léger retournant uniquement le dernier point, les registres et les paramètres."""
    return await asyncio.to_thread(_load_latest_snapshot)


def _load_dashboard_snapshot(range_key: str) -> dict:
    active_mode = get_active_mode()
    conn = get_db(active_mode)
    try:
        rows = query_dashboard_series_range(conn, active_mode, range_key=range_key, order="ASC")
        latest_row = conn.execute("SELECT * FROM telemetry ORDER BY epoch DESC LIMIT 1").fetchone()
        latest_dict = dict(latest_row) if latest_row else {}
        if latest_dict:
            enrich_telemetry_record(conn, latest_dict)
        registers = read_registers_from_conn(conn)
    finally:
        conn.close()

    total_pts = len(rows)
    max_pts = 600
    if total_pts > max_pts:
        step = total_pts / max_pts
        sampled = [dict(rows[int(i * step)]) for i in range(max_pts)]
    else:
        sampled = [dict(r) for r in rows]

    if len(sampled) == 1:
        dup = dict(sampled[0])
        base_epoch = int(sampled[0].get("epoch") or int(time.time()))
        dup_epoch = base_epoch - 300
        dup["epoch"] = dup_epoch
        dup["timestamp"] = datetime.fromtimestamp(dup_epoch).strftime("%Y-%m-%d %H:%M:%S")
        sampled = [dup, sampled[0]]

    stats = {
        "conso_week_kg": latest_dict.get("conso_week_kg", 0.0),
        "conso_month_kg": latest_dict.get("conso_month_kg", 0.0),
    }
    pub_settings = get_public_settings_dict()
    return {
        "version": APP_VERSION,
        "docker_version": DOCKER_VERSION,
        "active_mode": active_mode,
        "active_db_file": os.path.basename(MODE_DB_PATHS.get(active_mode, MODE_DB_PATHS["simulation"])),
        "stove_name": pub_settings.get("stove_name") or agua_client.stove_name or "Poêle Micronova",
        "capabilities": agua_client.get_capabilities(pub_settings),
        "latest": latest_dict,
        "comm_status": get_comm_status(),
        "series": sampled,
        "settings": pub_settings,
        "registers": registers,
        "consumption_stats": stats,
        "pellet_quality": latest_dict.get("pellet_quality"),
        "exhaust_quality": latest_dict.get("exhaust_quality"),
        "silence_mode": get_silence_status(),
    }


@router.get("/api/dashboard")
async def api_dashboard(range_key: Annotated[str, Query()] = "24h"):
    """Fournit les séries temporelles échantillonnées (colonnes graphiques projetées) pour le tableau de bord."""
    return await asyncio.to_thread(_load_dashboard_snapshot, range_key)


@router.post("/api/poll-now")
async def api_poll_now():
    """Déclenche une interrogation manuelle immédiate du poêle."""
    record = await collect_telemetry_cycle()
    return {"status": "ok", "latest": record, "comm_status": get_comm_status()}
