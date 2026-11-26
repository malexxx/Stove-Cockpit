"""Configuration globale, chargement des schémas partagés Micronova, chemins SQLite/statiques et constantes métier."""
import json
import os
import re
import sys
from typing import Any

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(BASE_DIR)


def _resolve_shared_dir() -> str:
    candidates = [
        os.path.join(REPO_ROOT, "shared"),
        os.path.join(BASE_DIR, "shared"),
        "/app/shared",
    ]
    for p in candidates:
        if os.path.isdir(p):
            return p
    return os.path.join(REPO_ROOT, "shared")


SHARED_DIR = _resolve_shared_dir()


def _load_json_file(path: str, fallback: dict[str, Any]) -> dict[str, Any]:
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
            if isinstance(data, dict):
                return data
    return fallback


BRANDS_DATA: dict[str, Any] = _load_json_file(os.path.join(SHARED_DIR, "brands.json"), {"brands": []})
BRANDS_CATALOG: list[dict[str, Any]] = list(BRANDS_DATA.get("brands", []))
BRANDS_BY_ID: dict[str, dict[str, Any]] = {
    str(b["id"]): b for b in BRANDS_CATALOG if isinstance(b, dict) and b.get("id")
}

MICRONOVA_SCHEMA: dict[str, Any] = _load_json_file(
    os.path.join(SHARED_DIR, "micronova_schema.json"),
    {},
)

_DEFAULT_DATA_DIR = (
    "/app/data"
    if os.path.isdir("/app/data") and not sys.platform.startswith("win")
    else (
        os.path.join(BASE_DIR, "data")
        if os.path.isdir(os.path.join(BASE_DIR, "data"))
        else os.path.join(REPO_ROOT, "data")
    )
)


def resolve_data_dir(db_path_env: str, default_data_dir: str = _DEFAULT_DATA_DIR) -> str:
    """Résout le répertoire persistant DATA_DIR depuis DB_PATH (fichier .db ou dossier)."""
    raw = (db_path_env or "").strip()
    if not raw:
        return default_data_dir
    if raw.endswith(("/", "\\")) or os.path.isdir(raw):
        candidate = os.path.normpath(raw)
    elif os.path.isabs(raw) and not os.path.splitext(os.path.basename(raw))[1]:
        candidate = os.path.normpath(raw)
    else:
        candidate = os.path.dirname(raw)
    if not candidate or candidate == os.path.dirname(candidate):
        return default_data_dir
    return candidate


DATA_DIR = resolve_data_dir(os.environ.get("DB_PATH", ""), _DEFAULT_DATA_DIR)
os.makedirs(DATA_DIR, exist_ok=True)


def _resolve_frontend_dist_dir() -> str:
    candidates = [
        os.environ.get("STOVE_FRONTEND_DIST", "").strip(),
        os.path.join(BASE_DIR, "frontend_dist"),
        "/app/frontend_dist",
        os.path.join(REPO_ROOT, "frontend", "dist"),
        os.path.join(BASE_DIR, "static"),
    ]
    for p in candidates:
        if p and os.path.isdir(p):
            return p
    return os.path.join(REPO_ROOT, "frontend", "dist")


FRONTEND_DIST_DIR = _resolve_frontend_dist_dir()
STATIC_DIR = FRONTEND_DIST_DIR


def _parse_ver_tuple(ver: str) -> tuple[int, ...]:
    m = re.match(r"^v?(\d+(?:\.\d+)*)", (ver or "").strip())
    return tuple(int(p) for p in m.group(1).split(".")) if m else (0,)


def _ver_lt(v1: str, v2: str) -> bool:
    t1, t2 = _parse_ver_tuple(v1), _parse_ver_tuple(v2)
    n = max(len(t1), len(t2))
    return t1 + (0,) * (n - len(t1)) < t2 + (0,) * (n - len(t2))


def _resolve_app_version(code_version: str) -> str:
    """Résout APP_VERSION en ignorant une variable d'env figée inférieure au code embarqué."""
    env_ver = os.environ.get("APP_VERSION", "").strip()
    if not env_ver:
        return code_version
    if not os.environ.get("NOBIS_ACTIVE_RELEASE_ID", "").strip() and _ver_lt(env_ver, code_version):
        return code_version
    return env_ver


