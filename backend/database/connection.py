"""Connexions SQLite multi-bases, cache settings, sessions contextmanager et requêtes télémétrie."""
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
import os
import sqlite3
import threading
import time
from typing import Any

from config import DOCKER_VERSION
from database.secrets import decrypt_setting_value

TELEMETRY_RANGE_DURATIONS: dict[str, int] = {
    "3h": 3 * 3600,
    "6h": 6 * 3600,
    "24h": 24 * 3600,
    "7j": 7 * 86400,
    "30j": 30 * 86400,
    "3M": 90 * 86400,
}

# Colonnes projetées pour les courbes et rubans du dashboard (exclut raw_buffer_json et ~50 colonnes inutilisées)
DASHBOARD_SERIES_COLUMNS: tuple[str, ...] = (
    "epoch",
    "timestamp",
    "comm_mode",
    "status_code",
    "status_label",
    "temp_ambient",
    "temp_amb_setpoint",
    "weather_temp_ext",
    "duct_left_temp",
    "duct_left_setpoint",
    "duct_right_temp",
    "duct_right_setpoint",
    "temp_fumes",
    "temp_probe_k",
    "power_actual",
    "power_level",
    "depression_pa",
    "flame_delta_avg",
    "exhaust_rpm",
    "fan_front_speed",
    "duct_left_speed",
    "duct_right_speed",
    "trim_pellet_pct",
    "trim_exhaust_pct",
    "pellet_hopper_pct",
    "pellet_rate_kgh",
    "glow_plug_on",
    "auger_on_time_s",
    "fun_auto_set",
    "standby_enabled",
    "fun_pwf_set",
    "set_silece_set",
    "popup_door_open",
    "popup_pa_fault",
    "popup_tck_fault",
    "popup_tcj_fault",
    "blackout_popup",
    "thermostat_main",
    "thermostat_sx",
    "thermostat_dx",
    "popup_pellet_open",
    "popup_pellet_empty",
)
_DASHBOARD_SERIES_SELECT_SQL = (
    ", ".join(DASHBOARD_SERIES_COLUMNS)
    + ", CASE WHEN raw_buffer_json IS NULL OR raw_buffer_json = '{}' THEN 0 ELSE 1 END AS has_raw_buffer"
)

_secured_sys_db_paths: set[str] = set()
_wal_initialized_paths: set[str] = set()
_settings_cache_lock = threading.RLock()
_settings_cache: dict[str, Any] = {"sig": None, "data": None}


def invalidate_settings_cache() -> None:
    """Invalide le cache mémoire des paramètres système (appelé automatiquement au commit SQLite)."""
    with _settings_cache_lock:
        _settings_cache["sig"] = None
        _settings_cache["data"] = None


def reset_db_caches() -> None:
    """Réinitialise les caches mémoire SQLite (settings, état WAL et chmod) après une restauration."""
    invalidate_settings_cache()
    _wal_initialized_paths.clear()
    _secured_sys_db_paths.clear()


def _file_stat_sig(path: str) -> tuple[int, int] | None:
    try:
        st = os.stat(path)
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


def _system_db_signature(db_path: str) -> tuple[Any, ...]:
    return (
        db_path,
        _file_stat_sig(db_path),
        _file_stat_sig(f"{db_path}-wal"),
        os.environ.get("NOBIS_SECRET_KEY", ""),
    )


class _SystemDbConnection(sqlite3.Connection):
    """Connexion SQLite système invalidant automatiquement le cache settings à chaque commit."""

    def commit(self) -> None:
        """Valide la transaction et purge le cache mémoire des paramètres système."""
        super().commit()
        invalidate_settings_cache()


