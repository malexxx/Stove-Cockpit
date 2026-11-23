# -*- coding: utf-8 -*-
"""
Contrôleur de l'Assistant interactif (Wizard) Nobis.Supervisor
avec désactivation automatique du Boost (POWERFUL / P8) et suivi des phases.
"""

from dataclasses import asdict
from typing import Any
from collections.abc import Callable
from .nobis_calibration import (
    NobisA10CalibrationEngine,
    CalibrationMode,
    CalibrationState,
    TelemetrySample,
)


class NobisCalibrationWizard:
    """
    Orchestrateur pas-à-pas pour l'interface utilisateur de Nobis.Supervisor.
    """

    def __init__(
        self,
        engine: NobisA10CalibrationEngine,
        api_disable_powerful_fn: Callable[[], bool],
        api_reset_alarm_fn: Callable[[], bool],
        api_write_register_fn: Callable[[int, int], bool],
        api_read_register_fn: Callable[[int], int],
    ) -> None:
        self.engine = engine
        self._disable_powerful = api_disable_powerful_fn
        self._reset_alarm = api_reset_alarm_fn
        self._write_reg = api_write_register_fn
        self._read_reg = api_read_register_fn
        self.p8_was_auto_disabled: bool = False

    def step1_configure_and_preflight(
        self, mode_str: str, current_sample: TelemetrySample
    ) -> dict[str, Any]:
        """
        Étape 1 : Sélectionne le mode et désactive automatiquement le Boost POWERFUL (P8).
        """
        mode = CalibrationMode(mode_str)
        self.engine.start_process(mode)

        had_p8_active = (
            current_sample.powerful_enabled_mode != "OFF"
            or current_sample.power_level == 8
        )
        ok, message = self.engine.verify_preflight_and_disable_p8(
            current_sample, disable_p8_callback=self._disable_powerful
        )
        self.p8_was_auto_disabled = had_p8_active and ok

        return {
            "step": 1,
            "success": ok,
            "state": self.engine.state.value,
            "p8_auto_disabled": self.p8_was_auto_disabled,
            "phase_filtering_policy": {
                "startup_phases": "Intégration exacte par encodeur RPM BLDC (sans Offset 70)",
                "post_ignition_warmup": "Exclusion thermique de 20 min après chaque allumage",
                "tier_transition": "Exclusion thermique de 15 min à chaque changement de palier",
                "p0_economy_ris": "Intégré au bilan massique kg/h, exclu du calcul Offsets 70/71",
                "p8_powerful_boost": "Désactivé au pré-contrôle (si forcé : intégré en masse, exclu +5 min en P/A)",
                "extinction_and_al03_starvation": "Arrêt compteur sur courant vis < 65 mA + purge rétroactive de 10 min",
            },
            "message": message,
        }

    def step2_verify_empty_hopper_al03(
        self, current_sample: TelemetrySample, auto_reset_alarm: bool = True
    ) -> dict[str, Any]:
        """
        Étape 2 : Vérifie l'état initial AL-03 (Cuve 100% vide) et réarme l'alarme.
        """
        ok, msg = self.engine.confirm_initial_al03(current_sample)
        reset_sent = False
        if ok and auto_reset_alarm:
            reset_sent = self._reset_alarm()

        return {
            "step": 2,
            "success": ok,
            "alarm_reset_sent": reset_sent,
            "state": self.engine.state.value,
            "message": msg,
        }

    def step3_register_weighed_charge(
        self,
        current_sample: TelemetrySample,
        weighed_bag_kg: float,
        aspirated_priming_grams: float = 0.0,
    ) -> dict[str, Any]:
        """
        Étape 3 : Enregistre le poids du sac étalon et guide l'amorçage CRG. VIS S. FIN.
        """
        aspirated_kg = max(0.0, aspirated_priming_grams / 1000.0)
        ok, msg = self.engine.confirm_stove_off_and_load_charge(
            current_sample,
            weighed_bag_kg=weighed_bag_kg,
            priming_aspirated_kg=aspirated_kg,
        )
        return {
            "step": 3,
            "success": ok,
            "state": self.engine.state.value,
            "net_calibrated_mass_kg": round(weighed_bag_kg - aspirated_kg, 3),
            "message": msg,
        }

    def step4_poll_status(self, current_sample: TelemetrySample) -> dict[str, Any]:
        """
        Étape 4 : Scrutation télémétrique temps réel avec diagnostic de filtrage des phases.
        """
        state = self.engine.ingest_telemetry(current_sample)
        consumed_est_kg = self.engine.get_current_estimated_consumed_mass_kg()
        remaining_est_kg = max(0.0, self.engine.weighed_mass_kg - consumed_est_kg)
        progress_pct = min(
            99.5,
            (consumed_est_kg / max(1.0, self.engine.weighed_mass_kg)) * 100.0,
        ) if state != CalibrationState.COMPLETED_LOCKED else 100.0

        return {
            "step": 4 if state != CalibrationState.COMPLETED_LOCKED else 5,
            "state": state.value,
            "current_phase": current_sample.phase.value,
            "current_power_tier": f"P{current_sample.power_level}",
            "estimated_consumed_kg": round(consumed_est_kg, 3),
            "estimated_remaining_kg": round(remaining_est_kg, 3),
            "progress_pct": round(progress_pct, 1),
            "hours_per_tier": {
                f"P{k}": round(sec / 3600.0, 2)
                for k, sec in self.engine.raw_time_seconds.items()
                if sec > 0 or (1 <= k <= 7)
            },
            "phase_breakdown": asdict(self.engine.phase_stats),
            "valid_combustion_samples_count": len(self.engine.telemetry_window),
            "waiting_for_al03": state == CalibrationState.RUNNING_ACQUISITION,
        }

    def step5_apply_recommended_settings(self) -> dict[str, Any]:
        """
        Étape 5 : Applique en 1 clic les Offsets 70 et 71 recommandés à la clôture AL-03.
        """
        ok, new_flows, msg = self.engine.apply_offsets_one_click(
            agua_write_register_fn=self._write_reg,
            agua_read_register_fn=self._read_reg,
        )
        return {
            "step": 5,
            "success": ok,
            "message": msg,
            "coupled_flows_kgh": new_flows,
            "result": asdict(self.engine.result) if self.engine.result else None,
        }