def _resolve_docker_version(app_version: str) -> str:
    """Résout DOCKER_VERSION en garantissant un libellé cohérent avec app_version."""
    default_dv = f"v{app_version}" if not app_version.startswith("v") else app_version
    env_dv = os.environ.get("DOCKER_VERSION", "").strip()
    if not env_dv:
        return default_dv
    if not os.environ.get("NOBIS_ACTIVE_RELEASE_ID", "").strip() and _ver_lt(env_dv, app_version):
        return default_dv
    return env_dv


APP_VERSION: str = _resolve_app_version("0.0.91")
DOCKER_VERSION: str = _resolve_docker_version(APP_VERSION)

SYSTEM_DB_PATH = os.path.join(DATA_DIR, "nobis_a10_system.db")
MODE_DB_PATHS: dict[str, str] = {
    "simulation": os.path.join(DATA_DIR, "nobis_a10_simulation.db"),
    "agua_cloud": os.path.join(DATA_DIR, "nobis_a10_agua_cloud.db"),
    "local_gateway": os.path.join(DATA_DIR, "nobis_a10_local_gateway.db"),
}

HOPPER_CAPACITY_KG: float = float(MICRONOVA_SCHEMA.get("nobis_hopper_capacity_kg", 35.0))
DEFAULT_GENERIC_HOPPER_KG: float = float(MICRONOVA_SCHEMA.get("default_hopper_capacity_kg", 25.0))
PELLET_BAG_WEIGHT_KG: float = float(MICRONOVA_SCHEMA.get("pellet_bag_weight_kg", 15.0))


def get_hopper_capacity_kg(settings: dict[str, str] | None = None) -> float:
    """Retourne la capacité configurée de la trémie en kg (avec repli marque Nobis=35 kg, générique=25 kg)."""
    if settings:
        raw = str(settings.get("hopper_capacity_kg") or "").strip()
        if raw:
            try:
                val = float(raw)
                if 5.0 <= val <= 500.0:
                    return val
            except ValueError:
                pass
        brand_id = str(settings.get("agua_brand") or "nobis").strip().lower()
        return HOPPER_CAPACITY_KG if brand_id == "nobis" else DEFAULT_GENERIC_HOPPER_KG
    return HOPPER_CAPACITY_KG


STOVE_STATES: dict[int, str] = {
    int(k): v for k, v in (MICRONOVA_SCHEMA.get("stove_states") or {}).items()
} or {
    0: "OFF (Éteint)",
    1: "ATTENTE (Check-up)",
    2: "DÉBUT (Préchauffage)",
    3: "DÉBUT (Chargement pellet)",
    4: "DÉBUT (Allumage flamme)",
    5: "TRAVAIL (Normal)",
    6: "NETTOYAGE BRASIER",
    7: "ARRÊT (Refroidissement)",
    8: "ECO STOP (Stand-by actif)",
    9: "STAND BY",
    10: "ALARME SÉCURITÉ",
    11: "MÉMOIRE ALARME",
}

NOBIS_ALARMS: dict[int, str] = {
    int(k): v for k, v in (MICRONOVA_SCHEMA.get("nobis_alarms") or {}).items()
} or {0: "Aucune (____)"}

