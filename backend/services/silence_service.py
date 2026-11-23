"""
Logique métier et persistance du Mode Silence ! intelligent.
Gère l'abaissement des consignes en hors-gel (7°C), l'extinction du boost/éco/chrono,
la régulation ralentie sans extinction, le timer asynchrone et la restauration automatique.
"""
from datetime import datetime
import json
import logging
import time
from typing import Any

from database import (
    db_log,
    get_active_mode,
    get_latest_telemetry,
    get_registers_dict,
    get_settings_dict,
    get_sys_db,
)
from services.lifecycle import scheduler
from telemetry import collect_telemetry_cycle, execute_registers_batch_write

logger = logging.getLogger("nobis.silence")

SILENCE_KEYS_TO_SAVE = [
    "temp_amb_setpoint",
    "duct_left_setpoint",
    "duct_right_setpoint",
    "fun_pwf_set",
    "standby_set",
    "chrono_week_enable_set",
    "fun_auto_set",
    "fan_front_speed",
    "duct_left_speed",
    "duct_right_speed",
    "power_level",
]


def get_silence_state() -> dict[str, Any]:
    """Récupère l'état brut persistant du mode Silence depuis le cache settings."""
    raw = get_settings_dict().get("silence_timer_state")
    if raw:
        try:
            return json.loads(raw)
        except Exception as exc:
            logger.debug("État JSON silence_timer_state invalide : %s", exc)
    return {
        "active": False,
        "duration_hours": 2.0,
        "start_epoch": 0.0,
        "end_epoch": 0.0,
        "is_stove_on": False,
        "initial_state": {},
        "modified_keys": [],
    }


def save_silence_state(state: dict[str, Any]) -> None:
    """Sauvegarde l'état du mode Silence au format JSON dans la table settings."""
    conn = get_sys_db()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('silence_timer_state', ?)",
            (json.dumps(state),),
        )
        conn.commit()
    finally:
        conn.close()


def get_silence_status() -> dict[str, Any]:
    """Retourne l'état courant consolidé du mode Silence avec calcul du compte à rebours restant."""
    state = get_silence_state()
    is_active = bool(state.get("active", False))
    end_epoch = float(state.get("end_epoch", 0.0))
    now_ts = time.time()
    remaining = max(0, int(end_epoch - now_ts)) if is_active else 0
    if is_active and remaining <= 0:
        is_active = False
    return {
        "active": is_active,
        "duration_hours": float(state.get("duration_hours", 2.0)),
        "start_epoch": float(state.get("start_epoch", 0.0)),
        "end_epoch": end_epoch,
        "remaining_seconds": remaining,
        "is_stove_on": state.get("is_stove_on"),
        "initial_state": state.get("initial_state", {}),
        "modified_keys": state.get("modified_keys", []),
    }


