"""Création et migration des schémas SQLite (base système et bases par mode de communication)."""
from datetime import datetime
import logging
import os
import sqlite3
import uuid

from config import DEFAULT_REGISTERS_CATALOG, TELEMETRY_COLUMNS
from database.connection import get_sys_db
from database.secrets import encrypt_setting_value, migrate_plaintext_secrets

logger = logging.getLogger("nobis.migrations")


def _ensure_mode_tables(conn: sqlite3.Connection) -> None:
    """Crée et migre les tables de télémétrie, catalogues et journaux pour un mode donné."""
    cur = conn.cursor()
    cols_sql = ", ".join([f"{k} {v}" for k, v in TELEMETRY_COLUMNS.items()])
    cur.execute(f"CREATE TABLE IF NOT EXISTS telemetry ({cols_sql})")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_telemetry_epoch ON telemetry(epoch)")

    cur.execute("PRAGMA table_info(telemetry)")
    existing_cols = {row["name"] for row in cur.fetchall()}
    for col_name, col_def in TELEMETRY_COLUMNS.items():
        if col_name not in existing_cols:
            cur.execute(f"ALTER TABLE telemetry ADD COLUMN {col_name} {col_def}")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS registers_catalog (
            reg_key TEXT PRIMARY KEY,
            offset INTEGER NOT NULL,
            mem_type TEXT NOT NULL,
            label TEXT NOT NULL,
            unit TEXT,
            min_val REAL,
            max_val REAL,
            step REAL,
            current_val REAL,
            default_val REAL,
            category TEXT,
            updated_at TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS command_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            reg_key TEXT NOT NULL,
            offset INTEGER NOT NULL,
            label TEXT NOT NULL,
            old_value REAL,
            new_value REAL,
            comm_mode TEXT NOT NULL,
            status TEXT NOT NULL,
            details TEXT
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON command_audit(timestamp DESC)")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS app_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            severity TEXT NOT NULL,
            source TEXT NOT NULL,
            message TEXT NOT NULL
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_logs_severity_id ON app_logs(severity, id DESC)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_logs_id ON app_logs(id DESC)")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS registers_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            name TEXT NOT NULL,
            comm_mode TEXT NOT NULL,
            registers_json TEXT NOT NULL,
            raw_buffer_json TEXT NOT NULL
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_snapshots_id ON registers_snapshots(id DESC)")
    conn.commit()


def _build_default_settings() -> dict[str, str]:
    return {
        "comm_mode": "agua_cloud",
        "poll_interval_s": "120",
        "agua_brand": "nobis",
        "agua_api_url": "https://nobis.agua-iot.com",
        "agua_customer_code": "700700",
        "agua_brand_id": "1",
        "agua_brand_header": "",
        "agua_login_api_url": "",
        "agua_email": "",
        "agua_password": "",
        "agua_uuid": str(uuid.uuid4()),
        "agua_id_device": "",
        "agua_id_product": "",
        "stove_name": "",
        "hopper_capacity_kg": "35.0",
        "local_gateway_url": "http://192.168.1.150",
        "weather_city": "Paris (75000)",
        "weather_lat": "48.8566",
        "weather_lon": "2.3522",
        "pellet_bag_price_eur": "4.80",
        "pellet_bags_stock": "40",
        "pellet_bags_used_season": "0",
        "webhook_url": "",
        "matter_enabled": "1",
        "matter_device_name": "Poêle à granulés",
        "matter_port": "5540",
        "matter_passcode": "",
        "matter_discriminator": "",
        "duct_left_name": "SX",
        "duct_right_name": "DX",
        "cockpit_ui_mode": "triarc",
        "container_api_token": "",
    }


def _merge_legacy_db_settings(data_dir: str, default_settings: dict[str, str]) -> None:
    old_db = os.path.join(data_dir, "nobis_a10.db")
    if not os.path.exists(old_db):
        return
    try:
        oconn = sqlite3.connect(old_db)
        try:
            oconn.row_factory = sqlite3.Row
            for r in oconn.execute("SELECT key, value FROM settings").fetchall():
                if r["value"]:
                    default_settings[r["key"]] = r["value"]
        finally:
            oconn.close()
    except Exception as exc:
        logger.debug("Migration base legacy nobis_a10.db ignorée : %s", exc)


def _collect_env_overrides(default_settings: dict[str, str], mode_db_paths: dict[str, str]) -> dict[str, str]:
    env_settings_map = {
        "COMM_MODE": "comm_mode",
        "AGUA_BRAND": "agua_brand",
        "AGUA_API_URL": "agua_api_url",
        "AGUA_CUSTOMER_CODE": "agua_customer_code",
        "AGUA_BRAND_ID": "agua_brand_id",
        "AGUA_BRAND_HEADER": "agua_brand_header",
        "AGUA_LOGIN_API_URL": "agua_login_api_url",
        "AGUA_EMAIL": "agua_email",
        "AGUA_PASSWORD": "agua_password",
        "AGUA_UUID": "agua_uuid",
        "AGUA_ID_DEVICE": "agua_id_device",
        "AGUA_ID_PRODUCT": "agua_id_product",
        "HOPPER_CAPACITY_KG": "hopper_capacity_kg",
        "LOCAL_GATEWAY_URL": "local_gateway_url",
    }
    env_overrides: dict[str, str] = {}
    for env_name, setting_key in env_settings_map.items():
        raw_val = os.environ.get(env_name)
        if raw_val is None or not raw_val.strip():
            continue
        val = raw_val if setting_key == "agua_password" else raw_val.strip()
        if setting_key == "comm_mode" and val not in mode_db_paths:
            continue
        env_overrides[setting_key] = val
        default_settings[setting_key] = val
    return env_overrides


def _init_mode_database(db_file: str, now_iso: str) -> None:
    conn = sqlite3.connect(db_file, timeout=30.0, check_same_thread=False)
    try:
        conn.row_factory = sqlite3.Row
        _ensure_mode_tables(conn)
        cur = conn.cursor()
        cur.execute("DELETE FROM registers_catalog WHERE mem_type = 'SUPERVISOR'")
        # Purge du registre EEPROM #33250 (0x81E2, set_silece_set), vérifié inactif sur Nobis A10 (#107 bit 2048 = 0)
        cur.execute("DELETE FROM registers_catalog WHERE reg_key = 'set_silece_set' OR offset = 33250")
        for reg in DEFAULT_REGISTERS_CATALOG:
            cur.execute(
                """
                INSERT OR REPLACE INTO registers_catalog
                (reg_key, offset, mem_type, label, unit, min_val, max_val, step, current_val, default_val, category, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT current_val FROM registers_catalog WHERE reg_key = ?), ?), ?, ?, ?)
                """,
                (
                    reg["reg_key"],
                    reg["offset"],
                    reg["mem_type"],
                    reg["label"],
                    reg["unit"],
                    reg["min_val"],
                    reg["max_val"],
                    reg["step"],
                    reg["reg_key"],
                    reg["default_val"],
                    reg["default_val"],
                    reg["category"],
                    now_iso,
                ),
            )
        conn.commit()
    finally:
        conn.close()


def init_all_databases() -> None:
    """Initialise la base système et les bases de modes (création des tables et catalogues par défaut)."""
    import database as _db_pkg

    _db_pkg._DB_INITIALIZED = True
    sconn = get_sys_db()
    try:
        scur = sconn.cursor()
        default_settings = _build_default_settings()
        _merge_legacy_db_settings(_db_pkg.DATA_DIR, default_settings)
        env_overrides = _collect_env_overrides(default_settings, _db_pkg.MODE_DB_PATHS)

        for k, v in default_settings.items():
            scur.execute(
                "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
                (k, encrypt_setting_value(k, str(v))),
            )
        for setting_key, val in env_overrides.items():
            scur.execute(
                "UPDATE settings SET value = ? WHERE key = ? AND TRIM(value) = ''",
                (encrypt_setting_value(setting_key, val), setting_key),
            )
        migrate_plaintext_secrets(sconn)
        sconn.commit()
    finally:
        sconn.close()

    now_iso = datetime.now().isoformat(timespec="seconds")
    for db_file in _db_pkg.MODE_DB_PATHS.values():
        _init_mode_database(db_file, now_iso)
