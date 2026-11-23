"""Décodage des 76 offsets matériels Micronova / Agua IOT, mode hors-ligne et helpers télémétriques partagés."""
from datetime import datetime
import json
import logging
import time
from typing import Any

from analytics import calculate_forecast_runway, check_power_stability
from config import (
    NOBIS_ALARMS,
    PELLET_BAG_WEIGHT_KG,
    STOVE_STATES,
    TELEMETRY_COLUMNS,
    get_hopper_capacity_kg,
)
from database import db_log, get_db, get_settings_dict
from telemetry.dynamic_engine import (
    detect_capabilities,
    evaluate_buffer,
    infer_normalized_status_code,
    resolve_canonical,
)
from telemetry.hub import _comm_status

logger = logging.getLogger("nobis.decoder")
_DAYS_FR = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"]


def _is_app_silence_active(settings: dict[str, str]) -> int:
    """
    Retourne 1 si le mode Silence intelligent logiciel (silence_timer_state) est actif et non expiré, sinon 0.
    NOTE : Le registre EEPROM #33250 (0x81E2, set_silece_set) est vérifié inactif sur Nobis A10
    (carte T033.NBS.AIR.MB01, enable_mask_107 bit 2048 = 0 en Manuel/Auto/Boost) et n'est plus lu ni écrit.
    """
    raw = settings.get("silence_timer_state")
    if not raw:
        return 0
    try:
        st = json.loads(raw) if isinstance(raw, str) else raw
        if isinstance(st, dict) and bool(st.get("active", False)) and float(st.get("end_epoch", 0.0)) > time.time():
            return 1
    except Exception as exc:
        logger.debug("État silence_timer_state illisible: %s", exc)
    return 0


def format_stove_clock(hr: int, mn: int, day: int, mon: int, yr_full: int, wday: int) -> str:
    """Formate la date/heure interne de la carte Micronova (ex: 'Lun 17:42 01/11/2026')."""
    wday_str = _DAYS_FR[wday - 1] if 1 <= wday <= 7 else "---"
    return f"{wday_str} {hr:02d}:{mn:02d} {day:02d}/{mon:02d}/{yr_full}"


def compute_hopper_runway(hopper_pct: float, weather: dict[str, Any], settings: dict[str, str] | None = None) -> float:
    """Calcule l'autonomie restante du stock total (sacs + trémie) à partir des prévisions DJU."""
    s_dict = settings or get_settings_dict()
    try:
        cur_stock_bags = float(s_dict.get("pellet_bags_stock", "40"))
    except (ValueError, TypeError):
        cur_stock_bags = 40.0
    hopper_cap_kg = get_hopper_capacity_kg(s_dict)
    total_kg_avail = (cur_stock_bags * PELLET_BAG_WEIGHT_KG) + (hopper_pct / 100.0 * hopper_cap_kg)
    return calculate_forecast_runway(total_kg_avail, weather)


def compute_stability_deltas(
    comm_mode: str,
    now_epoch: int,
    state: int,
    p_actual: int,
    p_cmd: int,
    temp_probe_k: float,
    dep_pa: float,
    target_flame: float,
    target_dep: float,
) -> tuple[float | None, float | None]:
    """Calcule les écarts lissés sur 30 min (flamme et dépression) si puissance stable et ventilateurs actifs."""
    if state != 5 or p_actual <= 0:
        return None, None

    instant_delta = round(temp_probe_k - target_flame, 1)
    instant_dep_delta = round(dep_pa - target_dep, 1)

    conn_prev = get_db(comm_mode)
    try:
        is_stable_30m, _, stable_rows, fans_active = check_power_stability(
            conn_prev, now_epoch, state, p_actual, p_cmd, 1800
        )
    finally:
        conn_prev.close()

    if is_stable_30m and stable_rows and fans_active:
        past_deltas = [float(r[1]) - target_flame for r in stable_rows if r[1] is not None]
        past_deltas.append(instant_delta)
        flame_delta_avg = round(sum(past_deltas) / len(past_deltas), 1)

        past_dep_deltas = [float(r[2]) - target_dep for r in stable_rows if r[2] is not None]
        past_dep_deltas.append(instant_dep_delta)
        dep_delta_avg = round(sum(past_dep_deltas) / len(past_dep_deltas), 1)
        return flame_delta_avg, dep_delta_avg

    return None, None


