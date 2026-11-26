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
from zoneinfo import ZoneInfo

from clients import agua_client
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


def _build_silence_activation_plan(
    regs: dict[str, Any],
    is_stove_on: bool,
    can_write_eco: bool,
) -> tuple[list[dict[str, Any]], list[str], str]:
    """Construit la liste des écritures d'activation Silence, les clés modifiées et le résumé de log."""
    if not is_stove_on:
        temp_keys = ("temp_amb_setpoint", "duct_left_setpoint", "duct_right_setpoint")
        cmds = [
            {"reg_key": rk, "value": 7.0, "offset": int(regs.get(rk, {}).get("offset", _DEFAULT_RESTORE_OFFSETS[rk][1]))}
            for rk in temp_keys
        ]
        return cmds, list(temp_keys), "poêle éteint : toutes les consignes de température passées en hors-gel 7°C"

    specs: list[tuple[str, float]] = [
        ("fun_pwf_set", 0.0),
        *( [("standby_set", 0.0)] if can_write_eco else [] ),
        ("chrono_week_enable_set", 0.0),
        ("fun_auto_set", 1.0),
        ("fan_front_speed", 0.0),
        ("duct_left_speed", 0.0),
        ("duct_right_speed", 0.0),
        ("temp_amb_setpoint", 7.0),
        ("duct_left_setpoint", 7.0),
        ("duct_right_setpoint", 7.0),
    ]
    cmds = [
        {"reg_key": rk, "value": val, "offset": int(regs.get(rk, {}).get("offset", _DEFAULT_RESTORE_OFFSETS[rk][1]))}
        for rk, val in specs
    ]
    modified_keys = [rk for rk, _ in specs]
    eco_txt = "Boost/Éco/Chrono" if can_write_eco else "Boost/Chrono"
    log_detail = f"poêle allumé : {eco_txt} désactivés, Auto flamme seulement activé, ventilations coupées (0), consignes en hors-gel 7°C"
    return cmds, modified_keys, log_detail


async def activate_silence_mode(duration_hours: float = 2.0) -> dict[str, Any]:
    """
    Active le mode Silence intelligent :
    - Sauvegarde l'état initial des consignes et ventilations.
    - Abaisse les consignes de température en hors-gel (7°C).
    - Si le poêle est allumé : désactive Boost/Éco/Chrono, active le mode Auto total et bascule en P0/Ventil 0.
    - Programme le job d'extinction automatique à l'échéance.
    """
    active_mode = get_active_mode()
    settings = get_settings_dict()
    can_write_eco = active_mode != "agua_cloud" or bool(agua_client.get_capabilities(settings).get("can_write_eco"))
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
        if k == "standby_set" and not can_write_eco:
            continue
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
    activation_cmds, modified_keys, log_detail = _build_silence_activation_plan(regs, is_stove_on, can_write_eco)

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
    "standby_set": (0.0, 33148),
    "chrono_week_enable_set": (0.0, 33162),
    "fun_auto_set": (1.0, 33128),
    "fan_front_speed": (3.0, 33132),
    "duct_left_speed": (0.0, 33136),
    "duct_right_speed": (0.0, 33134),
    "power_level": (4.0, 33120),
}


