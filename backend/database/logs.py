"""Journalisation applicative SQLite (app_logs) et buffer mémoire circulaire conteneur."""
from collections import deque
from datetime import datetime
import threading
from typing import Any

from database.connection import db_session

_container_logs_lock = threading.Lock()
_container_logs: deque = deque(maxlen=500)


def db_log(severity: str, source: str, message: str, mode: str | None = None) -> None:
    """Enregistre un événement dans la table des journaux applicatifs (app_logs)."""
    s = (severity or "INFO").strip().upper()
    if s == "WARN":
        s = "WARNING"
    with db_session(mode) as conn:
        conn.execute(
            "INSERT INTO app_logs (timestamp, severity, source, message) VALUES (?, ?, ?, ?)",
            (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), s, source, str(message)),
        )


def add_container_log(severity: str, source: str, message: str) -> None:
    """Ajoute une ligne de log conteneur/backend dans le buffer circulaire en mémoire."""
    s = (severity or "INFO").strip().upper()
    if s == "WARN":
        s = "WARNING"
    entry = {
        "id": None,
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "severity": s,
        "source": str(source or "CONTAINER")[:25],
        "message": str(message or "")[:1000],
    }
    with _container_logs_lock:
        _container_logs.append(entry)


def get_container_logs(limit: int = 250) -> list[dict[str, Any]]:
    """Retourne les journaux du conteneur stockés en mémoire (du plus récent au plus ancien)."""
    with _container_logs_lock:
        items = list(_container_logs)
    items.reverse()
    return items[: max(1, limit)]
