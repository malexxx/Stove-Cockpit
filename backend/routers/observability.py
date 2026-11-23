"""Sous-routeur d'observabilité : journaux applicatifs/conteneur, audit commandes et exports CSV."""
import asyncio
from datetime import datetime
import json
import re
import time
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from config import TELEMETRY_COLUMNS
from database import (
    db_log,
    get_active_mode,
    get_container_logs,
    get_db,
    get_registers_dict,
    query_telemetry_range,
)
from schemas import ClientErrorPayload
from services.installer_auth import _get_client_ip

router = APIRouter(prefix="/api", tags=["Observability & Exports"])

_JSON_NUMERIC_KEY_RE = re.compile(r'"(\d+)"\s*:')
_CLIENT_ERROR_LIMIT_PER_MIN = 20
_client_error_timestamps: dict[str, list[float]] = {}


def _enforce_client_error_rate_limit(request: Request) -> None:
    """Limite les envois /api/logs/client-error par IP (20 / 60 s) pour éviter le remplissage SQLite."""
    client_ip = _get_client_ip(request)
    now_ts = time.time()
    for ip in list(_client_error_timestamps.keys()):
        recent = [t for t in _client_error_timestamps[ip] if now_ts - t < 60.0]
        if recent:
            _client_error_timestamps[ip] = recent
        else:
            _client_error_timestamps.pop(ip, None)

    bucket = _client_error_timestamps.get(client_ip, [])
    if len(bucket) >= _CLIENT_ERROR_LIMIT_PER_MIN:
        raise HTTPException(
            status_code=429,
            detail="Trop de rapports d'erreurs client depuis cette IP (limite 20/min).",
        )
    bucket.append(now_ts)
    _client_error_timestamps[client_ip] = bucket


def sanitize_csv_cell(val: Any) -> str:
    """Neutralise le risque d'injection de formules CSV (CWE-1236) tout en préservant les nombres natifs."""
    if val is None:
        return ""
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        return str(val)
    s = str(val)
    if s and s[0] in ("=", "+", "-", "@", "\t", "\r"):
        s = "'" + s
    return s.replace(";", ",").replace("\r", " ").replace("\n", " ")


def _format_csv_value(val: Any) -> str:
    if isinstance(val, float):
        return f"{val:.2f}".replace(".", ",")
    if val is None:
        return ""
    return sanitize_csv_cell(val)