def _find_active_chrono_program(
    regs: dict[str, Any],
    now_dt: datetime | None = None,
) -> dict[str, Any] | None:
    """Retourne le programme Chrono P1..P4 actif pour l'instant courant, avec ses consignes cibles."""
    if now_dt is None:
        try:
            ref_dt = datetime.now(ZoneInfo("Europe/Paris"))
        except Exception:
            ref_dt = datetime.now()
    else:
        ref_dt = now_dt
    now_slot = ref_dt.hour * 6 + (ref_dt.minute // 10)
    today_bit = 1 << ref_dt.weekday()
    prev_day_bit = 1 << ((ref_dt.weekday() - 1) % 7)

    for p in (1, 2, 3, 4):
        start_slot = int(round(float(regs.get(f"chrono_p{p}_start_set", {}).get("current_val", 144))))
        stop_slot = int(round(float(regs.get(f"chrono_p{p}_stop_set", {}).get("current_val", 144))))
        days_mask = int(round(float(regs.get(f"chrono_p{p}_days_mask", {}).get("current_val", 0))))
        if start_slot >= 144 or stop_slot >= 144 or start_slot == stop_slot or days_mask <= 0:
            continue

        if stop_slot > start_slot:
            is_active = (days_mask & today_bit) != 0 and start_slot <= now_slot < stop_slot
        else:
            is_active = ((days_mask & today_bit) != 0 and now_slot >= start_slot) or (
                (days_mask & prev_day_bit) != 0 and now_slot < stop_slot
            )

        if not is_active:
            continue

        chrono_to_target = (
            (f"chrono_p{p}_temperature_set", "temp_amb_setpoint"),
            (f"chrono_p{p}_power_set", "power_level"),
            (f"chrono_p{p}_fan_front_set", "fan_front_speed"),
            (f"chrono_p{p}_tcanl_set", "duct_left_setpoint"),
            (f"chrono_p{p}_canl_set", "duct_left_speed"),
            (f"chrono_p{p}_tcanr_set", "duct_right_setpoint"),
            (f"chrono_p{p}_canr_set", "duct_right_speed"),
        )
        values: dict[str, float] = {}
        for src_key, dst_key in chrono_to_target:
            if src_key in regs and regs[src_key].get("current_val") is not None:
                values[dst_key] = float(regs[src_key]["current_val"])
        return {"program": p, "values": values}

    return None


def _parse_override_commands(override_commands: list[Any] | None) -> list[tuple[str, float, int | None]]:
    parsed: list[tuple[str, float, int | None]] = []
    if not override_commands:
        return parsed
    for c in override_commands:
        rk = getattr(c, "reg_key", None) or (c.get("reg_key") if isinstance(c, dict) else None)
        val = getattr(c, "value", None) if hasattr(c, "value") else (c.get("value") if isinstance(c, dict) else None)
        raw_off = getattr(c, "offset", None) if hasattr(c, "offset") else (c.get("offset") if isinstance(c, dict) else None)
        if rk is not None and val is not None:
            try:
                parsed_val = float(val)
                parsed_off: int | None = None
                if raw_off is not None and int(raw_off) > 0:
                    parsed_off = int(raw_off)
                parsed.append((str(rk), parsed_val, parsed_off))
            except (ValueError, TypeError):
                pass
    return parsed


def _build_override_commands(
    override_commands: list[Any] | None,
    regs: dict[str, Any],
) -> list[dict[str, Any]]:
    overrides = _parse_override_commands(override_commands)
    cmds: list[dict[str, Any]] = []
    for rk, val, explicit_off in overrides:
        def_off = _DEFAULT_RESTORE_OFFSETS.get(rk, (0.0, 0))[1]
        reg_off = int(regs.get(rk, {}).get("offset", def_off))
        off = explicit_off if explicit_off is not None else reg_off
        cmds.append({"reg_key": rk, "value": float(val), "offset": off})
    return cmds


def _build_silence_restore_commands(
    initial: dict[str, Any],
    modified_keys: list[str] | None,
    regs: dict[str, Any],
    active_chrono: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    restore_base: dict[str, Any] = dict(initial)
    if modified_keys is None:
        keys_to_restore = [k for k in _DEFAULT_RESTORE_OFFSETS if k in restore_base]
    else:
        keys_to_restore = list(modified_keys)

    if active_chrono and isinstance(active_chrono.get("values"), dict):
        for rk, val in active_chrono["values"].items():
            restore_base[rk] = float(val)
            if rk not in keys_to_restore:
                keys_to_restore.append(rk)

    restore_cmds: list[dict[str, Any]] = []
    for k in keys_to_restore:
        def_val, def_off = _DEFAULT_RESTORE_OFFSETS.get(k, (0.0, 0))
        off = int(regs.get(k, {}).get("offset", def_off))
        target_val = float(restore_base.get(k, def_val))
        restore_cmds.append({"reg_key": k, "value": target_val, "offset": off})
    return restore_cmds


async def deactivate_silence_mode(
    is_auto_expired: bool = False,
    override_commands: list[Any] | None = None,
    now_dt: datetime | None = None,
) -> dict[str, Any]:
    """
    Désactive le mode Silence intelligent et restaure l'état d'origine (ou le programme Chrono actif) :
    - Annule le timer d'expiration planifié dans APScheduler.
    - Si Chrono était actif avant Silence et qu'un programme P1..P4 est en cours, applique ses consignes.
    - Restaure d'abord les paramètres précédents/Chrono, puis applique d'éventuelles surcharges manuelles.
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

    active_chrono = None
    if float(initial.get("chrono_week_enable_set", 0.0)) >= 1.0:
        active_chrono = _find_active_chrono_program(regs, now_dt=now_dt)

    restore_cmds = _build_silence_restore_commands(
        initial,
        modified_keys,
        regs,
        active_chrono=active_chrono,
    )
    override_cmds = _build_override_commands(override_commands, regs)

    # Registre #33250 (0x81E2, set_silece_set) volontairement non écrit (inactif sur Nobis A10, #107 bit 2048 = 0).
    if restore_cmds:
        write_res = await execute_registers_batch_write(restore_cmds, skip_poll=True)
    else:
        write_res = {"status": "ok", "count": 0, "latest": {}}

    if override_cmds:
        write_res = await execute_registers_batch_write(override_cmds, skip_poll=True)

    state["active"] = False
    state["end_epoch"] = 0.0
    save_silence_state(state)

    latest = await collect_telemetry_cycle(active_mode)

    chrono_note = f" via programme Chrono P{active_chrono['program']}" if active_chrono else ""
    if override_cmds:
        over_summary = ", ".join(f"{c['reg_key']}={c['value']:g}" for c in override_cmds)
        reason = f"Désactivation manuelle avec restauration préalable{chrono_note} puis consigne ({over_summary})"
    elif is_auto_expired:
        reason = f"Fin du compte à rebours{chrono_note}"
    else:
        reason = f"Désactivation manuelle{chrono_note}"

    db_log(
        "COMMAND",
        "SILENCE",
        f"Mode Silence ! intelligent désactivé ({reason}) : paramètres restaurés.",
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


def reconcile_silence_with_hardware(record: dict[str, Any], comm_mode: str) -> bool:
    """Désactive le mode Silence applicatif si une modification manuelle physique est détectée sur le poêle."""
    if comm_mode == "simulation" or not record:
        return False
    state = get_silence_state()
    now_ts = time.time()
    if not bool(state.get("active", False)) or now_ts >= float(state.get("end_epoch", 0.0)):
        return False
    if (now_ts - float(state.get("start_epoch", 0.0))) < 15.0:
        return False
    status_code = int(record.get("status_code") if record.get("status_code") is not None else 0)
    if status_code == -1:
        return False

    temp_overridden = float(record.get("temp_amb_setpoint") or 7.0) > 7.5
    mode_overridden = (
        bool(state.get("is_stove_on"))
        and status_code != 0
        and (int(record.get("fun_pwf_set") or 0) > 0 or int(record.get("fun_auto_set") or 0) == 0)
    )
    if not (temp_overridden or mode_overridden):
        return False

    if scheduler.get_job("silence_timer_job"):
        try:
            scheduler.remove_job("silence_timer_job")
        except Exception as exc:
            logger.debug("Suppression silence_timer_job ignorée : %s", exc)

    state["active"] = False
    state["end_epoch"] = 0.0
    save_silence_state(state)
    record["set_silece_set"] = 0
    db_log(
        "INFO",
        "SILENCE",
        "Mode Silence ! désactivé automatiquement : modification manuelle détectée sur le poêle.",
        comm_mode,
    )
    return True
