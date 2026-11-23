"""
Package d'analyses thermiques, d'évaluations de combustion (Mélange P/A) et de prévisions DJU.
"""
from analytics.batch_evaluator import (
    enrich_telemetry_record,
    evaluate_batch_combustion_and_trim,
)
from analytics.forecast import (
    BATCH_MIN_CYCLES,
    BATCH_MIN_EVAL_MINUTES,
    NOBIS_TRIM_MAX,
    NOBIS_TRIM_MIN,
    STABILIZATION_WARMUP_S,
    _percentile,
    calculate_forecast_runway,
    clamp_nobis_trim,
    get_pellet_batch_state,
    save_pellet_batch_state,
)
from analytics.legacy_evaluators import (
    evaluate_exhaust_quality,
    evaluate_pellet_quality,
)
from analytics.stability import check_power_stability

__all__ = [
    "BATCH_MIN_EVAL_MINUTES",
    "BATCH_MIN_CYCLES",
    "STABILIZATION_WARMUP_S",
    "NOBIS_TRIM_MIN",
    "NOBIS_TRIM_MAX",
    "clamp_nobis_trim",
    "get_pellet_batch_state",
    "save_pellet_batch_state",
    "_percentile",
    "calculate_forecast_runway",
    "check_power_stability",
    "evaluate_pellet_quality",
    "evaluate_exhaust_quality",
    "evaluate_batch_combustion_and_trim",
    "enrich_telemetry_record",
]