async def activate_silence_mode(duration_hours: float = 2.0) -> dict[str, Any]:
    """
    Active le mode Silence intelligent :
    - Sauvegarde l'état initial des consignes et ventilations.
    - Abaisse les consignes de température en hors-gel (7°C).
    - Si le poêle est allumé : désactive Boost/Éco/Chrono, active le mode Auto total et bascule en P0/Ventil 0.
    - Programme le job d'extinction automatique à l'échéance.
    """
    active_mode = get_active_mode()
    regs = get_registers_dict(active_mode)
    latest_dict = get_latest_telemetry(active_mode)

    is_stove_on = False
    if latest_dict and latest_dict.get("status_code") is not None:
        st_code = int(latest_dict.get("status_code", 0))
        if st_code == -1:
            cmd_val = float(latest_dict.get("status_managed") or regs.get("status_code", {}).get("current_val", 0.0))
            is_stove_on = (cmd_val == 85.0)
        else:
            is_stove_on = (st_code != 0)
    elif "status_code" in regs:
        cmd_val = float(regs["status_code"].get("current_val", 0.0))
        is_stove_on = (cmd_val == 85.0)

    existing_state = get_silence_state()
    preserve_initial = (
        bool(existing_state.get("active", False))
        and float(existing_state.get("end_epoch", 0.0)) > time.time()
        and isinstance(existing_state.get("initial_state"), dict)
        and bool(existing_state.get("initial_state"))
    )
    initial_state = dict(existing_state["initial_state"]) if preserve_initial else {}
    for k in SILENCE_KEYS_TO_SAVE:
        if k not in initial_state:
            if k in regs:
                initial_state[k] = float(regs[k].get("current_val", 0.0))
            elif latest_dict and k in latest_dict and latest_dict[k] is not None:
                initial_state[k] = float(latest_dict[k])
            else:
                initial_state[k] = 0.0

    # NOTE : Le registre EEPROM #33250 (0x81E2, set_silece_set) n'est volontairement plus écrit :
    # vérifié inactif sur Nobis A10 (carte T033.NBS.AIR.MB01 — bit 2048 set_silece_enable = 0 dans #107
    # en Manuel P3, Auto P7 et Boost P8, aucun effet sur le poêle ni la radiocommande).
    # L'état du mode Silence intelligent est suivi uniquement côté application (silence_timer_state).
    if is_stove_on:
        activation_cmds = [
            {"reg_key": "fun_pwf_set", "value": 0.0, "offset": int(regs.get("fun_pwf_set", {}).get("offset", 33154))},
            {"reg_key": "standby_set", "value": 0.0, "offset": int(regs.get("standby_set", {}).get("offset", 33130))},
            {"reg_key": "chrono_week_enable_set", "value": 0.0, "offset": int(regs.get("chrono_week_enable_set", {}).get("offset", 33162))},
            {"reg_key": "fun_auto_set", "value": 1.0, "offset": int(regs.get("fun_auto_set", {}).get("offset", 33128))},
            {"reg_key": "fan_front_speed", "value": 8.0, "offset": int(regs.get("fan_front_speed", {}).get("offset", 33132))},
            {"reg_key": "duct_left_speed", "value": 8.0, "offset": int(regs.get("duct_left_speed", {}).get("offset", 33136))},
            {"reg_key": "duct_right_speed", "value": 8.0, "offset": int(regs.get("duct_right_speed", {}).get("offset", 33134))},
            {"reg_key": "temp_amb_setpoint", "value": 7.0, "offset": int(regs.get("temp_amb_setpoint", {}).get("offset", 33122))},
            {"reg_key": "duct_left_setpoint", "value": 7.0, "offset": int(regs.get("duct_left_setpoint", {}).get("offset", 33126))},
            {"reg_key": "duct_right_setpoint", "value": 7.0, "offset": int(regs.get("duct_right_setpoint", {}).get("offset", 33124))},
        ]
        modified_keys = [
            "fun_pwf_set",
            "standby_set",
            "chrono_week_enable_set",
            "fun_auto_set",
            "fan_front_speed",
            "duct_left_speed",
            "duct_right_speed",
            "temp_amb_setpoint",
            "duct_left_setpoint",
            "duct_right_setpoint",
        ]
        log_detail = "poêle allumé : Boost/Éco/Chrono désactivés, Auto total activé, consignes en hors-gel 7°C (régulation P0 & Ventil 0 sans extinction)"
    else:
        activation_cmds = [
            {"reg_key": "temp_amb_setpoint", "value": 7.0, "offset": int(regs.get("temp_amb_setpoint", {}).get("offset", 33122))},
            {"reg_key": "duct_left_setpoint", "value": 7.0, "offset": int(regs.get("duct_left_setpoint", {}).get("offset", 33126))},
            {"reg_key": "duct_right_setpoint", "value": 7.0, "offset": int(regs.get("duct_right_setpoint", {}).get("offset", 33124))},
        ]
        modified_keys = [
            "temp_amb_setpoint",
            "duct_left_setpoint",
            "duct_right_setpoint",
        ]
        log_detail = "poêle éteint : toutes les consignes de température passées en hors-gel 7°C"

    write_res = await execute_registers_batch_write(activation_cmds, skip_poll=True)

    now_ts = time.time()
    dur_s = max(60, int(duration_hours * 3600))
    end_ts = now_ts + dur_s
    end_dt = datetime.fromtimestamp(end_ts)

    state = {
        "active": True,
        "duration_hours": float(duration_hours),
        "start_epoch": now_ts,
        "end_epoch": end_ts,
        "is_stove_on": is_stove_on,
        "initial_state": initial_state,
        "modified_keys": modified_keys,
    }
    save_silence_state(state)

    latest = await collect_telemetry_cycle(active_mode)

    scheduler.add_job(
        _auto_expire_silence_job,
        "date",
        run_date=end_dt,
        id="silence_timer_job",
        replace_existing=True,
    )

    db_log(
        "COMMAND",
        "SILENCE",
        f"Mode Silence ! intelligent activé pour {duration_hours:g}H ({log_detail}). Restauration programmée à {end_dt.strftime('%H:%M:%S')}.",
        active_mode,
    )

    status = get_silence_status()
    return {
        "status": "ok",
        "silence_mode": status,
        "write_result": write_res,
        "latest": latest,
    }


