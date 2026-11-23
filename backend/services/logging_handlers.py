"""Handlers de journalisation Python vers SQLite (app_logs) et buffer mémoire conteneur."""
import logging

from database import add_container_log, db_log, get_active_mode


class DbLogHandler(logging.Handler):
    """Redirige les logs ERROR et CRITICAL de Python directement dans app_logs."""

    def emit(self, record: logging.LogRecord) -> None:
        """Écrit les enregistrements ERROR/CRITICAL dans la table SQLite app_logs."""
        if record.levelno >= logging.ERROR:
            try:
                active_mode = get_active_mode()
                msg = self.format(record)
                if "app_logs" not in msg:
                    db_log("ERROR", record.name[:25], msg[:500], active_mode)
            except Exception:
                self.handleError(record)


class ContainerLogHandler(logging.Handler):
    """Capture les journaux Python/Uvicorn/APScheduler (INFO+) dans le buffer mémoire conteneur."""

    def emit(self, record: logging.LogRecord) -> None:
        """Stocke le message formaté dans le buffer circulaire mémoire sans duplication."""
        if getattr(record, "_container_logged", False):
            return
        record._container_logged = True
        try:
            msg = self.format(record)
            if msg:
                add_container_log(record.levelname, record.name or "CONTAINER", msg)
        except Exception:
            self.handleError(record)


_db_log_handler = DbLogHandler()
_db_log_handler.setLevel(logging.ERROR)

_container_log_handler = ContainerLogHandler()
_container_log_handler.setLevel(logging.INFO)
_container_log_handler.setFormatter(logging.Formatter("%(message)s"))


def attach_logging_handlers() -> None:
    """Attache les handlers SQLite ERROR et mémoire conteneur au logger racine et à Uvicorn/APScheduler."""
    root_logger = logging.getLogger()
    if _db_log_handler not in root_logger.handlers:
        root_logger.addHandler(_db_log_handler)
    if root_logger.level == logging.NOTSET or root_logger.level > logging.INFO:
        root_logger.setLevel(logging.INFO)
    for logger_name in ("", "uvicorn", "uvicorn.error", "uvicorn.access", "apscheduler"):
        lg = logging.getLogger(logger_name)
        if logger_name and lg.level > logging.INFO:
            lg.setLevel(logging.INFO)
        if _container_log_handler not in lg.handlers:
            lg.addHandler(_container_log_handler)