def get_sys_db() -> sqlite3.Connection:
    """Ouvre une connexion SQLite vers la base système globale (WAL, synchronous=NORMAL, permissions 0600)."""
    import database as _db_pkg

    db_path = _db_pkg.SYSTEM_DB_PATH
    conn = sqlite3.connect(
        db_path,
        timeout=30.0,
        check_same_thread=False,
        factory=_SystemDbConnection,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA synchronous=NORMAL;")
    if db_path not in _wal_initialized_paths or not os.path.isfile(db_path):
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        _wal_initialized_paths.add(db_path)
    if db_path not in _secured_sys_db_paths and os.name != "nt":
        try:
            os.chmod(db_path, 0o600)
            _secured_sys_db_paths.add(db_path)
        except OSError:
            pass
    return conn


@contextmanager
def sys_db_session() -> Iterator[sqlite3.Connection]:
    """Gestionnaire de contexte pour la base système avec commit/rollback automatique."""
    conn = get_sys_db()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def get_settings_dict() -> dict[str, str]:
    """Charge l'intégralité des paramètres système (cache mémoire invalidé sur commit et mtime WAL)."""
    import database as _db_pkg

    db_path = _db_pkg.SYSTEM_DB_PATH
    sig = _system_db_signature(db_path)
    with _settings_cache_lock:
        if _settings_cache["data"] is not None and _settings_cache["sig"] == sig:
            return dict(_settings_cache["data"])

    conn = get_sys_db()
    try:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        data = {r["key"]: decrypt_setting_value(r["key"], r["value"]) for r in rows}
    finally:
        conn.close()

    sig_after = _system_db_signature(db_path)
    with _settings_cache_lock:
        _settings_cache["sig"] = sig_after
        _settings_cache["data"] = data
    return dict(data)


def get_public_settings_dict() -> dict[str, str]:
    """Retourne les paramètres système en masquant les données sensibles (mot de passe Agua Cloud, jeton API)."""
    s = get_settings_dict()
    if "agua_password" in s:
        s["agua_password"] = "********" if s["agua_password"] else ""
    if "container_api_token" in s:
        s["container_api_token"] = "********" if s["container_api_token"] else ""
    s["docker_version"] = DOCKER_VERSION
    return s


def get_active_mode() -> str:
    """Détermine le mode de communication actif ('agua_cloud', 'local_gateway' ou 'simulation')."""
    import database as _db_pkg

    try:
        s = get_settings_dict()
        m = s.get("comm_mode", "simulation")
        return m if m in _db_pkg.MODE_DB_PATHS else "simulation"
    except Exception:
        return "simulation"


def get_db(mode: str | None = None) -> sqlite3.Connection:
    """Ouvre une connexion SQLite vers la base de données du mode de communication ciblé."""
    import database as _db_pkg

    if not _db_pkg._DB_INITIALIZED:
        _db_pkg.init_all_databases()
    target_mode = mode if (mode and mode in _db_pkg.MODE_DB_PATHS) else get_active_mode()
    db_file = _db_pkg.MODE_DB_PATHS.get(target_mode, _db_pkg.MODE_DB_PATHS["simulation"])
    conn = sqlite3.connect(db_file, timeout=30.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA synchronous=NORMAL;")
    if db_file not in _wal_initialized_paths or not os.path.isfile(db_file):
        conn.execute("PRAGMA journal_mode=WAL;")
        _wal_initialized_paths.add(db_file)
    return conn


@contextmanager
def db_session(mode: str | None = None) -> Iterator[sqlite3.Connection]:
    """Gestionnaire de contexte pour la base du mode actif avec commit/rollback automatique."""
    conn = get_db(mode)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def read_registers_from_conn(conn: sqlite3.Connection) -> dict[str, dict[str, Any]]:
    """Lit le catalogue des registres depuis une connexion SQLite déjà ouverte."""
    rows = conn.execute("SELECT * FROM registers_catalog").fetchall()
    return {r["reg_key"]: dict(r) for r in rows}


def get_registers_dict(mode: str | None = None) -> dict[str, dict[str, Any]]:
    """Retourne l'intégralité du catalogue des registres indexé par reg_key."""
    conn = get_db(mode)
    try:
        return read_registers_from_conn(conn)
    finally:
        conn.close()


def get_latest_telemetry(mode: str | None = None) -> dict[str, Any]:
    """Retourne le dernier enregistrement de télémétrie sous forme de dictionnaire (ou {} si vide)."""
    conn = get_db(mode)
    try:
        row = conn.execute("SELECT * FROM telemetry ORDER BY epoch DESC LIMIT 1").fetchone()
        return dict(row) if row else {}
    finally:
        conn.close()


def query_telemetry_range(
    conn: sqlite3.Connection,
    mode: str,
    range_key: str = "24h",
    order: str = "ASC",
) -> list[sqlite3.Row]:
    """Interroge les séries complètes de télémétrie sur la fenêtre demandée avec filtrage Agua Cloud unifié."""
    now_epoch = int(time.time())
    min_epoch = now_epoch - TELEMETRY_RANGE_DURATIONS.get(range_key, 86400)
    order_sql = "DESC" if str(order).upper() == "DESC" else "ASC"
    if mode == "agua_cloud":
        return conn.execute(
            f"""
            SELECT * FROM telemetry
            WHERE epoch >= ?
              AND NOT (status_code != -1 AND (raw_buffer_json = '{{}}' OR raw_buffer_json IS NULL))
            ORDER BY epoch {order_sql}
            """,
            (min_epoch,),
        ).fetchall()
    return conn.execute(
        f"SELECT * FROM telemetry WHERE epoch >= ? ORDER BY epoch {order_sql}",
        (min_epoch,),
    ).fetchall()


def query_dashboard_series_range(
    conn: sqlite3.Connection,
    mode: str,
    range_key: str = "24h",
    order: str = "ASC",
) -> list[sqlite3.Row]:
    """Projette uniquement les colonnes graphiques/rubans du dashboard (exclut raw_buffer_json)."""
    now_epoch = int(time.time())
    min_epoch = now_epoch - TELEMETRY_RANGE_DURATIONS.get(range_key, 86400)
    order_sql = "DESC" if str(order).upper() == "DESC" else "ASC"
    if mode == "agua_cloud":
        return conn.execute(
            f"""
            SELECT {_DASHBOARD_SERIES_SELECT_SQL} FROM telemetry
            WHERE epoch >= ?
              AND NOT (status_code != -1 AND (raw_buffer_json = '{{}}' OR raw_buffer_json IS NULL))
            ORDER BY epoch {order_sql}
            """,
            (min_epoch,),
        ).fetchall()
    return conn.execute(
        f"SELECT {_DASHBOARD_SERIES_SELECT_SQL} FROM telemetry WHERE epoch >= ? ORDER BY epoch {order_sql}",
        (min_epoch,),
    ).fetchall()


def prune_database_retention(
    comm_mode: str | None = None,
    retention_days: int = 95,
    max_logs: int = 5000,
    max_audit: int = 5000,
) -> None:
    """Nettoyage périodique des données historiques (télémétrie 95j, logs 5000, audit commandes 5000)."""
    active_m = comm_mode or get_active_mode()
    retention_cutoff = int(datetime.now().timestamp()) - (retention_days * 86400)
    conn = get_db(active_m)
    try:
        conn.execute("DELETE FROM telemetry WHERE epoch < ?", (retention_cutoff,))
        conn.execute(
            "DELETE FROM app_logs WHERE id NOT IN (SELECT id FROM app_logs ORDER BY id DESC LIMIT ?)",
            (max_logs,),
        )
        conn.execute(
            "DELETE FROM command_audit WHERE id NOT IN (SELECT id FROM command_audit ORDER BY id DESC LIMIT ?)",
            (max_audit,),
        )
        conn.commit()
    finally:
        conn.close()


def get_rolling_consumption_stats(conn: sqlite3.Connection, ref_epoch: int | None = None) -> dict[str, float]:
    """Calcule en une seule passe SQL la consommation cumulée de granulés (kg) sur 7 et 30 jours glissants."""
    if ref_epoch is None:
        ref_epoch = int(time.time())

    min_epoch_7d = ref_epoch - (7 * 86400)
    min_epoch_30d = ref_epoch - (30 * 86400)
    row = conn.execute(
        """
        SELECT
            COALESCE(SUM(CASE WHEN max_ep >= ? THEN daily_max ELSE 0.0 END), 0.0) AS conso_7d,
            COALESCE(SUM(daily_max), 0.0) AS conso_30d
        FROM (
            SELECT
                substr(timestamp, 1, 10) AS d,
                MAX(COALESCE(pellet_daily_kg, 0.0)) AS daily_max,
                MAX(epoch) AS max_ep
            FROM telemetry
            WHERE epoch >= ?
            GROUP BY d
        )
        """,
        (min_epoch_7d, min_epoch_30d),
    ).fetchone()
    conso_week_kg = round(float(row[0]) if row else 0.0, 1)
    conso_month_kg = round(float(row[1]) if row else 0.0, 1)
    conso_month_kg = max(conso_month_kg, conso_week_kg)
    return {
        "conso_week_kg": conso_week_kg,
        "conso_month_kg": conso_month_kg,
    }