_DEFAULT_RESTORE_OFFSETS = {
    "temp_amb_setpoint": (19.0, 33122),
    "duct_left_setpoint": (20.0, 33126),
    "duct_right_setpoint": (20.0, 33124),
    "fun_pwf_set": (0.0, 33154),
    "standby_set": (0.0, 33130),
    "chrono_week_enable_set": (0.0, 33162),
    "fun_auto_set": (1.0, 33128),
    "fan_front_speed": (3.0, 33132),
    "duct_left_speed": (0.0, 33136),
    "duct_right_speed": (0.0, 33134),
    "power_level": (4.0, 33120),
}


def _parse_override_commands(override_commands: list[Any] | None) -> dict[str, float]:
    overrides_dict: dict[str, float] = {}
    if not override_commands:
        return overrides_dict
    for c in override_commands:
        rk = getattr(c, "reg_key", None) or (c.get("reg_key") if isinstance(c, dict) else None)
        val = getattr(c, "value", None) if hasattr(c, "value") else (c.get("value") if isinstance(c, dict) else None)
        if rk is not None and val is not None:
            try:
                overrides_dict[str(rk)] = float(val)
            except (ValueError, TypeError):
                pass
    return overrides_dict


def _build_silence_restore_commands(
    initial: dict[str, Any],
    modified_keys: list[str] | None,
    regs: dict[str, Any],
    overrides_dict: dict[str, float],
) -> list[dict[str, Any]]:
    if modified_keys is None:
        keys_to_restore = [k for k in _DEFAULT_RESTORE_OFFSETS if k in initial]
    else:
        keys_to_restore = list(modified_keys)

    for k in overrides_dict:
        if k not in keys_to_restore and k in _DEFAULT_RESTORE_OFFSETS:
            keys_to_restore.append(k)

    restore_cmds: list[dict[str, Any]] = []
    for k in keys_to_restore:
        def_val, def_off = _DEFAULT_RESTORE_OFFSETS.get(k, (0.0, 0))
        off = int(regs.get(k, {}).get("offset", def_off))
        target_val = overrides_dict[k] if k in overrides_dict else float(initial.get(k, def_val))
        restore_cmds.append({"reg_key": k, "value": target_val, "offset": off})
    return restore_cmds


async def deactivate_silence_mode(
    is_auto_expired: bool = False,
    override_commands: list[Any] | None = None,
) -> dict[str, Any]:
    """
    Désactive le mode Silence intelligent et restaure l'état d'origine du poêle :
    - Annule le timer d'expiration planifié dans APScheduler.
    - Restaure les consignes thermiques et ventilations sauvegardées avant activation.
    - Applique d'éventuelles commandes de substitution (override_commands).
    - Met à jour l'état persistant et journalise l'événement.
    """
    active_mode = get_active_mode()
    state = get_silence_state()
    initial = state.get("initial_state", {})
    modified_keys = state.get("modified_keys")
    regs = get_registers_dict(active_mode)

    if scheduler.get_job("silence_timer_job"):
        try:
            scheduler.remove_job("silence_timer_job")
        except Exception as exc:
            logger.debug("Suppression silence_timer_job ignorée : %s", exc)

    overrides_dict = _parse_override_commands(override_commands)
    restore_cmds = _build_silence_restore_commands(initial, modified_keys, regs, overrides_dict)

    # Registre #33250 (0x81E2, set_silece_set) volontairement non écrit (inactif sur Nobis A10, #107 bit 2048 = 0).
    if restore_cmds:
        write_res = await execute_registers_batch_write(restore_cmds, skip_poll=True)
    else:
        write_res = {"status": "ok", "count": 0, "latest": {}}

    state["active"] = False
    state["end_epoch"] = 0.0
    save_silence_state(state)

    latest = await collect_telemetry_cycle(active_mode)

    if overrides_dict:
        over_summary = ", ".join(f"{k}={v:g}" for k, v in overrides_dict.items())
        reason = f"Désactivation manuelle avec consigne ({over_summary})"
    elif is_auto_expired:
        reason = "Fin du compte à rebours"
    else:
        reason = "Désactivation manuelle"

    db_log(
        "COMMAND",
        "SILENCE",
        f"Mode Silence ! intelligent désactivé ({reason}) : paramètres et consignes d'origine restaurés.",
        active_mode,
    )

    status = get_silence_status()
    return {
        "status": "ok",
        "silence_mode": status,
        "write_result": write_res,
        "latest": latest,
    }


async def _auto_expire_silence_job() -> None:
    """Tâche périodique ou planifiée déclenchée à l'expiration du compte à rebours du mode Silence."""
    try:
        await deactivate_silence_mode(is_auto_expired=True)
    except Exception as e:
        db_log("ERROR", "SILENCE", f"Erreur lors de la fin automatique du mode Silence ! : {str(e)}", get_active_mode())
