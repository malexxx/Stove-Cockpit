"""Prévisions d'autonomie DJU, gestion d'état de lot granulés et utilitaires statistiques."""
import json
import logging
from typing import Any

from database import get_settings_dict, get_sys_db

logger = logging.getLogger("nobis.analytics")

BATCH_MIN_EVAL_MINUTES: float = 180.0     # 3 heures cumulées en TRAVAIL stabilisé avant proposition
BATCH_MIN_CYCLES: int = 4                 # Minimum 4 cycles d'allumage distincts
STABILIZATION_WARMUP_S: int = 1200        # Exclusion des 20 premières minutes en TRAVAIL (inertie fonte/vermiculite)
NOBIS_TRIM_MIN: int = -5                  # Limite basse officielle menu MÉLANGE P/A (-5%)
NOBIS_TRIM_MAX: int = 5                   # Limite haute officielle menu MÉLANGE P/A (+5%)


def clamp_nobis_trim(val: float) -> int:
    """Force toute valeur de tarage dans la plage officielle Nobis [-5%, +5%]."""
    return max(NOBIS_TRIM_MIN, min(NOBIS_TRIM_MAX, int(round(val))))


def get_pellet_batch_state() -> dict[str, Any]:
    """Récupère l'état du lot de granulés en cours depuis le cache settings (nobis_a10_system.db)."""
    raw = get_settings_dict().get("pellet_batch_state")
    if raw:
        try:
            return json.loads(raw)
        except Exception as exc:
            logger.debug("pellet_batch_state JSON invalide: %s", exc)
    return {
        "raz_epoch": 0,
        "raz_timestamp": "Initialisation",
        "pellet_brand": "Lot Standard DINplus / ENplus A1",
        "baseline_rpm_per_pa": None,
        "last_applied_epoch": 0,
    }


def save_pellet_batch_state(state: dict[str, Any]) -> None:
    """Sauvegarde l'état du lot de granulés dans settings."""
    conn = get_sys_db()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('pellet_batch_state', ?)",
            (json.dumps(state),),
        )
        conn.commit()
    finally:
        conn.close()


def _percentile(sorted_vals: list[float], pct: float) -> float:
    """Calcule un centile (ex: P90 avec pct=0.90) sans dépendance externe."""
    if not sorted_vals:
        return 0.0
    k = (len(sorted_vals) - 1) * pct
    f = int(k)
    c = min(len(sorted_vals) - 1, f + 1)
    if f == c:
        return float(sorted_vals[f])
    return float(sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f))


def calculate_forecast_runway(total_kg_avail: float, weather: dict[str, Any]) -> float:
    """Calcule l'autonomie en jours du stock restant selon les prévisions météo Open-Meteo 14 jours (DJU)."""
    if total_kg_avail <= 0.0:
        return 0.0

    forecast_means = weather.get("forecast_daily_means") or []
    if not forecast_means:
        t_ext = float(weather.get("weather_temp_ext") or 10.0)
        dju = max(0.0, 19.0 - t_ext)
        daily_cons = max(3.5, round(dju * 0.78, 2))
        return round(total_kg_avail / daily_cons, 1)

    rem_kg = total_kg_avail
    accumulated_days = 0.0
    daily_conso_list = []

    for t_mean in forecast_means:
        dju = max(0.0, 19.0 - float(t_mean))
        c_day = max(3.5, round(dju * 0.78, 2))
        daily_conso_list.append(c_day)

        if rem_kg >= c_day:
            rem_kg -= c_day
            accumulated_days += 1.0
        else:
            accumulated_days += round(rem_kg / c_day, 1)
            rem_kg = 0.0
            break

    if rem_kg > 0.0 and daily_conso_list:
        avg_c = sum(daily_conso_list) / len(daily_conso_list)
        accumulated_days += round(rem_kg / max(3.5, avg_c), 1)

    return round(accumulated_days, 1)