def extract_chrono_fields(r_val: dict[str, float], raw_buf: dict[int, float] | None = None) -> dict[str, Any]:
    """Extrait les champs Chrono Hebdomadaire P1..P4 depuis le buffer matériel ou le catalogue r_val."""
    buf = raw_buf or {}
    specs = [
        (1, 33164, 48, 63, 127, 7, 19.0),
        (2, 33184, 126, 138, 127, 7, 19.0),
        (3, 33204, 144, 144, 0, 7, 20.0),
        (4, 33224, 144, 144, 0, 7, 20.0),
    ]
    out: dict[str, Any] = {
        "chrono_week_enable": int(buf.get(33162, r_val.get("chrono_week_enable_set", 0))),
    }
    for idx, base_off, def_start, def_stop, def_days, def_pwr, def_temp in specs:
        p = f"chrono_p{idx}"
        out[f"{p}_start"] = int(buf.get(base_off, r_val.get(f"{p}_start_set", def_start)))
        out[f"{p}_stop"] = int(buf.get(base_off + 2, r_val.get(f"{p}_stop_set", def_stop)))
        out[f"{p}_days"] = int(buf.get(base_off + 4, r_val.get(f"{p}_days_mask", def_days)))
        out[f"{p}_power"] = int(buf.get(base_off + 6, r_val.get(f"{p}_power_set", def_pwr)))
        out[f"{p}_temp"] = float(buf.get(base_off + 8, r_val.get(f"{p}_temperature_set", def_temp)))
    return out


def _normalize_signed_and_sync_rval(
    raw_buf: dict[int, float],
    regs: dict[str, dict[str, Any]],
    r_val: dict[str, float],
) -> None:
    for signed_off in (70, 71):
        if signed_off in raw_buf:
            sv = float(raw_buf[signed_off])
            if 128.0 <= sv <= 255.0:
                raw_buf[signed_off] = sv - 256.0
    for rk, meta in regs.items():
        off = int(meta["offset"])
        if off in raw_buf:
            r_val[rk] = float(raw_buf[off])


def _resolve_state_and_alarms(
    raw_buf: dict[int, float],
    prev: dict[str, Any],
    comm_mode: str,
) -> tuple[int, int, int, str, str]:
    prev_st = prev.get("status_code")
    fallback_st = int(prev_st) if prev_st is not None and prev_st != -1 else 0
    state = int(raw_buf.get(8, raw_buf.get("8", fallback_st)))

    prev_sm = prev.get("status_managed")
    fallback_sm = int(prev_sm) if prev_sm is not None else 0
    status_managed = int(raw_buf.get(232, raw_buf.get("232", fallback_sm)))
    alarm_code = int(raw_buf.get(34, 0))
    alarm_label = NOBIS_ALARMS.get(alarm_code, f"AL{alarm_code}")
    status_label = STOVE_STATES.get(state, f"Code {state}")
    if alarm_code > 0:
        status_label = f"{status_label} [{alarm_label}]"
        if alarm_code != int(prev.get("alarm_code") or 0):
            db_log("ERROR", "ALARME", f"Alarme poêle active : {alarm_label} (Code {alarm_code})", comm_mode)
    elif int(prev.get("alarm_code") or 0) > 0:
        db_log(
            "INFO",
            "ALARME",
            f"Alarme résolue / acquittée (retour état normal, code précédent: {prev.get('alarm_code')}).",
            comm_mode,
        )
    return state, status_managed, alarm_code, alarm_label, status_label