_CANONICAL_ALIASES = MICRONOVA_SCHEMA.get("canonical_key_aliases") or {}
AGUA_REG_KEY_ALIASES: dict[str, list[str]] = {
    "status_code": list(_CANONICAL_ALIASES.get("status_code", ["status_managed_get", "status_managed", "power_on_off"])),
    "power_level": list(_CANONICAL_ALIASES.get("power_level", ["power_set"])),
    "temp_amb_setpoint": list(_CANONICAL_ALIASES.get("temp_amb_setpoint", ["temp_air_set"])),
    "fan_front_speed": list(_CANONICAL_ALIASES.get("fan_front_speed", ["vent_front_set"])),
    "duct_left_setpoint": list(_CANONICAL_ALIASES.get("duct_left_setpoint", ["canalization_sx_temp_air_set", "can_sx_temp_set", "temp_can_sx_set"])),
    "duct_left_speed": list(_CANONICAL_ALIASES.get("duct_left_speed", ["canalization_sx_set", "can_sx_vent_set", "vent_can_sx_set"])),
    "duct_right_setpoint": list(_CANONICAL_ALIASES.get("duct_right_setpoint", ["canalization_dx_temp_air_set", "can_dx_temp_set", "temp_can_dx_set"])),
    "duct_right_speed": list(_CANONICAL_ALIASES.get("duct_right_speed", ["canalization_dx_set", "can_dx_vent_set", "vent_can_dx_set"])),
    "fun_auto_set": list(_CANONICAL_ALIASES.get("fun_auto_set", ["fun_auto_set", "auto_mode_set", "modulation_auto_set", "auto_set"])),
    "fun_auto_get": list(_CANONICAL_ALIASES.get("fun_auto_get", ["fun_auto_get", "auto_mode_get", "auto_get", "modulation_auto_get", "enable_auto_get"])),
    "fun_pwf_set": list(_CANONICAL_ALIASES.get("fun_pwf_set", ["fun_pwf_set", "powerful_set", "enable_pwf_set", "boost_set"])),
    "fun_pwf_get": list(_CANONICAL_ALIASES.get("fun_pwf_get", ["fun_pwf_get", "powerful_get", "enable_pwf_get", "boost_get"])),
    "standby_set": list(_CANONICAL_ALIASES.get("standby_set", ["standby_set", "eco_mode_set", "energy_saving_set", "comfort_clima_set", "clima_confort_set"])),
    "standby_get": list(_CANONICAL_ALIASES.get("standby_get", ["standby_get", "eco_mode_get", "energy_saving_get", "comfort_clima_get", "clima_confort_get"])),
    "comfortclima_time_set": list(_CANONICAL_ALIASES.get("comfortclima_time_set", ["comfortclima_time_set"])),
    "comfortclima_restart_set": list(_CANONICAL_ALIASES.get("comfortclima_restart_set", ["comfortclima_restart_set"])),
    "chrono_week_enable_set": list(_CANONICAL_ALIASES.get("chrono_week_enable_set", ["chrono_week_enable_set", "chrono_enable_set"])),
}

DEFAULT_REGISTERS_CATALOG: list[dict[str, Any]] = list(MICRONOVA_SCHEMA.get("default_registers_catalog") or [])

