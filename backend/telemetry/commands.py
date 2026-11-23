"""Exécution transactionnelle d'écritures unitaires/batch sur registres et RAZ lot de granulés."""
import asyncio
from datetime import datetime
import time
from typing import Any

from fastapi import HTTPException

from analytics import BATCH_MIN_EVAL_MINUTES, save_pellet_batch_state
from clients import agua_client, local_gateway_client
from database import db_log, get_active_mode, get_db, get_registers_dict, get_settings_dict
from telemetry.collector import (
    _dispatch_post_telemetry_effects,
    _read_and_store_telemetry_unlocked,
    collect_telemetry_cycle,
)
from telemetry.hub import _stove_io_lock


def _normalize_batch_commands(
    commands: list[dict[str, Any]],
    regs: dict[str, Any],
    comm_mode: str,
) -> tuple[list[dict[str, Any]], list[tuple[int, float, str | None]]]:
    """Valide les bornes min/max et construit les listes normalisées d'écriture locale et Cloud."""
    normalized_cmds: list[dict[str, Any]] = []
    cloud_items_spec: list[tuple[int, float, str | None]] = []

    for cmd in commands:
        rk = str(cmd.get("reg_key") or "").strip()
        if not rk:
            raise HTTPException(status_code=400, detail="Paramètre reg_key requis pour chaque commande")
        try:
            val = float(cmd.get("value", 0))
        except (ValueError, TypeError) as exc:
            raise HTTPException(status_code=400, detail=f"Valeur numérique invalide pour {rk}") from exc

        custom_offset = cmd.get("offset")
        if rk == "status_code" and val in (6, 9):
            val = 85.0 if val == 6 else 170.0

        if rk in regs:
            meta = regs[rk]
            offset = int(meta["offset"])
            label = meta["label"]
            old_val = float(meta["current_val"])
            if val < meta["min_val"] or val > meta["max_val"]:
                raise HTTPException(
                    status_code=400,
                    detail=f"Valeur hors limites pour {rk} [{meta['min_val']} .. {meta['max_val']}]",
                )
        else:
            try:
                offset = int(custom_offset or 0)
            except (ValueError, TypeError) as exc:
                raise HTTPException(status_code=400, detail="Offset invalide") from exc
            label = f"Offset Brut #{offset}"
            old_val = 0.0

        is_trim = offset in (70, 71) or rk in ("trim_pellet_pct", "trim_exhaust_pct")
        is_standby = offset == 33130 or rk == "standby_set"
        normalized_cmds.append({
            "reg_key": rk,
            "offset": offset,
            "label": label,
            "old_val": old_val,
            "new_val": val,
            "in_catalog": rk in regs,
            "is_trim": is_trim,
            "is_standby": is_standby,
        })
        if not (comm_mode == "agua_cloud" and (is_trim or is_standby)):
            cloud_items_spec.append((offset, val, rk))

    return normalized_cmds, cloud_items_spec


async def _dispatch_batch_to_transport(
    comm_mode: str,
    settings: dict[str, str],
    normalized_cmds: list[dict[str, Any]],
    cloud_items_spec: list[tuple[int, float, str | None]],
) -> str:
    """Transmet la transaction d'écriture vers Agua Cloud ou la passerelle UART selon le mode actif."""
    if comm_mode == "agua_cloud":
        if not cloud_items_spec:
            return "Mémorisé localement (à valider sur radiocommande: MENU ▸ PROG. UTILISATEUR ▸ MÉLANGE G/A ou COMFORT CLIMA)"
        if not settings.get("agua_email") or not settings.get("agua_password"):
            db_log(
                "WARNING",
                "WRITE_CMD",
                f"Identifiants Agua IOT absents : écriture locale appliquée ({len(normalized_cmds)} reg.).",
                comm_mode,
            )
            return "Appliqué en base locale (identifiants Cloud absents)"
        try:
            w_res = await agua_client.write_registers_batch(settings, cloud_items_spec)
            return f"Écriture Agua IOT via {w_res.get('endpoint', '/deviceRequestWriting')}"
        except Exception as e:
            first = normalized_cmds[0]
            db_log(
                "ERROR",
                "WRITE_CMD",
                f"Échec écriture Cloud {first['label']} (#{first['offset']}) : {str(e)}",
                comm_mode,
            )
            raise HTTPException(status_code=502, detail=f"Erreur Cloud Agua IOT : {str(e)}") from e

    if comm_mode == "local_gateway" and cloud_items_spec:
        gw_url = settings.get("local_gateway_url", "http://192.168.1.150")
        try:
            await local_gateway_client.write_registers(gw_url, normalized_cmds)
        except Exception as e:
            db_log("ERROR", "WRITE_CMD", f"Échec écriture UART : {str(e)}", comm_mode)
            raise HTTPException(status_code=502, detail=f"Erreur passerelle UART : {str(e)}") from e

    return f"Écriture {comm_mode}"


