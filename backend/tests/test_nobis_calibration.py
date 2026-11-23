# -*- coding: utf-8 -*-
"""
Tests unitaires du processus d'étalonnage couplé Nobis A10 (Nobis.Supervisor).
Exécution : pytest tests/test_nobis_calibration.py
"""

import unittest
from src.calibration.nobis_calibration import (
    NobisA10CalibrationEngine,
    CalibrationMode,
    CalibrationState,
    StoveOperationalPhase,
    TelemetrySample,
)
from src.calibration.calibration_wizard import NobisCalibrationWizard


def make_sample(
    ts: float,
    phase: StoveOperationalPhase = StoveOperationalPhase.WORK,
    power: int = 4,
    alarm: str = None,
    rpm_actual: float = 594.0,
    rpm_set: float = 594.0,
    current_ma: float = 150.0,
    prs_pa: float = 16.4,
    set_prs_pa: float = 18.0,
    flame_c: float = 620.0,
    smoke_c: float = 140.5,
    off70: int = 0,
    off71: int = 0,
    pwf_mode: str = "OFF",
) -> TelemetrySample:
    return TelemetrySample(
        timestamp=ts,
        phase=phase,
        power_level=power,
        alarm_code=alarm,
        auger_rpm_actual=rpm_actual,
        auger_rpm_set=rpm_set,
        auger_current_ma=current_ma,
        flue_pressure_pa=prs_pa,
        flue_pressure_set_pa=set_prs_pa,
        smoke_extractor_rpm=1850.0,
        flame_temp_c=flame_c,
        smoke_temp_c=smoke_c,
        room_temp_c=20.5,
        offset_70_pellet=off70,
        offset_71_air=off71,
        powerful_enabled_mode=pwf_mode,
    )


