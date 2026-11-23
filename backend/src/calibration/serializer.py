# -*- coding: utf-8 -*-
"""Sérialisation / désérialisation JSON de l'état complet du moteur de calibration Nobis A10."""

from __future__ import annotations

from dataclasses import asdict
from typing import TYPE_CHECKING, Any

from .models import (
    CalibrationMode,
    CalibrationResult,
    CalibrationState,
    PhaseBreakdownStats,
    StoveOperationalPhase,
    TelemetrySample,
)

if TYPE_CHECKING:
    from .nobis_calibration import NobisA10CalibrationEngine


def serialize_engine(engine: NobisA10CalibrationEngine) -> dict[str, Any]:
    """Sérialise l'état complet du moteur pour sauvegarde SQLite persistante."""
    return {
        "state": engine.state.value,
        "mode": engine.mode.value,
        "k_intrinsic": engine.k_intrinsic,
        "weighed_mass_kg": engine.weighed_mass_kg,
        "priming_extracted_mass_kg": engine.priming_extracted_mass_kg,
        "raw_time_seconds": {str(k): v for k, v in engine.raw_time_seconds.items()},
        "weighted_time_hours": {str(k): v for k, v in engine.weighted_time_hours.items()},
        "startup_equivalent_p7_hours": engine.startup_equivalent_p7_hours,
        "startup_rpm_telemetry_available": engine.startup_rpm_telemetry_available,
        "phase_stats": asdict(engine.phase_stats),
        "telemetry_window": [
            {**asdict(s), "phase": s.phase.value}
            for s in engine.telemetry_window[-300:]
        ],
        "last_sample": (
            {**asdict(engine._last_sample), "phase": engine._last_sample.phase.value}
            if engine._last_sample
            else None
        ),
        "last_p8_timestamp": engine._last_p8_timestamp,
        "last_ignition_end_ts": engine._last_ignition_end_ts,
        "current_tier_entry_ts": engine._current_tier_entry_ts,
        "in_ignition_sequence": engine._in_ignition_sequence,
        "overload_event_detected": engine._overload_event_detected,
        "result": (
            {
                **asdict(engine.result),
                "mode": engine.result.mode.value,
                "phase_stats": asdict(engine.result.phase_stats),
                "before_flows_kgh": {str(k): v for k, v in engine.result.before_flows_kgh.items()},
                "measured_raw_flows_kgh": {str(k): v for k, v in engine.result.measured_raw_flows_kgh.items()},
                "coupled_effective_flows_kgh": {str(k): v for k, v in engine.result.coupled_effective_flows_kgh.items()},
                "time_per_power_hours": {str(k): v for k, v in engine.result.time_per_power_hours.items()},
            }
            if engine.result
            else None
        ),
    }


def deserialize_engine(cls: type[NobisA10CalibrationEngine], data: dict[str, Any]) -> NobisA10CalibrationEngine:
    """Désérialise l'état complet du moteur depuis un dump SQLite persisté."""
    engine = cls(current_k_factor=float(data.get("k_intrinsic", 1.0)))
    engine.state = CalibrationState(data.get("state", CalibrationState.IDLE.value))
    engine.mode = CalibrationMode(data.get("mode", CalibrationMode.COMBINED_BOTH.value))
    engine.weighed_mass_kg = float(data.get("weighed_mass_kg", 0.0))
    engine.priming_extracted_mass_kg = float(data.get("priming_extracted_mass_kg", 0.0))

    raw_ts = data.get("raw_time_seconds", {})
    engine.raw_time_seconds = {int(k): float(v) for k, v in raw_ts.items()}
    for k in range(9):
        engine.raw_time_seconds.setdefault(k, 0.0)

    w_th = data.get("weighted_time_hours", {})
    engine.weighted_time_hours = {int(k): float(v) for k, v in w_th.items()}
    for k in range(9):
        engine.weighted_time_hours.setdefault(k, 0.0)

    engine.startup_equivalent_p7_hours = float(data.get("startup_equivalent_p7_hours", 0.0))
    engine.startup_rpm_telemetry_available = bool(data.get("startup_rpm_telemetry_available", False))

    if "phase_stats" in data and isinstance(data["phase_stats"], dict):
        engine.phase_stats = PhaseBreakdownStats(**data["phase_stats"])

    def _parse_sample(d: dict[str, Any]) -> TelemetrySample:
        d_copy = dict(d)
        if isinstance(d_copy.get("phase"), str):
            d_copy["phase"] = StoveOperationalPhase(d_copy["phase"])
        return TelemetrySample(**d_copy)

    if "telemetry_window" in data and isinstance(data["telemetry_window"], list):
        engine.telemetry_window = [_parse_sample(s) for s in data["telemetry_window"]]

    if data.get("last_sample"):
        engine._last_sample = _parse_sample(data["last_sample"])

    engine._last_p8_timestamp = float(data.get("last_p8_timestamp", -1e9))
    engine._last_ignition_end_ts = float(data.get("last_ignition_end_ts", -1e9))
    engine._current_tier_entry_ts = float(data.get("current_tier_entry_ts", 0.0))
    engine._in_ignition_sequence = bool(data.get("in_ignition_sequence", False))
    engine._overload_event_detected = bool(data.get("overload_event_detected", False))

    res_data = data.get("result")
    if res_data and isinstance(res_data, dict):
        res_copy = dict(res_data)
        res_copy["mode"] = CalibrationMode(res_copy["mode"])
        if isinstance(res_copy.get("phase_stats"), dict):
            res_copy["phase_stats"] = PhaseBreakdownStats(**res_copy["phase_stats"])
        res_copy["before_flows_kgh"] = {int(k): float(v) for k, v in res_copy.get("before_flows_kgh", {}).items()}
        res_copy["measured_raw_flows_kgh"] = {int(k): float(v) for k, v in res_copy.get("measured_raw_flows_kgh", {}).items()}
        res_copy["coupled_effective_flows_kgh"] = {int(k): float(v) for k, v in res_copy.get("coupled_effective_flows_kgh", {}).items()}
        res_copy["time_per_power_hours"] = {int(k): float(v) for k, v in res_copy.get("time_per_power_hours", {}).items()}
        engine.result = CalibrationResult(**res_copy)

    return engine
