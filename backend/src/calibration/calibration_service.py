# -*- coding: utf-8 -*-
"""
Service de persistance et d'exécution en arrière-plan de la calibration Nobis A10.
Maintient l'état du moteur dans SQLite (nobis_a10_system.db -> table settings)
afin que la calibration se poursuive sans interruption en arrière-plan
même lorsque l'utilisateur quitte la page ou éteint son navigateur.
"""

from __future__ import annotations
from dataclasses import asdict
import json
import logging
import threading
import time
from typing import Any
from collections.abc import Callable

from database import get_sys_db
from .calibration_wizard import NobisCalibrationWizard
from .nobis_calibration import (
    CalibrationState,
    NobisA10CalibrationEngine,
    StoveOperationalPhase,
    TelemetrySample,
)

logger = logging.getLogger("nobis.calibration")

CALIBRATION_SETTINGS_KEY = "nobis_a10_active_calibration_session"


def _resolve_operational_phase(status_code: int, p_actual: int, fun_pwf: int) -> StoveOperationalPhase:
    static_map = {
        0: StoveOperationalPhase.OFF,
        1: StoveOperationalPhase.STARTING,
        2: StoveOperationalPhase.STARTING,
        3: StoveOperationalPhase.STARTING,
        4: StoveOperationalPhase.WAITING_FLAME,
        6: StoveOperationalPhase.BRAZIER_CLEANING,
        7: StoveOperationalPhase.COOLING_FINAL,
        8: StoveOperationalPhase.CLIMATE_COMFORT_STANDBY,
        9: StoveOperationalPhase.CLIMATE_COMFORT_STANDBY,
        10: StoveOperationalPhase.ALARM,
        11: StoveOperationalPhase.ALARM,
    }
    if status_code == 5:
        if fun_pwf == 1 or p_actual == 8:
            return StoveOperationalPhase.POWERFUL_BOOST
        if p_actual == 0:
            return StoveOperationalPhase.ECONOMY_RIS
        return StoveOperationalPhase.WORK
    return static_map.get(status_code, StoveOperationalPhase.WORK)


def _format_alarm_code(alarm_num: int) -> str | None:
    if alarm_num <= 0:
        return None
    return f"AL-{alarm_num:02d}"


def _estimate_auger_rpm(phase: StoveOperationalPhase, p_actual: int) -> float:
    if phase == StoveOperationalPhase.STARTING:
        return 425.0
    if phase in (StoveOperationalPhase.WAITING_FLAME, StoveOperationalPhase.OFF, StoveOperationalPhase.COOLING_FINAL):
        return 0.0
    return 338.0 + (p_actual - 1) * ((850.0 - 338.0) / 6.0) if p_actual >= 1 else 338.0


def _normalize_flue_pressure(raw_dep_pa: float, p_actual: int) -> tuple[float, float]:
    target_coax_pa = round(2.0 + max(1, min(7, p_actual)) * 0.25, 2)
    if raw_dep_pa <= 0.0:
        return target_coax_pa, target_coax_pa
    if raw_dep_pa < 8.0:
        return raw_dep_pa, target_coax_pa
    return raw_dep_pa, 18.0


def build_sample_from_record(
    record: dict[str, Any], raw_buf: dict[int, float] | None = None
) -> TelemetrySample:
    """Transforme un enregistrement télémétrique du superviseur en TelemetrySample."""
    raw_status = record.get("status_code")
    status_code = int(raw_status) if raw_status is not None else 0
    raw_p = record.get("power_actual")
    if raw_p is None:
        raw_p = record.get("power_level")
    p_actual = int(raw_p) if raw_p is not None else 4
    fun_pwf = int(record.get("fun_pwf_set") or 0)

    phase = _resolve_operational_phase(status_code, p_actual, fun_pwf)
    alarm_str = _format_alarm_code(int(record.get("alarm_code") or 0))
    rpm_act = _estimate_auger_rpm(phase, p_actual)
    cur_ma = 45.0 if alarm_str == "AL-03" else 150.0
    flue_pa, flue_set_pa = _normalize_flue_pressure(float(record.get("depression_pa") or 0.0), p_actual)

    return TelemetrySample(
        timestamp=float(record.get("epoch") or time.time()),
        phase=phase,
        power_level=p_actual,
        alarm_code=alarm_str,
        auger_rpm_actual=round(rpm_act, 1),
        auger_rpm_set=round(rpm_act, 1),
        auger_current_ma=cur_ma,
        flue_pressure_pa=flue_pa,
        flue_pressure_set_pa=flue_set_pa,
        smoke_extractor_rpm=float(record.get("exhaust_rpm") or 1850.0),
        flame_temp_c=float(record.get("temp_probe_k") or 600.0),
        smoke_temp_c=float(record.get("temp_fumes") or 135.0),
        room_temp_c=float(record.get("temp_ambient") or 20.0),
        offset_70_pellet=int(record.get("trim_pellet_pct") or 0),
        offset_71_air=int(record.get("trim_exhaust_pct") or 0),
        powerful_enabled_mode="ON" if fun_pwf == 1 else "OFF",
        hopper_lid_open=bool(record.get("popup_pellet_open")),
        door_or_ashtray_open=bool(record.get("popup_door_open")),
    )


