"""Chiffrement au repos (Fernet AES-128-CBC + HMAC-SHA256) pour les secrets en base SQLite."""
import base64
import hashlib
import logging
import os
import sqlite3
import threading

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger("nobis.secrets")

ENC_PREFIX = "enc:v1:"
SENSITIVE_SETTING_KEYS: frozenset[str] = frozenset({"agua_password", "container_api_token"})

_key_lock = threading.Lock()
_cached_fernet: tuple[str, bytes, Fernet] | None = None


def _normalize_fernet_key(raw: bytes) -> bytes:
    """Valide une clé Fernet base64 URL-safe de 32 octets ou dérive une clé SHA-256."""
    stripped = raw.strip()
    try:
        decoded = base64.urlsafe_b64decode(stripped)
        if len(decoded) == 32:
            Fernet(stripped)
            return stripped
    except Exception as exc:
        logger.debug("Clé non-Fernet directe, dérivation SHA-256 : %s", exc)
    return base64.urlsafe_b64encode(hashlib.sha256(stripped).digest())


def get_secret_key_path() -> str:
    """Retourne le chemin du fichier clé local persistant (dans DATA_DIR)."""
    import database as _db_pkg

    return os.path.join(_db_pkg.DATA_DIR, ".secret.key")


def _load_or_create_key_bytes() -> tuple[str, bytes]:
    """Résout la clé de chiffrement depuis NOBIS_SECRET_KEY ou data/.secret.key (chmod 0600)."""
    env_key = os.environ.get("NOBIS_SECRET_KEY", "").strip()
    if env_key:
        return "env:NOBIS_SECRET_KEY", _normalize_fernet_key(env_key.encode("utf-8"))

    key_path = get_secret_key_path()
    with _key_lock:
        if os.path.isfile(key_path):
            try:
                with open(key_path, "rb") as f:
                    existing = f.read().strip()
                if existing:
                    return key_path, _normalize_fernet_key(existing)
            except OSError as exc:
                logger.warning("Impossible de lire %s : %s", key_path, exc)

        os.makedirs(os.path.dirname(key_path), exist_ok=True)
        new_key = Fernet.generate_key()
        tmp_path = f"{key_path}.tmp.{os.getpid()}"
        with open(tmp_path, "wb") as f:
            f.write(new_key)
        if os.name != "nt":
            try:
                os.chmod(tmp_path, 0o600)
            except OSError:
                pass
        os.replace(tmp_path, key_path)
        if os.name != "nt":
            try:
                os.chmod(key_path, 0o600)
            except OSError:
                pass
        return key_path, new_key


def _get_fernet() -> Fernet:
    global _cached_fernet
    source, key_bytes = _load_or_create_key_bytes()
    if _cached_fernet is not None and _cached_fernet[0] == source and _cached_fernet[1] == key_bytes:
        return _cached_fernet[2]
    f = Fernet(key_bytes)
    _cached_fernet = (source, key_bytes, f)
    return f


def reset_secret_key_cache() -> None:
    """Purge le cache mémoire de la clé Fernet (utile après restauration de data/.secret.key)."""
    global _cached_fernet
    with _key_lock:
        _cached_fernet = None


def is_encrypted_secret(value: str) -> bool:
    """Indique si une chaîne est déjà chiffrée avec le préfixe applicatif."""
    return isinstance(value, str) and value.startswith(ENC_PREFIX)


def encrypt_secret(value: str) -> str:
    """Chiffre une valeur secrète non vide (idempotent si déjà chiffrée)."""
    if not value or value == "********" or is_encrypted_secret(value):
        return value
    token = _get_fernet().encrypt(value.encode("utf-8")).decode("ascii")
    return f"{ENC_PREFIX}{token}"


def decrypt_secret(value: str) -> str:
    """Déchiffre une valeur chiffrée (retourne telle quelle une valeur legacy en clair)."""
    if not value or not is_encrypted_secret(value):
        return value
    raw_token = value[len(ENC_PREFIX):].encode("ascii")
    try:
        return _get_fernet().decrypt(raw_token).decode("utf-8")
    except (InvalidToken, ValueError):
        logger.warning(
            "Impossible de déchiffrer un secret SQLite (clé data/.secret.key ou NOBIS_SECRET_KEY différente)."
        )
        return ""


def encrypt_setting_value(key: str, value: str) -> str:
    """Chiffre la valeur uniquement si la clé appartient à SENSITIVE_SETTING_KEYS."""
    if key in SENSITIVE_SETTING_KEYS and value:
        return encrypt_secret(str(value))
    return str(value)


def decrypt_setting_value(key: str, value: str) -> str:
    """Déchiffre la valeur uniquement si la clé appartient à SENSITIVE_SETTING_KEYS."""
    if key in SENSITIVE_SETTING_KEYS and value:
        return decrypt_secret(str(value))
    return str(value)


def migrate_plaintext_secrets(conn: sqlite3.Connection) -> int:
    """Migre de manière transparente tout secret encore stocké en clair dans la table settings."""
    migrated = 0
    for key in SENSITIVE_SETTING_KEYS:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        if row and row["value"] and not is_encrypted_secret(row["value"]):
            encrypted = encrypt_secret(str(row["value"]))
            conn.execute("UPDATE settings SET value = ? WHERE key = ?", (encrypted, key))
            migrated += 1
    if migrated:
        logger.info("%d secret(s) SQLite migré(s) vers le stockage chiffré Fernet.", migrated)
    return migrated
