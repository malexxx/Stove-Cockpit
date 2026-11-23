"""Façade de rétro-compatibilité pour le planificateur APScheduler (source : services/lifecycle.py)."""
from services.lifecycle import scheduler

__all__ = ["scheduler"]