def _query_audit_rows() -> list[dict[str, Any]]:
    conn = get_db(get_active_mode())
    try:
        rows = conn.execute("SELECT * FROM command_audit ORDER BY id DESC LIMIT 100").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def _query_logs_rows(severity: str, limit: int | None = 250) -> list[dict[str, Any]]:
    sev = (severity or "ALL").strip().upper()
    if sev in ("CONTAINER", "CONTENEUR", "DOCKER"):
        cap = 500 if limit is None else limit
        return [
            {
                "id": idx + 1,
                "timestamp": r.get("timestamp", ""),
                "severity": r.get("severity", "INFO"),
                "source": r.get("source", "CONTAINER"),
                "message": r.get("message", ""),
            }
            for idx, r in enumerate(get_container_logs(limit=cap))
        ] if limit is None else get_container_logs(limit=cap)

    conn = get_db(get_active_mode())
    limit_sql = f" LIMIT {int(limit)}" if limit is not None else ""
    try:
        if sev == "ALL":
            rows = conn.execute(f"SELECT id, timestamp, severity, source, message FROM app_logs ORDER BY id DESC{limit_sql}").fetchall()
        elif sev in ("WARNING", "WARN"):
            rows = conn.execute(
                f"SELECT id, timestamp, severity, source, message FROM app_logs WHERE severity IN ('WARNING', 'WARN') ORDER BY id DESC{limit_sql}"
            ).fetchall()
        else:
            rows = conn.execute(
                f"SELECT id, timestamp, severity, source, message FROM app_logs WHERE severity = ? ORDER BY id DESC{limit_sql}",
                (sev,),
            ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.get("/audit")
async def api_get_audit():
    """Retourne l'historique d'audit des commandes exécutées."""
    return await asyncio.to_thread(_query_audit_rows)


def _write_client_error_log(severity: str, source: str, message: str) -> None:
    db_log(severity, source, message, get_active_mode())


@router.get("/logs")
async def api_get_logs(severity: Annotated[str, Query()] = "ALL"):
    """Retourne les journaux applicatifs filtrés par sévérité (ou les logs conteneur en mémoire)."""
    return await asyncio.to_thread(_query_logs_rows, severity, 250)


@router.post("/logs/client-error", responses={429: {"description": "Trop de rapports d'erreurs client"}})
async def api_log_client_error(payload: ClientErrorPayload, request: Request):
    """Enregistre une anomalie JavaScript côté client dans les journaux système (avec rate-limit IP)."""
    _enforce_client_error_rate_limit(request)
    severity = payload.severity.strip().upper()
    source = payload.source.strip()[:25]
    message = payload.message[:500]
    await asyncio.to_thread(_write_client_error_log, severity, source, message)
    return {"status": "ok"}


@router.get("/export-logs-csv", responses={200: {"content": {"text/csv": {}}}})
async def api_export_logs_csv(severity: Annotated[str, Query()] = "ALL"):
    """Exporte les logs au format CSV."""
    active_mode = await asyncio.to_thread(get_active_mode)
    rows = await asyncio.to_thread(_query_logs_rows, severity, None)

    def _generate():
        yield "\ufeffid;timestamp;severity;source;message\r\n"
        for r in rows:
            msg = sanitize_csv_cell(r["message"])
            src = sanitize_csv_cell(r["source"])
            sev_clean = sanitize_csv_cell(r["severity"])
            yield f"{r['id']};{r['timestamp']};{sev_clean};{src};{msg}\r\n"

    clean_sev = "".join(c for c in str(severity).lower() if c in "abcdefghijklmnopqrstuvwxyz0123456789-_")[:32] or "all"
    clean_mode = "".join(c for c in str(active_mode).lower() if c in "abcdefghijklmnopqrstuvwxyz0123456789-_")[:32] or "simulation"
    filename = f"nobis_a10_logs_{clean_mode}_{clean_sev}_{datetime.now().strftime('%Y%m%d_%H%M')}.csv"
    return StreamingResponse(
        _generate(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _load_telemetry_export_rows(active_mode: str, range_key: str):
    conn = get_db(active_mode)
    try:
        rows = query_telemetry_range(conn, active_mode, range_key=range_key, order="DESC")
    finally:
        conn.close()
    offsets_set = set()
    for r in rows:
        raw_txt = r["raw_buffer_json"] or ""
        if raw_txt and raw_txt != "{}":
            for m in _JSON_NUMERIC_KEY_RE.finditer(raw_txt):
                offsets_set.add(int(m.group(1)))
    return rows, sorted(offsets_set)


def _build_telemetry_csv_row(
    row_dict: dict[str, Any],
    base_cols: list[str],
    reg_keys: list[str],
    regs_catalog: dict[str, Any],
    sorted_offsets: list[int],
) -> str:
    try:
        buf = json.loads(row_dict.get("raw_buffer_json") or "{}")
    except Exception:
        buf = {}
    vals: list[str] = [_format_csv_value(row_dict.get(c)) for c in base_cols]
    for rk in reg_keys:
        meta = regs_catalog[rk]
        off_str = str(meta["offset"])
        if off_str in buf:
            rv = buf[off_str]
        elif rk in row_dict and row_dict[rk] is not None and rk != "status_code":
            rv = row_dict[rk]
        else:
            rv = meta["current_val"]
        vals.append(_format_csv_value(rv))
    vals.extend(_format_csv_value(buf.get(str(off), "")) for off in sorted_offsets)
    return ";".join(vals) + "\r\n"


@router.get("/export-csv", responses={200: {"content": {"text/csv": {}}}})
async def api_export_csv(range_key: Annotated[str, Query()] = "24h"):
    """Exporte les enregistrements de télémétrie et registres décodés au format CSV (décodage à la volée)."""
    active_mode = await asyncio.to_thread(get_active_mode)
    rows, sorted_offsets = await asyncio.to_thread(_load_telemetry_export_rows, active_mode, range_key)
    regs_catalog = await asyncio.to_thread(get_registers_dict, active_mode)
    reg_keys = list(regs_catalog.keys())

    base_cols = [c for c in TELEMETRY_COLUMNS.keys() if c != "raw_buffer_json"]
    header_cols = base_cols + [f"REG_{rk}" for rk in reg_keys] + [f"OFFSET_{off}" for off in sorted_offsets]

    def _generate():
        yield "\ufeff" + ";".join(header_cols) + "\r\n"
        for r in rows:
            yield _build_telemetry_csv_row(dict(r), base_cols, reg_keys, regs_catalog, sorted_offsets)

    clean_range = "".join(c for c in str(range_key).lower() if c in "abcdefghijklmnopqrstuvwxyz0123456789-_")[:32] or "24h"
    clean_mode = "".join(c for c in str(active_mode).lower() if c in "abcdefghijklmnopqrstuvwxyz0123456789-_")[:32] or "simulation"
    filename = f"nobis_a10_supervision_et_registres_{clean_mode}_{clean_range}_{datetime.now().strftime('%Y%m%d_%H%M')}.csv"
    return StreamingResponse(
        _generate(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
