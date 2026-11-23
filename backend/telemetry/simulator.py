"""Moteur de simulation physique haute fidélité du poêle Nobis A10 C Light Style Coax."""
from datetime import datetime
import json
from typing import Any

from config import HOPPER_CAPACITY_KG, STOVE_STATES, TELEMETRY_COLUMNS
from telemetry.decoder import (
    _is_app_silence_active,
    compute_hopper_runway,
    compute_stability_deltas,
    extract_chrono_fields,
    format_stove_clock,
)
from telemetry.hub import _comm_status


def _sim_real_fan_register(cmd_val: int, state: int, p_actual: int, is_front: bool = False) -> int:
    """
    Encode la vitesse réelle d'un ventilateur au format natif Micronova (#16, #31, #32) :
    0 = OFF, 1 = RIS (Risparmio), 2..8 = Vitesse physique 1..7 (décalage +1 vs consigne 1..7).
    """
    if state != 5 or cmd_val <= 0:
        return 0
    if cmd_val == 8:  # Mode PS (Auto)
        if p_actual == 0:
            return 1 if is_front else 0
        return min(8, max(2, p_actual + 1))
    return min(8, cmd_val + 1)


def _build_sim_raw_buffer(
    r_val: dict[str, float],
    now: datetime,
    state: int,
    cmd_on: int,
    p_cmd: int,
    p_actual: int,
    standby_en: int,
    fun_pwf: int,
    temp_amb: float,
    sp_amb: float,
    temp_fumes: float,
    temp_k: float,
    rpm: int,
    sim_dep: float,
    vent_front_actual: int,
    duct_left_actual: int,
    duct_right_actual: int,
) -> dict[str, Any]:
    """Génère le buffer brut simulé des offsets Micronova pour l'inspecteur et les diagnostics."""
    buf: dict[str, Any] = {
        "0": round(temp_k, 1),
        "2": round(temp_fumes, 1),
        "8": state,
        "11": p_actual,
        "16": vent_front_actual,
        "22": 64,
        "28": 40,
        "29": 40,
        "31": duct_right_actual,
        "32": duct_left_actual,
        "34": 0,
        "37": int(round(sim_dep * 10.0)),
        "40": 0,
        "47": int(round(rpm / 10.0)),
        "70": int(r_val.get("trim_pellet_pct", 0)),
        "71": int(r_val.get("trim_exhaust_pct", 0)),
        "103": round(temp_amb, 1),
        "105": 18479,
        "107": 2,
        "115": 0,
        "232": cmd_on,
        "33120": p_cmd,
        "33122": int(sp_amb),
        "33128": int(r_val.get("fun_auto_set", 1)),
        "33130": standby_en,
        "33132": int(r_val.get("fan_front_speed", 3)),
        "33134": int(r_val.get("duct_right_speed", 0)),
        "33136": int(r_val.get("duct_left_speed", 0)),
        "33154": fun_pwf,
        "33162": int(r_val.get("chrono_week_enable_set", 0)),
    }
    chrono_defaults = [
        (1, 33164, 48, 63, 127, 19),
        (2, 33184, 126, 138, 127, 19),
        (3, 33204, 144, 144, 0, 20),
        (4, 33224, 144, 144, 0, 20),
    ]
    for idx, base_off, def_s, def_e, def_d, def_t in chrono_defaults:
        p = f"chrono_p{idx}"
        buf[str(base_off)] = int(r_val.get(f"{p}_start_set", def_s))
        buf[str(base_off + 2)] = int(r_val.get(f"{p}_stop_set", def_e))
        buf[str(base_off + 4)] = int(r_val.get(f"{p}_days_mask", def_d))
        buf[str(base_off + 6)] = int(r_val.get(f"{p}_power_set", 7))
        buf[str(base_off + 8)] = int(r_val.get(f"{p}_temperature_set", def_t))
        buf[str(base_off + 10)] = int(r_val.get(f"{p}_tcanr_set", 20))
        buf[str(base_off + 12)] = int(r_val.get(f"{p}_tcanl_set", 20))
        buf[str(base_off + 14)] = int(r_val.get(f"{p}_fan_front_set", 0))
        buf[str(base_off + 16)] = int(r_val.get(f"{p}_canr_set", 0))
        buf[str(base_off + 18)] = int(r_val.get(f"{p}_canl_set", 0))

    buf.update({
        "34048": now.hour,
        "34049": now.minute,
        "34050": now.day,
        "34051": now.month,
        "34052": now.year - 2000,
        "34053": now.isoweekday(),
    })
    return buf


