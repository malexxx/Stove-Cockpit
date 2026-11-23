"""
Package base de données SQLite multi-bases pour Nobis.Supervisor.
Regroupe connexions/sessions, migrations, journaux applicatifs/conteneur et seeder simulation.
"""
from config import DATA_DIR, MODE_DB_PATHS, SYSTEM_DB_PATH
from database.connection import (
    DASHBOARD_SERIES_COLUMNS,
    TELEMETRY_RANGE_DURATIONS,
    db_session,
    get_active_mode,
    get_db,
    get_latest_telemetry,
    get_public_settings_dict,
    get_registers_dict,
    get_rolling_consumption_stats,
    get_settings_dict,
    get_sys_db,
    invalidate_settings_cache,
    prune_database_retention,
    query_dashboard_series_range,
    query_telemetry_range,
    read_registers_from_conn,
    reset_db_caches,
    sys_db_session,
)
from database.logs import add_container_log, db_log, get_container_logs
from database.migrations import _ensure_mode_tables, init_all_databases
from database.secrets import (
    ENC_PREFIX,
    SENSITIVE_SETTING_KEYS,
    decrypt_secret,
    decrypt_setting_value,
    encrypt_secret,
    encrypt_setting_value,
    is_encrypted_secret,
    migrate_plaintext_secrets,
    reset_secret_key_cache,
)
from database.seeder import seed_simulation_db_if_empty

_DB_INITIALIZED = False

__all__ = [
    "DATA_DIR",
    "SYSTEM_DB_PATH",
    "MODE_DB_PATHS",
    "_DB_INITIALIZED",
    "TELEMETRY_RANGE_DURATIONS",
    "DASHBOARD_SERIES_COLUMNS",
    "invalidate_settings_cache",
    "reset_db_caches",
    "read_registers_from_conn",
    "query_dashboard_series_range",
    "ENC_PREFIX",
    "SENSITIVE_SETTING_KEYS",
    "is_encrypted_secret",
    "encrypt_secret",
    "decrypt_secret",
    "encrypt_setting_value",
    "decrypt_setting_value",
    "migrate_plaintext_secrets",
    "reset_secret_key_cache",
    "get_sys_db",
    "sys_db_session",
    "get_settings_dict",
    "get_public_settings_dict",
    "get_active_mode",
    "get_db",
    "db_session",
    "get_registers_dict",
    "get_latest_telemetry",
    "query_telemetry_range",
    "prune_database_retention",
    "get_rolling_consumption_stats",
    "_ensure_mode_tables",
    "init_all_databases",
    "db_log",
    "add_container_log",
    "get_container_logs",
    "seed_simulation_db_if_empty",
]