class TestNobisA10Calibration(unittest.TestCase):

    def test_full_cycle_with_startup_rpm_and_starvation_filtering(self):
        engine = NobisA10CalibrationEngine()
        engine.start_process(CalibrationMode.COMBINED_BOTH)

        # 1. Pré-contrôle avec désactivation automatique de P8 (POWERFUL)
        p8_disabled = False

        def disable_p8_cb():
            nonlocal p8_disabled
            p8_disabled = True
            return True

        s0 = make_sample(0.0, phase=StoveOperationalPhase.ALARM, alarm="AL-03", pwf_mode="ON")
        ok, _ = engine.verify_preflight_and_disable_p8(s0, disable_p8_callback=disable_p8_cb)
        self.assertTrue(ok)
        self.assertTrue(p8_disabled)
        self.assertEqual(engine.state, CalibrationState.WAITING_INITIAL_AL03)

        # 2. Confirmation AL-03 initial puis chargement de 15,000 kg en état ÉTEINT
        ok, _ = engine.confirm_initial_al03(s0)
        self.assertTrue(ok)
        s_off = make_sample(60.0, phase=StoveOperationalPhase.OFF)
        ok, _ = engine.confirm_stove_off_and_load_charge(s_off, weighed_bag_kg=15.000)
        self.assertTrue(ok)
        self.assertEqual(engine.state, CalibrationState.RUNNING_ACQUISITION)

        # 3. Séquence d'allumage (MISE_EN_MARCHE -> ATTENTE_FLAMME (0 RPM) -> PHASE_FLAMME)
        ts = 100.0
        engine.ingest_telemetry(make_sample(ts, phase=StoveOperationalPhase.STARTING, rpm_actual=425.0))
        ts += 180.0  # 3 min de pré-charge à 50% de P7
        engine.ingest_telemetry(make_sample(ts, phase=StoveOperationalPhase.STARTING, rpm_actual=425.0))
        ts += 240.0  # 4 min d'ATTENTE_FLAMME avec vis à 0 RPM (ne doit consommer aucun granulé)
        engine.ingest_telemetry(make_sample(ts, phase=StoveOperationalPhase.WAITING_FLAME, rpm_actual=0.0))
        ts += 180.0  # 3 min de PHASE_FLAMME à 425 RPM
        engine.ingest_telemetry(make_sample(ts, phase=StoveOperationalPhase.FLAME_PHASE, rpm_actual=425.0))

        self.assertEqual(engine.phase_stats.ignition_cycles_count, 1)
        self.assertTrue(engine.startup_rpm_telemetry_available)

        # 4. Phase TRAVAIL sur P4 pendant 9,5 heures (34 200 s) par pas de 300 s
        for _ in range(114):
            ts += 300.0
            engine.ingest_telemetry(
                make_sample(ts, phase=StoveOperationalPhase.WORK, power=4, smoke_c=141.0, prs_pa=16.2)
            )

        # 5. Simulation de 5 minutes de famine en fin de cuve juste avant AL-03
        # Courant vis tombe à 45 mA (< 65 mA) et la flamme décroche de 620°C à 350°C
        ts += 300.0
        engine.ingest_telemetry(
            make_sample(
                ts,
                phase=StoveOperationalPhase.WORK,
                power=4,
                current_ma=45.0,
                flame_c=350.0,
                smoke_c=95.0,
            )
        )
        self.assertAlmostEqual(engine.phase_stats.starvation_pre_al03_ignored_min, 5.0, places=1)

        # 6. Déclenchement de l'alarme finale AL-03
        ts += 60.0
        engine.ingest_telemetry(
            make_sample(ts, phase=StoveOperationalPhase.ALARM, alarm="AL-03", current_ma=0.0)
        )
        self.assertEqual(engine.state, CalibrationState.COMPLETED_LOCKED)
        self.assertIsNotNone(engine.result)
        self.assertTrue(engine.result.closed_by_al03)
        self.assertGreater(engine.result.intrinsic_k_factor, 1.02)
        self.assertLess(engine.result.recommended_offset_70, 0)
        self.assertGreater(engine.result.recommended_offset_71, 0)

    def test_wizard_step_by_step_and_one_click_apply(self):
        engine = NobisA10CalibrationEngine()
        eeprom_memory = {70: 0, 71: 0}
        pwf_state = "ON"
        alarm_reset_called = False

        def mock_disable_pwf():
            nonlocal pwf_state
            pwf_state = "OFF"
            return True

        def mock_reset_alarm():
            nonlocal alarm_reset_called
            alarm_reset_called = True
            return True

        def mock_write_reg(reg: int, val: int) -> bool:
            eeprom_memory[reg] = val
            return True

        def mock_read_reg(reg: int) -> int:
            return eeprom_memory.get(reg, 0)

        wizard = NobisCalibrationWizard(
            engine=engine,
            api_disable_powerful_fn=mock_disable_pwf,
            api_reset_alarm_fn=mock_reset_alarm,
            api_write_register_fn=mock_write_reg,
            api_read_register_fn=mock_read_reg,
        )

        s0 = make_sample(0.0, phase=StoveOperationalPhase.ALARM, alarm="AL-03", pwf_mode=pwf_state)
        res1 = wizard.step1_configure_and_preflight("COMBINED_BOTH", s0)
        self.assertTrue(res1["success"])
        self.assertTrue(res1["p8_auto_disabled"])
        self.assertEqual(pwf_state, "OFF")

        res2 = wizard.step2_verify_empty_hopper_al03(s0, auto_reset_alarm=True)
        self.assertTrue(res2["success"])
        self.assertTrue(alarm_reset_called)

        s_off = make_sample(60.0, phase=StoveOperationalPhase.OFF)
        res3 = wizard.step3_register_weighed_charge(s_off, weighed_bag_kg=15.0, aspirated_priming_grams=120.0)
        self.assertTrue(res3["success"])
        self.assertEqual(res3["net_calibrated_mass_kg"], 14.88)

        # Ingestion de 10 heures sur P4
        ts = 100.0
        engine.ingest_telemetry(make_sample(ts, phase=StoveOperationalPhase.STARTING, rpm_actual=425.0))
        ts += 300.0
        engine.ingest_telemetry(make_sample(ts, phase=StoveOperationalPhase.STARTING, rpm_actual=425.0))
        for _ in range(120):
            ts += 300.0
            s_work = make_sample(ts, phase=StoveOperationalPhase.WORK, power=4, smoke_c=138.0, prs_pa=18.0)
            wizard.step4_poll_status(s_work)

        # Alarme finale AL-03
        ts += 60.0
        s_final = make_sample(ts, phase=StoveOperationalPhase.ALARM, alarm="AL-03")
        res4 = wizard.step4_poll_status(s_final)
        self.assertEqual(res4["step"], 5)
        self.assertEqual(res4["state"], CalibrationState.COMPLETED_LOCKED.value)

        # Étape 5 : Application en 1 clic
        res5 = wizard.step5_apply_recommended_settings()
        self.assertTrue(res5["success"])
        self.assertEqual(eeprom_memory[70], engine.result.recommended_offset_70)
        self.assertEqual(eeprom_memory[71], engine.result.recommended_offset_71)

    def test_engine_serialization_roundtrip_persistence(self):
        """Vérifie que le moteur peut être sérialisé et restauré depuis SQLite sans perte."""
        engine = NobisA10CalibrationEngine()
        engine.start_process(CalibrationMode.COMBINED_BOTH)
        s0 = make_sample(0.0, phase=StoveOperationalPhase.ALARM, alarm="AL-03")
        engine.confirm_initial_al03(s0)
        s_off = make_sample(60.0, phase=StoveOperationalPhase.OFF)
        engine.confirm_stove_off_and_load_charge(s_off, weighed_bag_kg=15.0, priming_aspirated_kg=0.2)

        # Ingestion de quelques échantillons
        ts = 100.0
        engine.ingest_telemetry(make_sample(ts, phase=StoveOperationalPhase.STARTING, rpm_actual=425.0))
        ts += 300.0
        engine.ingest_telemetry(make_sample(ts, phase=StoveOperationalPhase.WORK, power=4, smoke_c=136.0))

        # Sérialisation
        dump = engine.to_dict()
        self.assertEqual(dump["state"], CalibrationState.RUNNING_ACQUISITION.value)
        self.assertEqual(dump["weighed_mass_kg"], 15.0)
        self.assertEqual(dump["priming_extracted_mass_kg"], 0.2)

        # Restauration
        restored = NobisA10CalibrationEngine.from_dict(dump)
        self.assertEqual(restored.state, CalibrationState.RUNNING_ACQUISITION)
        self.assertEqual(restored.weighed_mass_kg, 15.0)
        self.assertEqual(restored.priming_extracted_mass_kg, 0.2)
        self.assertAlmostEqual(
            restored.get_current_estimated_consumed_mass_kg(),
            engine.get_current_estimated_consumed_mass_kg(),
            places=3
        )

    def test_calibration_service_background_flow(self):
        """Vérifie que NobisCalibrationService gère les étapes et persiste en tâche de fond."""
        from src.calibration.calibration_service import get_calibration_service
        service = get_calibration_service()
        service.reset_session()

        status_idle = service.get_status()
        self.assertEqual(status_idle["step"], 1)
        self.assertEqual(status_idle["state"], "IDLE")

        # Step 1
        s0 = make_sample(0.0, phase=StoveOperationalPhase.ALARM, alarm="AL-03", pwf_mode="OFF")
        r1 = service.start_preflight("COMBINED_BOTH", s0)
        self.assertTrue(r1["success"])
        self.assertEqual(service.active_step, 2)

        # Step 2
        r2 = service.confirm_initial_al03(s0)
        self.assertTrue(r2["success"])
        self.assertEqual(service.active_step, 3)

        # Step 3
        s_off = make_sample(60.0, phase=StoveOperationalPhase.OFF)
        r3 = service.load_weighed_charge(s_off, weighed_bag_kg=15.0, aspirated_priming_g=0.0)
        self.assertTrue(r3["success"])
        self.assertEqual(service.active_step, 4)

        # Simulation cycle télémétrie en arrière-plan
        rec = {
            "epoch": 200,
            "status_code": 5,
            "power_actual": 4,
            "temp_probe_k": 620.0,
            "temp_fumes": 140.0,
            "depression_pa": 17.5,
            "exhaust_rpm": 1850,
            "alarm_code": 0
        }
        service.process_telemetry_record(rec)

        # Vérification qu'une nouvelle instance du service recharge l'état exact depuis SQLite
        from src.calibration.calibration_service import NobisCalibrationService
        new_instance = NobisCalibrationService()
        self.assertEqual(new_instance.active_step, 4)
        self.assertEqual(new_instance.engine.state, CalibrationState.RUNNING_ACQUISITION)
        self.assertEqual(new_instance.engine.weighed_mass_kg, 15.0)

        # Reset
        service.reset_session()
        self.assertEqual(service.active_step, 1)


if __name__ == "__main__":
    unittest.main()