def _compute_hopper_level(
    popup_pellet_empty: int,
    prev: dict[str, Any],
    consumed_kg: float,
    comm_mode: str,
    hopper_capacity_kg: float = 35.0,
) -> float:
    prev_hopper = float(prev.get("pellet_hopper_pct") or 78.0)
    prev_pellet_empty = int(prev.get("popup_pellet_empty") or 0)
    delta_pct = (consumed_kg / max(1.0, hopper_capacity_kg)) * 100.0

    if popup_pellet_empty:
        if not prev_pellet_empty:
            db_log(
                "WARNING",
                "PELLET",
                "Sonde physique réserve granulés activée : recalibrage automatique de la jauge à 12%",
                comm_mode,
            )
            return 12.0
        return round(max(0.0, min(12.0, prev_hopper - delta_pct)), 1)

    if prev_pellet_empty:
        db_log(
            "INFO",
            "PELLET",
            f"Sonde physique réserve granulés réinitialisée (recharge détectée) : recalibrage automatique de la trémie à 100% ({int(hopper_capacity_kg)} kg)",
            comm_mode,
        )
        return 100.0
    return round(max(0.0, min(100.0, prev_hopper - delta_pct)), 1)


def _persist_catalog_from_buffer(
    comm_mode: str,
    regs: dict[str, dict[str, Any]],
    raw_buf: dict[int, float],
    now_str: str,
) -> None:
    conn = get_db(comm_mode)
    try:
        for rk, meta in regs.items():
            off = int(meta["offset"])
            val_to_store = raw_buf.get(off)
            if val_to_store is None and rk == "temp_ambient" and 1 in raw_buf:
                val_to_store = raw_buf[1]
            if val_to_store is not None:
                conn.execute(
                    "UPDATE registers_catalog SET current_val = ?, updated_at = ? WHERE reg_key = ?",
                    (float(val_to_store), now_str, rk),
                )
        conn.commit()
    finally:
        conn.close()


