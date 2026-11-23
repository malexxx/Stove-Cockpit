"""
Package télémétrie pour Nobis.Supervisor.
Regroupe le hub SSE/verrou bus, le décodeur matériel 76 offsets, le simulateur Nobis A10,
l'orchestrateur de collecte, les écritures batch sur registres et les réexports analytics.
"""
from analytics import (
    BATCH_MIN_CYCLES,
    BATCH_MIN_EVAL_MINUTES,
    NOBIS_TRIM_MAX,
    NOBIS_TRIM_MIN,
    STABILIZATION_WARMUP_S,
    _percentile,
    calculate_forecast_runway,
    check_power_stability,
    clamp_nobis_trim,
    enrich_telemetry_record,
    evaluate_batch_combustion_and_trim,
    evaluate_exhaust_quality,
    evaluate_pellet_quality,
    get_pellet_batch_state,
    save_pellet_batch_state,
)
from clients import agua_client, local_gateway_client, notification_service, weather_service
from database import prune_database_retention
from telemetry.collector import _collect_telemetry_unlocked, collect_telemetry_cycle
from telemetry.commands import (
    execute_register_write,
    execute_registers_batch_write,
    reset_pellet_batch_calibration,
)
from telemetry.decoder import (
    _is_app_silence_active,
    build_offline_record,
    compute_hopper_runway,
    compute_stability_deltas,
    decode_hardware_buffer,
    extract_chrono_fields,
    format_stove_clock,
)
from telemetry.hub import (
    _comm_status,
    _stove_io_lock,
    broadcast_sse_event,
    get_comm_status,
    sse_subscribers,
)
from telemetry.simulator import _sim_real_fan_register, simulate_telemetry_step

__all__ = [
    # Analytics (rétro-compatibilité)
    "BATCH_MIN_CYCLES",
    "BATCH_MIN_EVAL_MINUTES",
    "NOBIS_TRIM_MAX",
    "NOBIS_TRIM_MIN",
    "STABILIZATION_WARMUP_S",
    "_percentile",
    "calculate_forecast_runway",
    "check_power_stability",
    "clamp_nobis_trim",
    "enrich_telemetry_record",
    "evaluate_batch_combustion_and_trim",
    "evaluate_exhaust_quality",
    "evaluate_pellet_quality",
    "get_pellet_batch_state",
    "save_pellet_batch_state",
    # Clients (rétro-compatibilité)
    "agua_client",
    "local_gateway_client",
    "notification_service",
    "weather_service",
    # DB retention (rétro-compatibilité)
    "prune_database_retention",
    # Hub & SSE
    "_stove_io_lock",
    "_comm_status",
    "sse_subscribers",
    "get_comm_status",
    "broadcast_sse_event",
    # Décodeur & Simulateur
    "_is_app_silence_active",
    "_sim_real_fan_register",
    "format_stove_clock",
    "compute_hopper_runway",
    "compute_stability_deltas",
    "extract_chrono_fields",
    "decode_hardware_buffer",
    "build_offline_record",
    "simulate_telemetry_step",
    # Collecte & Commandes
    "collect_telemetry_cycle",
    "_collect_telemetry_unlocked",
    "execute_registers_batch_write",
    "execute_register_write",
    "reset_pellet_batch_calibration",
]