TELEMETRY_COLUMNS: dict[str, str] = {
    "id": "INTEGER PRIMARY KEY AUTOINCREMENT",
    "timestamp": "TEXT NOT NULL",
    "epoch": "INTEGER NOT NULL",
    "comm_mode": "TEXT DEFAULT 'agua_cloud'",
    "status_code": "INTEGER DEFAULT 0",
    "status_label": "TEXT DEFAULT 'OFF (Éteint)'",
    "status_managed": "INTEGER DEFAULT 0",
    "alarm_code": "INTEGER DEFAULT 0",
    "alarm_label": "TEXT DEFAULT 'Aucune (____)'",
    "blackout_popup": "INTEGER DEFAULT 0",
    "popup_flags": "INTEGER DEFAULT 0",
    "popup_door_open": "INTEGER DEFAULT 0",
    "popup_pellet_empty": "INTEGER DEFAULT 0",
    "popup_pellet_open": "INTEGER DEFAULT 0",
    "popup_pa_fault": "INTEGER DEFAULT 0",
    "popup_tcj_fault": "INTEGER DEFAULT 0",
    "popup_tck_fault": "INTEGER DEFAULT 0",
    "temp_ambient": "REAL DEFAULT 19.0",
    "temp_amb_setpoint": "REAL DEFAULT 19.0",
    "temp_fumes": "REAL DEFAULT 185.0",
    "temp_probe_k": "REAL DEFAULT 309.0",
    "temp_board_ntc": "REAL DEFAULT NULL",
    "exhaust_rpm": "INTEGER DEFAULT 2200",
    "exhaust_target_rpm": "INTEGER DEFAULT NULL",
    "depression_pa": "REAL DEFAULT 8.3",
    "flame_light_idx": "INTEGER DEFAULT NULL",
    "glow_plug_on": "INTEGER DEFAULT 0",
    "power_level": "INTEGER DEFAULT 4",
    "power_actual": "INTEGER DEFAULT 4",
    "fun_auto_set": "INTEGER DEFAULT 0",
    "standby_enabled": "INTEGER DEFAULT 0",
    "comfortclima_ability_set": "INTEGER DEFAULT NULL",
    "comfortclima_time_set": "INTEGER DEFAULT NULL",
    "comfortclima_restart_set": "INTEGER DEFAULT NULL",
    "fun_pwf_set": "INTEGER DEFAULT 0",
    "set_silece_set": "INTEGER DEFAULT 0",
    "fan_front_speed": "INTEGER DEFAULT 3",
    "vent_front_actual": "INTEGER DEFAULT 2",
    "duct_left_temp": "REAL DEFAULT 20.0",
    "duct_left_setpoint": "REAL DEFAULT 20.0",
    "duct_left_speed": "INTEGER DEFAULT 0",
    "duct_left_actual": "INTEGER DEFAULT 0",
    "duct_right_temp": "REAL DEFAULT 20.0",
    "duct_right_setpoint": "REAL DEFAULT 20.0",
    "duct_right_speed": "INTEGER DEFAULT 0",
    "duct_right_actual": "INTEGER DEFAULT 0",
    "thermostat_flags": "INTEGER DEFAULT 64",
    "thermostat_main": "INTEGER DEFAULT 0",
    "thermostat_dx": "INTEGER DEFAULT 0",
    "thermostat_sx": "INTEGER DEFAULT 0",
    "enable_mask_105": "INTEGER DEFAULT 18479",
    "enable_mask_107": "INTEGER DEFAULT 2",
    "chrono_week_enable": "INTEGER DEFAULT 0",
    "chrono_p1_start": "INTEGER DEFAULT 48",
    "chrono_p1_stop": "INTEGER DEFAULT 63",
    "chrono_p1_days": "INTEGER DEFAULT 127",
    "chrono_p1_power": "INTEGER DEFAULT 7",
    "chrono_p1_temp": "REAL DEFAULT 19.0",
    "chrono_p2_start": "INTEGER DEFAULT 126",
    "chrono_p2_stop": "INTEGER DEFAULT 138",
    "chrono_p2_days": "INTEGER DEFAULT 127",
    "chrono_p2_power": "INTEGER DEFAULT 7",
    "chrono_p2_temp": "REAL DEFAULT 19.0",
    "chrono_p3_start": "INTEGER DEFAULT 144",
    "chrono_p3_stop": "INTEGER DEFAULT 144",
    "chrono_p3_days": "INTEGER DEFAULT 0",
    "chrono_p3_power": "INTEGER DEFAULT 7",
    "chrono_p3_temp": "REAL DEFAULT 20.0",
    "chrono_p4_start": "INTEGER DEFAULT 144",
    "chrono_p4_stop": "INTEGER DEFAULT 144",
    "chrono_p4_days": "INTEGER DEFAULT 0",
    "chrono_p4_power": "INTEGER DEFAULT 7",
    "chrono_p4_temp": "REAL DEFAULT 20.0",
    "stove_clock_str": "TEXT DEFAULT '17:42 01/11/2026'",
    "auger_on_time_s": "REAL DEFAULT NULL",
    "auger_cycle_s": "REAL DEFAULT NULL",
    "auger_duty_pct": "REAL DEFAULT NULL",
    "pellet_rate_kgh": "REAL DEFAULT 1.15",
    "pellet_hopper_pct": "REAL DEFAULT 78.0",
    "pellet_daily_kg": "REAL DEFAULT 8.4",
    "trim_pellet_pct": "INTEGER DEFAULT 0",
    "trim_exhaust_pct": "INTEGER DEFAULT 0",
    "cat_service_hours": "REAL DEFAULT 1420",
    "total_work_hours": "REAL DEFAULT 2840.5",
    "ignitions_count": "INTEGER DEFAULT 612",
    "weather_temp_ext": "REAL DEFAULT 10.7",
    "weather_humidity": "REAL DEFAULT 66.0",
    "weather_wind_kmh": "REAL DEFAULT 13.7",
    "runway_days_est": "REAL DEFAULT 15.0",
    "flame_delta_avg": "REAL DEFAULT 0.0",
    "dep_delta_avg": "REAL DEFAULT 0.0",
    "raw_buffer_json": "TEXT DEFAULT '{}'",
}
