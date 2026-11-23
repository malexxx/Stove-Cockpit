"""Sous-routeur pour la gestion des snapshots de registres (CRUD, restauration et export CSV)."""
import asyncio
from datetime import datetime
import json
from typing import Annotated, Any

from fastapi import APIRouter, Body, HTTPException, Path, Request
from fastapi.responses import StreamingResponse

from database import db_log, get_active_mode, get_db, get_registers_dict
from routers.observability import sanitize_csv_cell
from schemas import SnapshotCreatePayload
from services.installer_auth import require_installer_auth_if_configured
from telemetry import collect_telemetry_cycle, execute_registers_batch_write

router = APIRouter(prefix="/api", tags=["Snapshots"])
_SNAPSHOT_DEFAULT = SnapshotCreatePayload()
_SnapIdPath = Annotated[int, Path(ge=1, le=9223372036854775807)]


def _fetch_snapshots_list() -> list[dict[str, Any]]:
    active_mode = get_active_mode()
    conn = get_db(active_mode)
    try:
        rows = conn.execute(
            "SELECT id, timestamp, name, comm_mode, registers_json, raw_buffer_json FROM registers_snapshots ORDER BY id DESC LIMIT 100"
        ).fetchall()
    finally:
        conn.close()
    result = []
    for r in rows:
        regs_d = json.loads(r["registers_json"] or "{}")
        raw_d = json.loads(r["raw_buffer_json"] or "{}")
        result.append({
            "id": r["id"],
            "timestamp": r["timestamp"],
            "name": r["name"],
            "comm_mode": r["comm_mode"],
            "registers_count": len(regs_d),
            "raw_offsets_count": len(raw_d),
            "registers": regs_d,
            "raw_buffer": raw_d,
        })
    return result


@router.get("/snapshots")
async def api_list_snapshots():
    """Liste tous les snapshots de registres enregistrés."""
    return await asyncio.to_thread(_fetch_snapshots_list)


@router.post("/snapshots")
async def api_create_snapshot(request: Request, payload: Annotated[SnapshotCreatePayload, Body()] = _SNAPSHOT_DEFAULT):
    """Crée un snapshot instantané de tous les registres et du buffer brut."""
    require_installer_auth_if_configured(request)
    active_mode = get_active_mode()
    if payload.refresh_live:
        await collect_telemetry_cycle(active_mode)
    regs = get_registers_dict(active_mode)
    conn = get_db(active_mode)
    try:
        last_row = conn.execute("SELECT raw_buffer_json FROM telemetry ORDER BY epoch DESC LIMIT 1").fetchone()
        raw_json_str = last_row["raw_buffer_json"] if (last_row and last_row["raw_buffer_json"]) else "{}"

        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        snap_name = (payload.name or "").strip() or f"Snapshot {now_str}"
        regs_snapshot = {
            k: {"offset": v["offset"], "label": v["label"], "category": v["category"], "unit": v["unit"], "value": v["current_val"]}
            for k, v in regs.items()
        }
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO registers_snapshots (timestamp, name, comm_mode, registers_json, raw_buffer_json) VALUES (?, ?, ?, ?, ?)",
            (now_str, snap_name, active_mode, json.dumps(regs_snapshot), raw_json_str),
        )
        snap_id = cur.lastrowid
        conn.commit()
    finally:
        conn.close()
    db_log("INFO", "SNAPSHOT", f"Snapshot #{snap_id} créé : '{snap_name}'.", active_mode)
    return {"status": "ok", "id": snap_id, "name": snap_name, "timestamp": now_str}