def _persist_and_log_batch(
    comm_mode: str,
    normalized_cmds: list[dict[str, Any]],
    details_str: str,
) -> None:
    """Met à jour registers_catalog, journalise command_audit et écrit les logs métier."""
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = get_db(comm_mode)
    try:
        for c in normalized_cmds:
            if c["in_catalog"]:
                conn.execute(
                    "UPDATE registers_catalog SET current_val = ?, updated_at = ? WHERE reg_key = ?",
                    (c["new_val"], now_str, c["reg_key"]),
                )
            c_details = details_str
            if comm_mode == "agua_cloud" and c.get("is_trim"):
                c_details = "Mémorisé localement (à valider sur radiocommande: MENU ▸ PROG. UTILISATEUR ▸ MÉLANGE G/A)"
            elif comm_mode == "agua_cloud" and c.get("is_standby"):
                c_details = "Mémorisé localement (à régler sur radiocommande: MENU ▸ UTILISATEUR ▸ COMFORT CLIMA)"
            conn.execute(
                """
                INSERT INTO command_audit (timestamp, reg_key, offset, label, old_value, new_value, comm_mode, status, details)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (now_str, c["reg_key"], c["offset"], c["label"], c["old_val"], c["new_val"], comm_mode, "SUCCESS", c_details),
            )
        conn.commit()
    finally:
        conn.close()

    for c in normalized_cmds:
        if comm_mode == "agua_cloud" and c.get("is_trim"):
            db_log(
                "COMMAND",
                "PILOTAGE",
                f"{c['label']} [Offset {c['offset']}] : mémorisé à {c['new_val']:+g}%. Validez sur votre radiocommande physique (MENU ▸ PROGRAMMATION UTILISATEUR ▸ MÉLANGE G/A) car les offsets 70/71 ne figurent pas dans la table Cloud Agua IOT.",
                comm_mode,
            )
        elif comm_mode == "agua_cloud" and c.get("is_standby"):
            db_log(
                "COMMAND",
                "PILOTAGE",
                f"{c['label']} [Offset {c['offset']}] : consigne mémorisée à {c['new_val']}. La fonction Comfort Clima est régie en local par la radiocommande Nobis (MENU ▸ UTILISATEUR ▸ COMFORT CLIMA) et n'est pas modifiable à distance via l'API Cloud Agua IOT.",
                comm_mode,
            )
        else:
            db_log("COMMAND", "PILOTAGE", f"{c['label']} [Offset {c['offset']}] : {c['old_val']} -> {c['new_val']} ({details_str})", comm_mode)


async def execute_registers_batch_write(
    commands: list[dict[str, Any]],
    skip_poll: bool = True,
) -> dict[str, Any]:
    """
    Exécute une transaction groupée (batch) d'écritures de registres :
    - Validation des bornes min/max.
    - Dispatch vers le client approprié (Agua Cloud RWMSmaster, Passerelle locale UART ou Simulation).
    - Traçabilité dans command_audit.
    """
    if not commands:
        raise HTTPException(status_code=400, detail="Liste de commandes vide")

    try:
        await asyncio.wait_for(_stove_io_lock.acquire(), timeout=5.0)
    except TimeoutError as exc:
        raise HTTPException(
            status_code=503,
            detail="Le bus de communication poêle est actuellement occupé. Veuillez réessayer.",
        ) from exc
    post_dispatch: tuple[str, dict[str, str], dict[str, Any], dict[int, float]] | None = None
    try:
        settings = get_settings_dict()
        comm_mode = get_active_mode()
        regs = get_registers_dict(comm_mode)

        normalized_cmds, cloud_items_spec = _normalize_batch_commands(commands, regs, comm_mode)
        details_str = await _dispatch_batch_to_transport(comm_mode, settings, normalized_cmds, cloud_items_spec)
        _persist_and_log_batch(comm_mode, normalized_cmds, details_str)

        latest: dict[str, Any] = {}
        if not skip_poll:
            post_dispatch = await _read_and_store_telemetry_unlocked(force_mode=comm_mode)
            latest = post_dispatch[2]

        first = normalized_cmds[0]
        result = {
            "status": "ok",
            "count": len(normalized_cmds),
            "reg_key": first["reg_key"],
            "old_value": first["old_val"],
            "new_value": first["new_val"],
            "latest": latest,
        }
    finally:
        _stove_io_lock.release()

    if post_dispatch is not None:
        await _dispatch_post_telemetry_effects(*post_dispatch)
    return result


async def execute_register_write(
    reg_key: str,
    new_value: float,
    custom_offset: int | None = None,
    skip_poll: bool = True,
) -> dict[str, Any]:
    """Écriture unitaire d'un registre en déléguant à la transaction batch unifiée."""
    return await execute_registers_batch_write(
        [{"reg_key": reg_key, "value": new_value, "offset": custom_offset}],
        skip_poll=skip_poll,
    )


async def reset_pellet_batch_calibration(pellet_brand: str = "Nouveau Lot Certifié A1") -> dict[str, Any]:
    """Réinitialise l'évaluation algorithmique Mélange P/A et remet les tarages à 0%."""
    active_mode = get_active_mode()
    now_ts = int(time.time())
    now_str = datetime.fromtimestamp(now_ts).strftime("%Y-%m-%d %H:%M:%S")
    clean_brand = (pellet_brand or "Nouveau Lot Certifié A1").strip()[:60]

    new_state = {
        "raz_epoch": now_ts,
        "raz_timestamp": now_str,
        "pellet_brand": clean_brand,
        "baseline_rpm_per_pa": None,
        "last_applied_epoch": now_ts,
    }
    save_pellet_batch_state(new_state)

    await execute_registers_batch_write(
        [
            {"reg_key": "trim_pellet_pct", "value": 0.0, "offset": 70},
            {"reg_key": "trim_exhaust_pct", "value": 0.0, "offset": 71},
        ],
        skip_poll=True,
    )

    db_log(
        "COMMAND",
        "PELLET_RAZ",
        f"RAZ Algorithme Mélange P/A exécuté pour le lot « {clean_brand} » : tarages remis à 0% et fenêtre de {int(BATCH_MIN_EVAL_MINUTES)} min réinitialisée.",
        active_mode,
    )
    latest = await collect_telemetry_cycle(active_mode)
    return {
        "status": "ok",
        "pellet_batch_state": new_state,
        "latest": latest,
    }