def decode_hardware_buffer(
    raw_buf: dict[int, float],
    regs: dict[str, dict[str, Any]],
    r_val: dict[str, float],
    prev: dict[str, Any],
    settings: dict[str, str],
    weather: dict[str, Any],
    comm_mode: str,
    now: datetime,
    now_str: str,
    dt_hours: float,
    register_map: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Décode un buffer brut Agua Cloud / Passerelle UART via le moteur générique Micronova (et repli Nobis A10)."""
    _normalize_signed_and_sync_rval(raw_buf, regs, r_val)
    ev = evaluate_buffer(raw_buf, register_map) if register_map else {}
    caps = detect_capabilities(register_map or {}, ev, settings=settings)

    def _dyn(canon: str, fallback: Any = None) -> Any:
        if not ev:
            return fallback
        _, entry = resolve_canonical(canon, ev, register_map)
        if entry and entry.get("value") is not None:
            return entry["value"]
        return fallback

    def _dyn_desc(canon: str) -> str | None:
        if not ev:
            return None
        _, entry = resolve_canonical(canon, ev, register_map)
        if entry and entry.get("description"):
            return str(entry["description"])
        return None

    now_epoch = int(now.timestamp())
    _comm_status["connected"] = True
    _comm_status["last_sync_time"] = now_str
    _comm_status["last_sync_epoch"] = now_epoch
    _comm_status["last_error"] = None
    _comm_status["comm_mode"] = comm_mode
    if prev.get("status_code") == -1:
        db_log("INFO", "COMMUNICATION", f"Communication avec le poêle rétablie avec succès ({comm_mode}).", comm_mode)

    state, status_managed, alarm_code, alarm_label, status_label = _resolve_state_and_alarms(raw_buf, prev, comm_mode)
    if ev:
        dyn_status_raw = _dyn("status_get")
        dyn_status_desc = _dyn_desc("status_get")
        if dyn_status_raw is not None or dyn_status_desc:
            state = infer_normalized_status_code(dyn_status_desc, int(round(float(dyn_status_raw))) if dyn_status_raw is not None else state)
            if dyn_status_desc:
                status_label = dyn_status_desc
        dyn_alarm_raw = _dyn("alarms_get")
        dyn_alarm_desc = _dyn_desc("alarms_get")
        if dyn_alarm_raw is not None:
            alarm_code = int(round(float(dyn_alarm_raw)))
        if alarm_code > 0 and dyn_alarm_desc:
            alarm_label = dyn_alarm_desc
            status_label = f"{status_label} [{alarm_label}]"

    blackout_popup = int(raw_buf.get(40, 0))
    popup_flags = int(raw_buf.get(115, 0))
    dyn_pellet_low = _dyn("pellet_reserve_low")
    popup_pellet_empty = 1 if ((popup_flags & 64) or (dyn_pellet_low is not None and int(round(float(dyn_pellet_low))) == 1)) else 0

    if caps.get("stove_type") == "hydro":
        dyn_temp_primary = _dyn("temp_water_get")
        dyn_sp_primary = _dyn("temp_water_setpoint")
    else:
        dyn_temp_primary = _dyn("temp_amb_get")
        dyn_sp_primary = _dyn("temp_amb_setpoint")

    raw_amb = dyn_temp_primary if dyn_temp_primary is not None else (raw_buf.get(103) if 103 in raw_buf else raw_buf.get(1))
    temp_amb = float(raw_amb if raw_amb is not None else (prev.get("temp_ambient") or 19.0))
    temp_fumes = float(_dyn("temp_fumes", raw_buf.get(2, prev.get("temp_fumes") or 25.0)))
    temp_probe_k = float(_dyn("temp_probe_k", raw_buf.get(0, prev.get("temp_probe_k") or 25.0)))
    dep_pa = float(_dyn("depression_pa", round(float(raw_buf.get(37, 0.0)) / 10.0, 1)))

    p_cmd = int(round(float(_dyn("power_level", raw_buf.get(33120, r_val.get("power_level", 4))))))
    p_actual = int(round(float(_dyn("real_power", raw_buf.get(11, p_cmd)))))
    standby_en = 1 if (state in (8, 9)) else int(round(float(_dyn("standby_set", raw_buf.get(33130, r_val.get("standby_set", 0) if comm_mode == "simulation" else 0)))))

    t_flags = int(raw_buf.get(22, 0))
    stove_clock_str = format_stove_clock(
        int(raw_buf.get(34048, now.hour)),
        int(raw_buf.get(34049, now.minute)),
        int(raw_buf.get(34050, now.day)),
        int(raw_buf.get(34051, now.month)),
        int(raw_buf.get(34052, now.year - 2000)) + 2000,
        int(raw_buf.get(34053, now.isoweekday())),
    )

    hopper_cap_kg = get_hopper_capacity_kg(settings)
    rate_kgh = round(0.60 + p_actual * 0.22, 2) if (state in (2, 3, 4, 5, 6) and p_actual > 0) else 0.0
    consumed_kg = rate_kgh * dt_hours
    dyn_hopper_pct = _dyn("pellet_level_pct")
    if dyn_hopper_pct is not None:
        hopper = round(max(0.0, min(100.0, float(dyn_hopper_pct))), 1)
    else:
        hopper = _compute_hopper_level(popup_pellet_empty, prev, consumed_kg, comm_mode, hopper_capacity_kg=hopper_cap_kg)
    runway_days = compute_hopper_runway(hopper, weather, settings=settings)

    flame_delta_avg, dep_delta_avg = compute_stability_deltas(
        comm_mode=comm_mode,
        now_epoch=now_epoch,
        state=state,
        p_actual=p_actual,
        p_cmd=p_cmd,
        temp_probe_k=temp_probe_k,
        dep_pa=dep_pa,
        target_flame=430.0 + (p_actual * 40.0),
        target_dep=round(2.0 + (p_actual * 0.25), 1),
    )

    prev_date_str = str(prev.get("timestamp") or "")[:10]
    base_daily_kg = float(prev.get("pellet_daily_kg") or 0.0) if prev_date_str == now_str[:10] else 0.0
    daily_kg = round(base_daily_kg + consumed_kg, 2)
    work_dt_h = dt_hours if state in (2, 3, 4, 5, 6) else 0.0
    prev_state = int(prev.get("status_code") if prev.get("status_code") is not None else state)
    ignitions = int(prev.get("ignitions_count") or 612) + (1 if state in (2, 3, 4, 5) and prev_state in (0, 8, 9) else 0)

    _persist_catalog_from_buffer(comm_mode, regs, raw_buf, now_str)

    return {
        "timestamp": now_str,
        "epoch": now_epoch,
        "comm_mode": comm_mode,
        "status_code": state,
        "status_label": status_label,
        "status_managed": status_managed,
        "alarm_code": alarm_code,
        "alarm_label": alarm_label,
        "blackout_popup": blackout_popup,
        "popup_flags": popup_flags,
        "popup_door_open": 1 if (popup_flags & 16) else 0,
        "popup_pellet_empty": popup_pellet_empty,
        "popup_pellet_open": 1 if (popup_flags & 8) else 0,
        "popup_pa_fault": 1 if (popup_flags & 4) else 0,
        "popup_tcj_fault": 1 if (popup_flags & 2) else 0,
        "popup_tck_fault": 1 if (popup_flags & 1) else 0,
        "temp_ambient": temp_amb,
        "temp_amb_setpoint": float(dyn_sp_primary if dyn_sp_primary is not None else raw_buf.get(33122, r_val.get("temp_amb_setpoint", 19.0))),
        "temp_fumes": temp_fumes,
        "temp_probe_k": temp_probe_k,
        "temp_board_ntc": None,
        "exhaust_rpm": int(round(float(_dyn("exhaust_rpm", float(raw_buf.get(47, 0.0)) * 10.0)))),
        "exhaust_target_rpm": None,
        "depression_pa": dep_pa,
        "flame_light_idx": None,
        "glow_plug_on": 1 if state in (2, 3, 4) else 0,
        "power_level": p_cmd,
        "power_actual": p_actual,
        "fun_auto_set": int(round(float(_dyn("fun_auto_set", raw_buf.get(33128, r_val.get("fun_auto_set", 1)))))),
        "standby_enabled": standby_en,
        "fun_pwf_set": int(round(float(_dyn("fun_pwf_set", raw_buf.get(33154, r_val.get("fun_pwf_set", 0)))))),
        "set_silece_set": _is_app_silence_active(settings),
        "fan_front_speed": int(round(float(_dyn("fan_front_speed", raw_buf.get(33132, r_val.get("fan_front_speed", 3)))))),
        "vent_front_actual": int(round(float(_dyn("vent_front_actual", raw_buf.get(16, 0))))),
        "duct_left_temp": float(_dyn("duct_left_temp", round(float(raw_buf.get(29, 0.0)) / 2.0, 1))),
        "duct_left_setpoint": float(_dyn("duct_left_setpoint", raw_buf.get(33126, r_val.get("duct_left_setpoint", 20.0)))),
        "duct_left_speed": int(round(float(_dyn("duct_left_speed", raw_buf.get(33136, r_val.get("duct_left_speed", 0)))))),
        "duct_left_actual": int(round(float(_dyn("duct_left_actual", raw_buf.get(32, 0))))),
        "duct_right_temp": float(_dyn("duct_right_temp", round(float(raw_buf.get(28, 0.0)) / 2.0, 1))),
        "duct_right_setpoint": float(_dyn("duct_right_setpoint", raw_buf.get(33124, r_val.get("duct_right_setpoint", 20.0)))),
        "duct_right_speed": int(round(float(_dyn("duct_right_speed", raw_buf.get(33134, r_val.get("duct_right_speed", 0)))))),
        "duct_right_actual": int(round(float(_dyn("duct_right_actual", raw_buf.get(31, 0))))),
        "thermostat_flags": t_flags,
        "thermostat_main": 1 if (t_flags & 128) else 0,
        "thermostat_dx": 1 if (t_flags & 32) else 0,
        "thermostat_sx": 1 if (t_flags & 16) else 0,
        "enable_mask_105": int(raw_buf.get(105, 18479)),
        "enable_mask_107": int(raw_buf.get(107, 2)),
        **extract_chrono_fields(r_val, raw_buf),
        "stove_clock_str": stove_clock_str,
        "auger_on_time_s": None,
        "auger_cycle_s": None,
        "auger_duty_pct": None,
        "pellet_rate_kgh": rate_kgh,
        "pellet_hopper_pct": hopper,
        "pellet_daily_kg": daily_kg,
        "trim_pellet_pct": int(r_val.get("trim_pellet_pct", 0)),
        "trim_exhaust_pct": int(r_val.get("trim_exhaust_pct", 0)),
        "cat_service_hours": float(raw_buf.get(260, r_val.get("cat_service_hours", 1420.0))),
        "total_work_hours": round(float(prev.get("total_work_hours") or 2840.0) + work_dt_h, 2),
        "ignitions_count": ignitions,
        "weather_temp_ext": weather["weather_temp_ext"],
        "weather_humidity": weather["weather_humidity"],
        "weather_wind_kmh": weather["weather_wind_kmh"],
        "runway_days_est": runway_days,
        "flame_delta_avg": flame_delta_avg,
        "dep_delta_avg": dep_delta_avg,
        "raw_buffer_json": json.dumps({str(k): v for k, v in sorted(raw_buf.items())}),
    }


def build_offline_record(
    prev: dict[str, Any],
    r_val: dict[str, float],
    weather: dict[str, Any],
    comm_mode: str,
    now: datetime,
    now_str: str,
    cloud_error: str | None,
) -> dict[str, Any]:
    """Construit un point de rupture (status_code=-1, courbes NULL) lors d'une perte de liaison réelle."""
    _comm_status["connected"] = False
    _comm_status["last_error"] = cloud_error or f"Poêle injoignable ({comm_mode}) : rupture de communication ou absence de trame reçue."
    _comm_status["comm_mode"] = comm_mode
    if prev.get("status_code") != -1:
        db_log("ERROR", "COMMUNICATION", _comm_status["last_error"], comm_mode)

    prev_hopper = float(prev.get("pellet_hopper_pct") or 78.0)
    prev_date_str = str(prev.get("timestamp") or "")[:10]
    daily_kg = float(prev.get("pellet_daily_kg") or 0.0) if prev_date_str == now_str[:10] else 0.0
    record: dict[str, Any] = {c: None for c in TELEMETRY_COLUMNS.keys() if c != "id"}
    record.update({
        "timestamp": now_str,
        "epoch": int(now.timestamp()),
        "comm_mode": comm_mode,
        "status_code": -1,
        "status_label": "HORS LIGNE (Perte connexion)",
        "status_managed": int(prev.get("status_managed") or 0),
        "alarm_code": 0,
        "alarm_label": "Perte de connexion",
        "stove_clock_str": str(prev.get("stove_clock_str") or "--:--"),
        "pellet_hopper_pct": prev_hopper,
        "pellet_daily_kg": daily_kg,
        "cat_service_hours": float(r_val.get("cat_service_hours", 1420.0)),
        "total_work_hours": float(prev.get("total_work_hours") or 2840.0),
        "ignitions_count": int(prev.get("ignitions_count") or 612),
        "weather_temp_ext": weather["weather_temp_ext"],
        "weather_humidity": weather["weather_humidity"],
        "weather_wind_kmh": weather["weather_wind_kmh"],
        "runway_days_est": float(prev.get("runway_days_est") or 15.0),
        "flame_delta_avg": None,
        "dep_delta_avg": None,
        "raw_buffer_json": "{}",
    })
    return record