@router.post("/snapshots/{snap_id}/restore", responses={404: {"description": "Snapshot introuvable"}})
async def api_restore_snapshot(request: Request, snap_id: _SnapIdPath):
    """Restaure les valeurs de registres depuis un snapshot sauvegardé."""
    require_installer_auth_if_configured(request)
    active_mode = get_active_mode()
    conn = get_db(active_mode)
    try:
        row = conn.execute("SELECT * FROM registers_snapshots WHERE id = ?", (snap_id,)).fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Snapshot introuvable")
    snap_regs = json.loads(row["registers_json"] or "{}")
    current_regs = get_registers_dict(active_mode)
    batch_cmds: list[dict[str, Any]] = []
    for rk, meta in snap_regs.items():
        if rk == "status_code":
            continue
        target_val = float(meta.get("value", 0))
        cur_val = float(current_regs.get(rk, {}).get("current_val", target_val))
        if abs(target_val - cur_val) > 1e-4:
            batch_cmds.append({"reg_key": rk, "value": target_val, "offset": int(meta.get("offset", 0))})
    if batch_cmds:
        await execute_registers_batch_write(batch_cmds, skip_poll=True)
    latest = await collect_telemetry_cycle(active_mode)
    return {"status": "ok", "restored_registers": len(batch_cmds), "latest": latest}


@router.delete("/snapshots/{snap_id}", responses={404: {"description": "Snapshot introuvable"}})
async def api_delete_snapshot(request: Request, snap_id: _SnapIdPath):
    """Supprime un snapshot."""
    require_installer_auth_if_configured(request)
    active_mode = get_active_mode()
    conn = get_db(active_mode)
    try:
        cur = conn.execute("DELETE FROM registers_snapshots WHERE id = ?", (snap_id,))
        deleted = cur.rowcount
        conn.commit()
    finally:
        conn.close()
    if deleted == 0:
        raise HTTPException(status_code=404, detail="Snapshot introuvable")
    return {"status": "ok"}


def _load_snapshot_row(snap_id: int):
    active_mode = get_active_mode()
    conn = get_db(active_mode)
    try:
        row = conn.execute("SELECT * FROM registers_snapshots WHERE id = ?", (snap_id,)).fetchone()
        return active_mode, (dict(row) if row else None)
    finally:
        conn.close()


@router.get("/snapshots/{snap_id}/export-csv", responses={200: {"content": {"text/csv": {}}}, 404: {"description": "Snapshot introuvable"}})
async def api_export_snapshot_csv(snap_id: _SnapIdPath):
    """Exporte un snapshot au format CSV."""
    active_mode, row = await asyncio.to_thread(_load_snapshot_row, snap_id)
    if not row:
        raise HTTPException(status_code=404, detail="Snapshot introuvable")

    snap_regs = json.loads(row["registers_json"] or "{}")
    raw_buf = json.loads(row["raw_buffer_json"] or "{}")

    def _generate():
        yield "\ufefftype_donnee;cle_registre;offset;categorie;description;valeur;unite\r\n"
        for rk, m in snap_regs.items():
            val_str = f"{float(m.get('value', 0)):.2f}".replace(".", ",")
            desc = sanitize_csv_cell(m.get("label", ""))
            yield f"CATALOG_REGISTER;{sanitize_csv_cell(rk)};{m.get('offset')};{sanitize_csv_cell(m.get('category'))};{desc};{val_str};{sanitize_csv_cell(m.get('unit', ''))}\r\n"
        numeric_items = [(k, v) for k, v in raw_buf.items() if str(k).isdigit()]
        for off_k, off_v in sorted(numeric_items, key=lambda x: int(x[0])):
            val_str = f"{float(off_v):.2f}".replace(".", ",")
            yield f"RAW_BUFFER_OFFSET;OFFSET_{off_k};{off_k};RAW_BUFFER;Offset mémoire brut #{off_k};{val_str};raw\r\n"

    clean_mode_snap = "".join(c for c in str(active_mode).lower() if c in "abcdefghijklmnopqrstuvwxyz0123456789-_")[:32] or "simulation"
    filename = f"snapshot_{snap_id}_{clean_mode_snap}_{datetime.now().strftime('%Y%m%d_%H%M')}.csv"
    return StreamingResponse(
        _generate(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
