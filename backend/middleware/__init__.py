"""Middlewares HTTP, CORS et sécurité pour Stove Cockpit."""
from middleware.security import register_security_and_error_handlers

__all__ = ["register_security_and_error_handlers"]