class NobisCalibrationService:
    """
    Gestionnaire singleton de calibration persistée en arrière-plan (thread-safe).
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.engine: NobisA10CalibrationEngine = NobisA10CalibrationEngine()
        self.active_step: int = 1
        self.last_updated_epoch: float = time.time()
        self.load_session()

    def load_session(self) -> None:
        """Charge l'état persisté depuis la table settings de la base système."""
        with self._lock:
            conn = get_sys_db()
            try:
                row = conn.execute(
                    "SELECT value FROM settings WHERE key = ?", (CALIBRATION_SETTINGS_KEY,)
                ).fetchone()
                if row and row["value"]:
                    data = json.loads(row["value"])
                    self.engine = NobisA10CalibrationEngine.from_dict(data.get("engine", {}))
                    self.active_step = int(data.get("active_step", 1))
                    self.last_updated_epoch = float(data.get("last_updated_epoch", time.time()))
                    logger.info(
                        f"Session de calibration restaurée depuis SQLite (Étape {self.active_step}, État={self.engine.state.value})"
                    )
            except Exception as e:
                logger.warning(f"Impossible de restaurer la session de calibration : {e}")
                self.engine = NobisA10CalibrationEngine()
                self.active_step = 1
            finally:
                conn.close()

    def save_session(self) -> None:
        """Sauvegarde atomique de l'état dans la table settings."""
        with self._lock:
            self.last_updated_epoch = time.time()
            data = {
                "active_step": self.active_step,
                "last_updated_epoch": self.last_updated_epoch,
                "engine": self.engine.to_dict(),
            }
            conn = get_sys_db()
            try:
                conn.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                    (CALIBRATION_SETTINGS_KEY, json.dumps(data)),
                )
                conn.commit()
            except Exception as e:
                logger.error(f"Échec sauvegarde session de calibration : {e}")
            finally:
                conn.close()

    def start_preflight(
        self,
        mode_str: str,
        current_sample: TelemetrySample,
        disable_p8_fn: Callable[[], bool] | None = None,
    ) -> dict[str, Any]:
        """Étape 1 : Démarre le protocole et désactive POWERFUL."""
        with self._lock:
            wizard = NobisCalibrationWizard(
                engine=self.engine,
                api_disable_powerful_fn=disable_p8_fn or (lambda: True),
                api_reset_alarm_fn=lambda: True,
                api_write_register_fn=lambda r, v: True,
                api_read_register_fn=lambda r: 0,
            )
            res = wizard.step1_configure_and_preflight(mode_str, current_sample)
            if res["success"]:
                self.active_step = 2 if self.engine.state == CalibrationState.WAITING_INITIAL_AL03 else 4
                self.save_session()
            return res

    def confirm_initial_al03(
        self,
        current_sample: TelemetrySample,
        reset_alarm_fn: Callable[[], bool] | None = None,
    ) -> dict[str, Any]:
        """Étape 2 : Confirme la cuve vide initiale (AL-03) et réarme."""
        with self._lock:
            wizard = NobisCalibrationWizard(
                engine=self.engine,
                api_disable_powerful_fn=lambda: True,
                api_reset_alarm_fn=reset_alarm_fn or (lambda: True),
                api_write_register_fn=lambda r, v: True,
                api_read_register_fn=lambda r: 0,
            )
            res = wizard.step2_verify_empty_hopper_al03(current_sample, auto_reset_alarm=True)
            if res["success"]:
                self.active_step = 3
                self.save_session()
            return res

    def load_weighed_charge(
        self,
        current_sample: TelemetrySample,
        weighed_bag_kg: float,
        aspirated_priming_g: float = 0.0,
    ) -> dict[str, Any]:
        """Étape 3 : Verrouille la charge étalon pesée et bascule en acquisition arrière-plan."""
        with self._lock:
            wizard = NobisCalibrationWizard(
                engine=self.engine,
                api_disable_powerful_fn=lambda: True,
                api_reset_alarm_fn=lambda: True,
                api_write_register_fn=lambda r, v: True,
                api_read_register_fn=lambda r: 0,
            )
            res = wizard.step3_register_weighed_charge(
                current_sample,
                weighed_bag_kg=weighed_bag_kg,
                aspirated_priming_grams=aspirated_priming_g,
            )
            if res["success"]:
                self.active_step = 4
                self.save_session()
            return res

    def process_telemetry_record(
        self, record: dict[str, Any], raw_buf: dict[int, float] | None = None
    ) -> None:
        """
        Appelé à chaque cycle de télémétrie (ex: 60s) en arrière-plan.
        Ingère les échantillons automatiquement sans aucune interaction utilisateur requise.
        """
        with self._lock:
            if self.engine.state != CalibrationState.RUNNING_ACQUISITION:
                return

            sample = build_sample_from_record(record, raw_buf)
            new_state = self.engine.ingest_telemetry(sample)

            if new_state == CalibrationState.COMPLETED_LOCKED:
                self.active_step = 5
                logger.info(
                    f"Étalonnage Nobis A10 clôturé automatiquement par AL-03 ! K={self.engine.k_intrinsic:.4f}"
                )

            # Sauvegarde persistante de la progression
            self.save_session()

    def get_status(
        self, latest_record: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Retourne l'état courant temps réel pour l'interface web (wizard_calibration.html)."""
        with self._lock:
            sample = (
                build_sample_from_record(latest_record)
                if latest_record
                else (self.engine._last_sample or build_sample_from_record({}))
            )

            consumed_est_kg = self.engine.get_current_estimated_consumed_mass_kg()
            remaining_est_kg = max(0.0, self.engine.weighed_mass_kg - consumed_est_kg)
            progress_pct = (
                min(99.5, (consumed_est_kg / max(1.0, self.engine.weighed_mass_kg)) * 100.0)
                if self.engine.state != CalibrationState.COMPLETED_LOCKED
                else 100.0
            )

            # Si l'étalonnage est verrouillé, nous sommes à l'étape 5
            if self.engine.state == CalibrationState.COMPLETED_LOCKED:
                step_to_report = 5
            elif self.engine.state == CalibrationState.RUNNING_ACQUISITION:
                step_to_report = 4
            else:
                step_to_report = self.active_step

            return {
                "step": step_to_report,
                "state": self.engine.state.value,
                "mode": self.engine.mode.value,
                "weighed_mass_kg": self.engine.weighed_mass_kg,
                "priming_extracted_mass_kg": self.engine.priming_extracted_mass_kg,
                "estimated_consumed_kg": round(consumed_est_kg, 3),
                "estimated_remaining_kg": round(remaining_est_kg, 3),
                "progress_pct": round(progress_pct, 1),
                "current_phase": sample.phase.value,
                "current_power_tier": f"P{sample.power_level}",
                "hours_per_tier": {
                    f"P{k}": round(sec / 3600.0, 2)
                    for k, sec in self.engine.raw_time_seconds.items()
                    if sec > 0 or (1 <= k <= 7)
                },
                "phase_breakdown": asdict(self.engine.phase_stats),
                "valid_combustion_samples_count": len(self.engine.telemetry_window),
                "waiting_for_al03": self.engine.state == CalibrationState.RUNNING_ACQUISITION,
                "result": asdict(self.engine.result) if self.engine.result else None,
                "last_updated_epoch": self.last_updated_epoch,
            }

    def apply_recommendations(
        self,
        write_fn: Callable[[int, int], bool],
        read_fn: Callable[[int], int],
    ) -> dict[str, Any]:
        """Étape 5 : Applique les offsets optimaux dans l'EEPROM Micronova."""
        with self._lock:
            ok, flows, msg = self.engine.apply_offsets_one_click(write_fn, read_fn)
            if ok:
                self.save_session()
            return {
                "success": ok,
                "message": msg,
                "coupled_flows_kgh": flows,
                "result": asdict(self.engine.result) if self.engine.result else None,
            }

    def reset_session(self) -> dict[str, Any]:
        """Réinitialise la calibration et remet l'état à IDLE."""
        with self._lock:
            self.engine = NobisA10CalibrationEngine()
            self.active_step = 1
            conn = get_sys_db()
            try:
                conn.execute(
                    "DELETE FROM settings WHERE key = ?", (CALIBRATION_SETTINGS_KEY,)
                )
                conn.commit()
            finally:
                conn.close()
            logger.info("Session de calibration réinitialisée.")
            return {"status": "ok", "message": "Calibration réinitialisée."}


# Instance globale du service
_calibration_service_instance: NobisCalibrationService | None = None
_calibration_service_init_lock = threading.Lock()


def get_calibration_service() -> NobisCalibrationService:
    """Retourne le singleton thread-safe du service d'étalonnage Nobis A10."""
    global _calibration_service_instance
    if _calibration_service_instance is None:
        with _calibration_service_init_lock:
            if _calibration_service_instance is None:
                _calibration_service_instance = NobisCalibrationService()
    return _calibration_service_instance
