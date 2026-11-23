"""Verrou I/O bus poêle, état de communication dissocié et diffusion Server-Sent Events (SSE)."""
import asyncio
import json
from typing import Any

from database import get_active_mode, get_db

_stove_io_lock = asyncio.Lock()
sse_subscribers: set[asyncio.Queue] = set()

# État de communication avec le Cloud Nobis / Passerelle physique (dissocié de l'état du conteneur)
_comm_status: dict[str, Any] = {
    "connected": True,
    "last_sync_time": None,
    "last_sync_epoch": None,
    "last_error": None,
    "comm_mode": "agua_cloud",
}


def get_comm_status() -> dict[str, Any]:
    """Retourne l'état de communication instantané du conteneur avec le Cloud Nobis ou la passerelle."""
    mode = get_active_mode()
    if _comm_status.get("last_sync_time") is None:
        try:
            conn = get_db(mode)
            try:
                row = conn.execute(
                    "SELECT epoch, timestamp, status_code, comm_mode FROM telemetry ORDER BY epoch DESC LIMIT 1"
                ).fetchone()
                if row:
                    r_dict = dict(row)
                    st = int(r_dict.get("status_code", 0))
                    _comm_status["connected"] = st != -1
                    _comm_status["last_sync_time"] = r_dict.get("timestamp")
                    _comm_status["last_sync_epoch"] = r_dict.get("epoch")
                    _comm_status["comm_mode"] = r_dict.get("comm_mode") or mode
                    if st == -1:
                        _comm_status["last_error"] = "Poêle hors ligne (perte de liaison)"
                else:
                    _comm_status["comm_mode"] = mode
                    _comm_status["connected"] = mode == "simulation"
            finally:
                conn.close()
        except Exception:
            _comm_status["comm_mode"] = mode
    return dict(_comm_status)


async def broadcast_sse_event(event_type: str, payload: dict[str, Any]) -> None:
    """Diffuse un événement formaté en Server-Sent Events (SSE) à tous les abonnés connectés."""
    if not sse_subscribers:
        return
    dead_queues: list[asyncio.Queue] = []
    msg = json.dumps({"event": event_type, **payload})
    for q in list(sse_subscribers):
        try:
            if q.full():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(msg)
        except Exception:
            dead_queues.append(q)
    for dq in dead_queues:
        sse_subscribers.discard(dq)