def simulate_telemetry_step(
    r_val: dict[str, float],
    prev: dict[str, Any],
    settings: dict[str, str],
    weather: dict[str, Any],
    comm_mode: str,
    now: datetime,
    now_str: str,
    dt_hours: float,
) -> dict[str, Any]:
    """Simule un cycle de fonctionnement complet du Nobis A10 et retourne l'enregistrement télémétrique."""
    now_epoch = int(now.timestamp())
    _comm_status["connected"] = True
    _comm_status["last_sync_time"] = now_str
    _comm_status["last_sync_epoch"] = now_epoch
    _comm_status["last_error"] = None
    _comm_status["comm_mode"] = "simulation"

    cmd_on = int(r_val.get("status_code", 85))
    sp_amb = float(r_val.get("temp_amb_setpoint", 19.0))
    prev_amb = float(prev.get("temp_ambient") or 19.5)
    state = 5 if cmd_on == 85 else 0
    standby_en = 1 if (state in (8, 9)) else int(r_val.get("standby_set", 0))
    p_cmd = int(r_val.get("power_level", 4))
    fun_pwf = int(r_val.get("fun_pwf_set", 0))
    fun_auto = int(r_val.get("fun_auto_set", 1))

    if state == 5:
        if fun_pwf == 1:
            p_actual = 8
        elif fun_auto == 1 and prev_amb >= sp_amb:
            p_actual = 0
        else:
            p_actual = p_cmd
    else:
        p_actual = 0

    fan_front_cmd = int(r_val.get("fan_front_speed", 3))
    vent_front_actual = _sim_real_fan_register(fan_front_cmd, state, p_actual, is_front=True)

    duct_left_cmd = int(r_val.get("duct_left_speed", 0))
    duct_left_actual = _sim_real_fan_register(duct_left_cmd, state, p_actual, is_front=False)

    duct_right_cmd = int(r_val.get("duct_right_speed", 0))
    duct_right_actual = _sim_real_fan_register(duct_right_cmd, state, p_actual, is_front=False)

    temp_amb = round(prev_amb + (0.01 if state == 5 and p_actual > 0 else (-0.02 if state == 5 and p_actual == 0 else -0.05)), 1)
    temp_fumes = round(101.0 + max(0, p_actual - 1) * 11.15, 1) if (state == 5 and p_actual > 0) else (85.0 if state == 5 and p_actual == 0 else 25.0)
    temp_k = round(380.0 + p_actual * 30.0, 1) if (state == 5 and p_actual > 0) else (320.0 if state == 5 and p_actual == 0 else 28.0)
    rpm = int(1420 + p_actual * 70) if (state == 5 and p_actual > 0) else (1200 if state == 5 and p_actual == 0 else 0)
    sim_dep = round(2.3 + p_actual * 0.18, 1) if (state == 5 and p_actual > 0) else (1.8 if state == 5 and p_actual == 0 else 0.1)
    rate_kgh = round(0.86 + max(0, p_actual - 1) * (1.30 / 6.0), 2) if (state == 5 and p_actual > 0) else (0.45 if state == 5 and p_actual == 0 else 0.0)

    stove_clock_str = format_stove_clock(
        int(r_val.get("clock_hour_set", now.hour)),
        int(r_val.get("clock_minute_set", now.minute)),
        int(r_val.get("calendar_day_set", now.day)),
        int(r_val.get("calendar_month_set", now.month)),
        int(r_val.get("calendar_year_set", now.year - 2000)) + 2000,
        int(r_val.get("calendar_day_week_set", now.isoweekday())),
    )

    consumed_kg = rate_kgh * dt_hours
    prev_hopper = float(prev.get("pellet_hopper_pct", 78.0))
    hopper = round(max(0.0, min(100.0, prev_hopper - (consumed_kg / HOPPER_CAPACITY_KG) * 100.0)), 1)
    prev_date_str = str(prev.get("timestamp", ""))[:10]
    base_daily_kg = float(prev.get("pellet_daily_kg", 0.0)) if prev_date_str == now_str[:10] else 0.0
    daily_kg = round(base_daily_kg + consumed_kg, 2)
    work_dt_h = dt_hours if state == 5 else 0.0
    prev_state = int(prev.get("status_code", state))
    ignitions = int(prev.get("ignitions_count", 612)) + (1 if state == 5 and prev_state in (0, 8) else 0)

    runway_days = compute_hopper_runway(hopper, weather)

    flame_delta_avg, dep_delta_avg = compute_stability_deltas(
        comm_mode=comm_mode,
        now_epoch=now_epoch,
        state=state,
        p_actual=p_actual,
        p_cmd=p_cmd,
        temp_probe_k=temp_k,
        dep_pa=sim_dep,
        target_flame=round(380.0 + p_actual * 30.0, 1),
        target_dep=round(2.3 + p_actual * 0.18, 1),
    )

    sim_raw_buf = _build_sim_raw_buffer(
        r_val=r_val,
        now=now,
        state=state,
        cmd_on=cmd_on,
        p_cmd=p_cmd,
        p_actual=p_actual,
        standby_en=standby_en,
        fun_pwf=fun_pwf,
        temp_amb=temp_amb,
        sp_amb=sp_amb,
        temp_fumes=temp_fumes,
        temp_k=temp_k,
        rpm=rpm,
        sim_dep=sim_dep,
        vent_front_actual=vent_front_actual,
        duct_left_actual=duct_left_actual,
        duct_right_actual=duct_right_actual,
    )

    record: dict[str, Any] = {c: 0 for c in TELEMETRY_COLUMNS.keys() if c != "id"}
    record.update({
        "timestamp": now_str,
        "epoch": now_epoch,
        "comm_mode": comm_mode,
        "status_code": state,
        "status_label": STOVE_STATES.get(state, "TRAVAIL"),
        "status_managed": cmd_on,
        "alarm_code": 0,
        "alarm_label": "Aucune (____)",
        "temp_ambient": temp_amb,
        "temp_amb_setpoint": sp_amb,
        "temp_fumes": temp_fumes,
        "temp_probe_k": temp_k,
        "temp_board_ntc": None,
        "exhaust_rpm": rpm,
        "exhaust_target_rpm": None,
        "depression_pa": sim_dep,
        "flame_light_idx": None,
        "glow_plug_on": 1 if state in (2, 3, 4) else 0,
        "power_level": p_cmd,
        "power_actual": p_actual,
        "fun_auto_set": fun_auto,
        "standby_enabled": standby_en,
        "fun_pwf_set": fun_pwf,
        "set_silece_set": _is_app_silence_active(settings),
        "fan_front_speed": fan_front_cmd,
        "vent_front_actual": vent_front_actual,
        "duct_left_temp": float(r_val.get("duct_left_setpoint", 20.0)),
        "duct_left_setpoint": float(r_val.get("duct_left_setpoint", 20.0)),
        "duct_left_speed": duct_left_cmd,
        "duct_left_actual": duct_left_actual,
        "duct_right_temp": float(r_val.get("duct_right_setpoint", 20.0)),
        "duct_right_setpoint": float(r_val.get("duct_right_setpoint", 20.0)),
        "duct_right_speed": duct_right_cmd,
        "duct_right_actual": duct_right_actual,
        **extract_chrono_fields(r_val),
        "stove_clock_str": stove_clock_str,
        "auger_on_time_s": None,
        "auger_cycle_s": None,
        "auger_duty_pct": None,
        "pellet_rate_kgh": rate_kgh,
        "pellet_hopper_pct": hopper,
        "pellet_daily_kg": daily_kg,
        "trim_pellet_pct": int(r_val.get("trim_pellet_pct", 0)),
        "trim_exhaust_pct": int(r_val.get("trim_exhaust_pct", 0)),
        "cat_service_hours": float(r_val.get("cat_service_hours", 1420.0)),
        "total_work_hours": round(float(prev.get("total_work_hours", 2840.5)) + work_dt_h, 2),
        "ignitions_count": ignitions,
        "weather_temp_ext": weather["weather_temp_ext"],
        "weather_humidity": weather["weather_humidity"],
        "weather_wind_kmh": weather["weather_wind_kmh"],
        "runway_days_est": runway_days,
        "flame_delta_avg": flame_delta_avg,
        "dep_delta_avg": dep_delta_avg,
        "raw_buffer_json": json.dumps(sim_raw_buf),
    })
    return record
