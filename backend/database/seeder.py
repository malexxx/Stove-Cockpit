"""Seeder de l'historique réaliste sur 30 jours pour la base du mode simulation."""
from datetime import datetime, timedelta
import json
import math
import random

from config import HOPPER_CAPACITY_KG, STOVE_STATES, TELEMETRY_COLUMNS
from database.connection import get_db
from database.logs import db_log


def seed_simulation_db_if_empty() -> None:
    """Peuple la base du mode simulation avec 30 jours d'historique réaliste si elle est vide."""
    conn = get_db("simulation")
    try:
        count = conn.execute("SELECT COUNT(*) as c FROM telemetry").fetchone()["c"]
        if count > 0:
            return

        now = datetime.now()
        timestamps: list[datetime] = []
        t_cursor = now - timedelta(days=30)
        cutoff_high_res = now - timedelta(hours=24)
        while t_cursor < cutoff_high_res:
            timestamps.append(t_cursor)
            t_cursor += timedelta(minutes=15)
        while t_cursor <= now:
            timestamps.append(t_cursor)
            t_cursor += timedelta(minutes=2)

        hopper = 92.0
        daily_kg = 0.0
        last_day = timestamps[0].day
        cols = [c for c in TELEMETRY_COLUMNS.keys() if c != "id"]
        placeholders = ", ".join(["?"] * len(cols))
        batch_rows = []

        for dt in timestamps:
            if dt.day != last_day:
                daily_kg = 0.0
                last_day = dt.day
            hour_dec = dt.hour + dt.minute / 60.0
            day_offset = (now - dt).total_seconds() / 86400.0
            ext_temp = round(8.5 + 4.2 * math.sin((hour_dec - 9.0) * math.pi / 12.0) + 2.5 * math.sin(day_offset * 0.4), 1)
            humidity = round(max(45.0, min(96.0, 78.0 - 15.0 * math.sin((hour_dec - 9.0) * math.pi / 12.0))), 1)
            wind_kmh = round(max(4.0, 14.0 + 6.0 * math.sin(day_offset * 0.8)), 1)

            active_heat = (6.5 <= hour_dec <= 9.5) or (17.5 <= hour_dec <= 22.5)
            state = 5 if active_heat else 8
            p_actual = 4 if active_heat else 0

            if active_heat:
                temp_fumes = round(101.0 + (p_actual - 1) * 11.15 + random.uniform(-3.0, 3.0), 1)
                temp_k = round(380.0 + p_actual * 30.0 + random.uniform(-8.0, 8.0), 1)
                rpm = int(round((1420.0 + p_actual * 70.0 + random.uniform(-20.0, 20.0)) / 10.0) * 10)
                dep_pa = round(2.3 + p_actual * 0.18 + random.uniform(-0.15, 0.15), 1)
                rate_kgh = round(0.86 + (p_actual - 1) * (1.30 / 6.0), 2)
                vent_front_act = min(8, max(2, p_actual + 1))
            else:
                temp_fumes = round(ext_temp + 15.0, 1)
                temp_k = round(ext_temp + 18.0, 1)
                rpm = 0
                dep_pa = 0.1
                rate_kgh = 0.0
                vent_front_act = 0

            temp_amb = round(19.5 + (1.2 if active_heat else -0.6) + random.uniform(-0.2, 0.2), 1)
            dt_h = (15.0 / 60.0) if dt < cutoff_high_res else (2.0 / 60.0)
            consumed_kg = rate_kgh * dt_h
            daily_kg = round(daily_kg + consumed_kg, 2)

            hopper = round(max(10.0, hopper - (consumed_kg / HOPPER_CAPACITY_KG) * 100.0), 1)
            if hopper <= 12.0:
                hopper = 98.0

            sim_raw_buf = {
                "0": round(temp_k, 1),
                "2": round(temp_fumes, 1),
                "8": state,
                "11": p_actual,
                "16": vent_front_act,
                "22": 64,
                "28": 40,
                "29": 40,
                "31": 0,
                "32": 0,
                "34": 0,
                "37": int(round(dep_pa * 10.0)),
                "40": 0,
                "47": int(round(rpm / 10.0)),
                "70": 0,
                "71": 0,
                "103": round(temp_amb, 1),
                "105": 18479,
                "107": 2,
                "115": 0,
                "232": 85,
                "33120": 4,
                "33122": 19,
                "33124": 20,
                "33126": 20,
                "33128": 1,
                "33132": 8,
                "33134": 0,
                "33136": 0,
                "33154": 0,
                "33162": 0,
                "34048": dt.hour,
                "34049": dt.minute,
                "34050": dt.day,
                "34051": dt.month,
                "34052": dt.year - 2000,
                "34053": dt.isoweekday(),
            }

            row_data = {c: None for c in cols}
            row_data.update({
                "timestamp": dt.strftime("%Y-%m-%d %H:%M:%S"),
                "epoch": int(dt.timestamp()),
                "comm_mode": "simulation",
                "status_code": state,
                "status_label": STOVE_STATES.get(state, "TRAVAIL"),
                "status_managed": 85,
                "alarm_code": 0,
                "alarm_label": "Aucune (____)",
                "blackout_popup": 0,
                "popup_flags": 0,
                "popup_door_open": 0,
                "popup_pellet_empty": 0,
                "popup_pellet_open": 0,
                "popup_pa_fault": 0,
                "popup_tcj_fault": 0,
                "popup_tck_fault": 0,
                "temp_ambient": temp_amb,
                "temp_amb_setpoint": 19.0,
                "temp_fumes": temp_fumes,
                "temp_probe_k": temp_k,
                "temp_board_ntc": None,
                "exhaust_rpm": rpm,
                "exhaust_target_rpm": None,
                "depression_pa": dep_pa,
                "flame_light_idx": None,
                "glow_plug_on": 0,
                "power_level": 4,
                "power_actual": p_actual,
                "fun_auto_set": 1,
                "standby_enabled": 0,
                "fun_pwf_set": 0,
                "set_silece_set": 0,
                "fan_front_speed": 8,
                "vent_front_actual": vent_front_act,
                "duct_left_temp": 20.0,
                "duct_left_setpoint": 20.0,
                "duct_left_speed": 0,
                "duct_left_actual": 0,
                "duct_right_temp": 20.0,
                "duct_right_setpoint": 20.0,
                "duct_right_speed": 0,
                "duct_right_actual": 0,
                "thermostat_flags": 64,
                "thermostat_main": 0,
                "thermostat_dx": 0,
                "thermostat_sx": 0,
                "enable_mask_105": 18479,
                "enable_mask_107": 2,
                "chrono_week_enable": 0,
                "chrono_p1_start": 48,
                "chrono_p1_stop": 63,
                "chrono_p1_days": 127,
                "chrono_p1_power": 7,
                "chrono_p1_temp": 19.0,
                "chrono_p2_start": 126,
                "chrono_p2_stop": 138,
                "chrono_p2_days": 127,
                "chrono_p2_power": 7,
                "chrono_p2_temp": 19.0,
                "chrono_p3_start": 144,
                "chrono_p3_stop": 144,
                "chrono_p3_days": 0,
                "chrono_p3_power": 7,
                "chrono_p3_temp": 20.0,
                "chrono_p4_start": 144,
                "chrono_p4_stop": 144,
                "chrono_p4_days": 0,
                "chrono_p4_power": 7,
                "chrono_p4_temp": 20.0,
                "stove_clock_str": dt.strftime("%H:%M %d/%m/%Y"),
                "auger_on_time_s": None,
                "auger_cycle_s": None,
                "auger_duty_pct": None,
                "pellet_rate_kgh": rate_kgh,
                "pellet_hopper_pct": hopper,
                "pellet_daily_kg": daily_kg,
                "trim_pellet_pct": 0,
                "trim_exhaust_pct": 0,
                "cat_service_hours": 1420.0,
                "total_work_hours": 2840.0,
                "ignitions_count": 612,
                "weather_temp_ext": ext_temp,
                "weather_humidity": humidity,
                "weather_wind_kmh": wind_kmh,
                "runway_days_est": 15.0,
                "flame_delta_avg": round(temp_k - (380.0 + p_actual * 30.0), 1) if active_heat else 0.0,
                "dep_delta_avg": round(dep_pa - (2.3 + p_actual * 0.18), 1) if active_heat else 0.0,
                "raw_buffer_json": json.dumps(sim_raw_buf),
            })
            batch_rows.append(tuple(row_data[c] for c in cols))

        conn.executemany(f"INSERT INTO telemetry ({', '.join(cols)}) VALUES ({placeholders})", batch_rows)
        conn.commit()
    finally:
        conn.close()
    db_log(
        "INFO",
        "SEEDER",
        f"Base simulation initialisée avec {len(batch_rows)} points (30j, réservoir certifié {int(HOPPER_CAPACITY_KG)} kg).",
        "simulation",
    )
