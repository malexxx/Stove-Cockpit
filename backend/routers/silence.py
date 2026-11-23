"""
Sous-routeur HTTP pour le Mode Silence ! intelligent.
Délègue toute la logique métier, persistance et planification à services/silence_service.py.
"""
from typing import Annotated

from fastapi import APIRouter, Body

from schemas import SilenceActivatePayload, SilenceDeactivatePayload
from services.silence_service import (
    SILENCE_KEYS_TO_SAVE,
    _auto_expire_silence_job,
    activate_silence_mode,
    deactivate_silence_mode,
    get_silence_state,
    get_silence_status,
    save_silence_state,
)

__all__ = [
    "router",
    "SILENCE_KEYS_TO_SAVE",
    "get_silence_state",
    "save_silence_state",
    "get_silence_status",
    "activate_silence_mode",
    "deactivate_silence_mode",
    "_auto_expire_silence_job",
]

router = APIRouter(prefix="/api/silence", tags=["Silence"])
_SILENCE_ACTIVATE_DEFAULT = SilenceActivatePayload()


@router.post("/activate")
async def api_silence_activate(payload: Annotated[SilenceActivatePayload, Body()] = _SILENCE_ACTIVATE_DEFAULT):
    """Active le mode Silence intelligent."""
    return await activate_silence_mode(payload.duration_hours)


@router.post("/deactivate")
async def api_silence_deactivate(payload: Annotated[SilenceDeactivatePayload | None, Body()] = None):
    """Désactive le mode Silence intelligent et restaure immédiatement les consignes."""
    override_cmds = payload.override_commands if payload else None
    return await deactivate_silence_mode(is_auto_expired=False, override_commands=override_cmds)


@router.get("/status")
async def api_silence_status():
    """Retourne l'état actuel du mode Silence intelligent."""
    return get_silence_status()
