"""Détection de stabilité thermique/puissance et vérification ventilation active."""
from typing import Any


def check_power_stability(
    conn: Any,
    now_epoch: int,
    status_code: int,
    power_actual: int,
    power_level: int,
    window_seconds: int = 1800,
) -> tuple[bool, int, list[Any], bool]:
    """Vérifie si la combustion est en régime établi sur l'intervalle spécifié (défaut 30 min / 1800s) :
    1. Consigne de puissance et puissance réelle restées strictement constantes sans variation.
    2. Sécurité ventilation : au moins un ventilateur actif (offsets 16, 31, 32).
    Retourne (is_stable_window, stable_minutes, rows_in_window, fans_active)."""
    if status_code != 5 or power_actual <= 0:
        return (False, 0, [], False)

    cutoff = now_epoch - window_seconds

    var_row = conn.execute(
        """
        SELECT MAX(epoch)
        FROM telemetry
        WHERE epoch >= ? AND epoch <= ?
          AND (status_code != 5 OR power_actual != ? OR power_level != ?)
        """,
        (cutoff, now_epoch, power_actual, power_level),
    ).fetchone()

    last_var_epoch = var_row[0] if var_row and var_row[0] is not None else None

    if last_var_epoch is not None:
        stable_seconds = max(0, now_epoch - last_var_epoch)
        stable_start = last_var_epoch + 1
    else:
        oldest_row = conn.execute(
            """
            SELECT MIN(epoch)
            FROM telemetry
            WHERE epoch >= ? AND epoch <= ?
              AND status_code = 5 AND power_actual = ? AND power_level = ?
            """,
            (cutoff - 3600, now_epoch, power_actual, power_level),
        ).fetchone()
        if oldest_row and oldest_row[0] is not None:
            stable_seconds = max(0, now_epoch - oldest_row[0])
        else:
            stable_seconds = 0
        stable_start = cutoff

    window_mins = max(1, window_seconds // 60)
    stable_minutes = min(window_mins, max(1, int(stable_seconds // 60)))

    query_since = cutoff if (last_var_epoch is None and stable_seconds >= (window_seconds - 120)) else stable_start
    stable_rows = conn.execute(
        """
        SELECT epoch, temp_probe_k, depression_pa,
               COALESCE(vent_front_actual, 0),
               COALESCE(duct_right_actual, 0),
               COALESCE(duct_left_actual, 0)
        FROM telemetry
        WHERE status_code = 5
          AND power_actual = ?
          AND power_level = ?
          AND epoch >= ? AND epoch <= ?
        ORDER BY epoch ASC
        """,
        (power_actual, power_level, query_since, now_epoch),
    ).fetchall()

    fans_active = True
    if stable_rows:
        latest_r = stable_rows[-1]
        vf = int(latest_r[3] or 0)
        vdr = int(latest_r[4] or 0)
        vdl = int(latest_r[5] or 0)
        if vf == 0 and vdr == 0 and vdl == 0:
            fans_active = False

    is_power_stable = (last_var_epoch is None) and (stable_seconds >= (window_seconds - 120))
    is_stable_window = is_power_stable and fans_active
    return (is_stable_window, stable_minutes, stable_rows, fans_active)
