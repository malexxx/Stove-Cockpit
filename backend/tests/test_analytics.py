import unittest
from telemetry import (
    calculate_forecast_runway,
    evaluate_pellet_quality,
    evaluate_exhaust_quality,
    enrich_telemetry_record,
    check_power_stability,
    clamp_nobis_trim,
    _percentile,
    get_pellet_batch_state,
    save_pellet_batch_state,
    evaluate_batch_combustion_and_trim,
)
from config import HOPPER_CAPACITY_KG, DEFAULT_REGISTERS_CATALOG
from database import get_db, get_sys_db, init_all_databases


class TestAnalytics(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_all_databases()

    def test_hopper_capacity_35kg(self):
        self.assertEqual(HOPPER_CAPACITY_KG, 35.0)

    def test_trim_registers_bounds_config(self):
        pellet_reg = next(r for r in DEFAULT_REGISTERS_CATALOG if r["reg_key"] == "trim_pellet_pct")
        exhaust_reg = next(r for r in DEFAULT_REGISTERS_CATALOG if r["reg_key"] == "trim_exhaust_pct")
        self.assertEqual(pellet_reg["min_val"], -5)
        self.assertEqual(pellet_reg["max_val"], 5)
        self.assertEqual(exhaust_reg["min_val"], -5)
        self.assertEqual(exhaust_reg["max_val"], 5)

    def test_calculate_forecast_runway_positive(self):
        weather = {
            "weather_temp_ext": 10.0,
            "forecast_daily_means": [8.0, 7.5, 9.0, 10.0, 6.0],
        }
        runway = calculate_forecast_runway(150.0, weather)
        self.assertGreater(runway, 0.0)

    def test_calculate_forecast_runway_empty_stock(self):
        weather = {"weather_temp_ext": 10.0, "forecast_daily_means": []}
        runway = calculate_forecast_runway(0.0, weather)
        self.assertEqual(runway, 0.0)

    def test_calculate_forecast_runway_fractional_stock(self):
        weather = {"weather_temp_ext": 10.0, "forecast_daily_means": [10.0]}
        # 0.5 kg de pellets restant : doit produire une autonomie fractionnaire > 0.0
        runway = calculate_forecast_runway(0.5, weather)
        self.assertGreater(runway, 0.0)

    def test_evaluate_pellet_quality_active_nominal(self):
        # En travail P4 (cible 430 + 4*40 = 590), sonde flamme à 590°C -> Optimale
        res = evaluate_pellet_quality(
            status_code=5,
            power_actual=4,
            temp_probe_k=590.0,
            temp_fumes=180.0,
            current_trim=0,
            flame_delta_avg=0.0,
            stable_minutes=30,
            power_level=4,
            fans_active=True,
        )
        self.assertEqual(res["status"], "active")
        self.assertEqual(res["quality_color"], "emerald")
        self.assertFalse(res["action_needed"])

    def test_evaluate_pellet_quality_natural_convection_security(self):
        # Ventilateurs coupés (convection naturelle) -> tarage automatique verrouillé par sécurité
        res = evaluate_pellet_quality(
            status_code=5,
            power_actual=4,
            temp_probe_k=650.0,
            temp_fumes=210.0,
            current_trim=0,
            flame_delta_avg=40.0,
            stable_minutes=30,
            power_level=4,
            fans_active=False,
        )
        self.assertEqual(res["status"], "natural_convection")
        self.assertFalse(res["action_needed"])
        self.assertIn("convection naturelle", res["explanation"])

    def test_evaluate_pellet_quality_trim_bounds(self):
        # Forte dérive thermique (+80°C) -> le tarage doit rester borné à [-5, 5]
        res = evaluate_pellet_quality(
            status_code=5,
            power_actual=4,
            temp_probe_k=670.0,
            temp_fumes=200.0,
            current_trim=-4,
            flame_delta_avg=80.0,
            stable_minutes=30,
            power_level=4,
            fans_active=True,
        )
        self.assertEqual(res["status"], "active")
        self.assertEqual(res["suggested_trim"], -5)

    def test_evaluate_pellet_quality_stabilizing(self):
        # Moins de 30 min stables -> status stabilizing
        res = evaluate_pellet_quality(
            status_code=5,
            power_actual=4,
            temp_probe_k=590.0,
            temp_fumes=180.0,
            current_trim=0,
            flame_delta_avg=None,
            stable_minutes=12,
            power_level=4,
            fans_active=True,
        )
        self.assertEqual(res["status"], "stabilizing")

    def test_evaluate_exhaust_quality_nominal(self):
        # En travail P4 (cible dynamique Nobis = 2.0 + 4*0.25 = 3.0 Pa)
        res = evaluate_exhaust_quality(
            status_code=5,
            power_actual=4,
            depression_pa=3.0,
            exhaust_rpm=1750,
            current_trim=0,
            dep_delta_avg=0.0,
            stable_minutes=30,
            power_level=4,
            fans_active=True,
        )
        self.assertEqual(res["status"], "active")
        self.assertEqual(res["quality_color"], "emerald")
        self.assertEqual(res["target_depression_pa"], 3.0)
        self.assertFalse(res["action_needed"])

    def test_evaluate_exhaust_quality_bounds_clamp(self):
        # Dépression critique faible (0.8 Pa, sous le seuil AL11) -> tarage extracteur borné à +5%
        res = evaluate_exhaust_quality(
            status_code=5,
            power_actual=4,
            depression_pa=0.8,
            exhaust_rpm=1750,
            current_trim=4,
            dep_delta_avg=-2.2,
            stable_minutes=30,
            power_level=4,
            fans_active=True,
        )
        self.assertEqual(res["status"], "active")
        self.assertEqual(res["suggested_trim"], 5)
        self.assertTrue(res["action_needed"])

    def test_check_power_stability_fans_security(self):
        import sqlite3
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("""
            CREATE TABLE telemetry (
                epoch INTEGER,
                status_code INTEGER,
                power_actual INTEGER,
                power_level INTEGER,
                temp_probe_k REAL,
                depression_pa REAL,
                vent_front_actual INTEGER,
                duct_right_actual INTEGER,
                duct_left_actual INTEGER
            )
        """)
        now = 1000000
        # 1. Cas ventilateurs coupés (0, 0, 0) pendant 30 min
        for ep in range(now - 1800, now + 1, 60):
            conn.execute(
                "INSERT INTO telemetry VALUES (?, 5, 4, 4, 590.0, 3.0, 0, 0, 0)",
                (ep,)
            )
        is_stable, stable_min, rows, fans_active = check_power_stability(conn, now, 5, 4, 4, 1800)
        self.assertFalse(fans_active)
        self.assertFalse(is_stable)
        self.assertEqual(stable_min, 30)

        # 2. Cas ventilateur frontal actif (vent_front = 2)
        conn.execute("UPDATE telemetry SET vent_front_actual = 2")
        is_stable_act, _, _, fans_active_act = check_power_stability(conn, now, 5, 4, 4, 1800)
        self.assertTrue(fans_active_act)
        self.assertTrue(is_stable_act)
        conn.close()

    def test_enrich_telemetry_record(self):
        conn = get_db("simulation")
        try:
            fake_record = {
                "epoch": 1793800000,
                "status_code": 5,
                "power_actual": 4,
                "power_level": 4,
                "temp_probe_k": 590.0,
                "temp_fumes": 180.0,
                "depression_pa": 3.0,
                "exhaust_rpm": 1750,
                "trim_pellet_pct": 0,
                "trim_exhaust_pct": 0,
                "flame_delta_avg": 0.0,
                "dep_delta_avg": 0.0,
            }
            enriched = enrich_telemetry_record(conn, fake_record)
            self.assertIn("conso_week_kg", enriched)
            self.assertIn("conso_month_kg", enriched)
            self.assertIn("pellet_quality", enriched)
            self.assertIn("exhaust_quality", enriched)
        finally:
            conn.close()

    def test_clamp_nobis_trim(self):
        self.assertEqual(clamp_nobis_trim(-10), -5)
        self.assertEqual(clamp_nobis_trim(-5), -5)
        self.assertEqual(clamp_nobis_trim(0), 0)
        self.assertEqual(clamp_nobis_trim(3.4), 3)
        self.assertEqual(clamp_nobis_trim(5), 5)
        self.assertEqual(clamp_nobis_trim(8), 5)

    def test_percentile_helper(self):
        self.assertEqual(_percentile([], 0.9), 0.0)
        self.assertEqual(_percentile([10.0], 0.9), 10.0)
        data = [10.0, 20.0, 30.0, 40.0, 50.0]
        self.assertAlmostEqual(_percentile(data, 0.5), 30.0)
        self.assertAlmostEqual(_percentile(data, 0.9), 46.0)
        # Test d'interpolation intermédiaire (non-entier, f+1 < len-1) pour valider l'index plafond
        self.assertAlmostEqual(_percentile(data, 0.3), 22.0)

    def test_pellet_batch_state_lifecycle(self):
        initial_state = get_pellet_batch_state()
        self.assertIn("raz_epoch", initial_state)
        self.assertIn("pellet_brand", initial_state)

        test_state = {
            "raz_epoch": 12345678,
            "raz_timestamp": "2026-11-05 12:00:00",
            "pellet_brand": "Test Pellet Brand",
            "baseline_rpm_per_pa": 550.0,
            "last_applied_epoch": 12345678,
        }
        save_pellet_batch_state(test_state)
        loaded = get_pellet_batch_state()
        self.assertEqual(loaded["pellet_brand"], "Test Pellet Brand")
        self.assertEqual(loaded["baseline_rpm_per_pa"], 550.0)

        # Restore initial state
        save_pellet_batch_state(initial_state)

    def test_pellet_batch_state_fallback_defaults(self):
        initial_state = get_pellet_batch_state()
        conn = get_sys_db()
        try:
            conn.execute("DELETE FROM settings WHERE key = 'pellet_batch_state'")
            conn.commit()
            state = get_pellet_batch_state()
            self.assertEqual(state["raz_epoch"], 0)
            self.assertEqual(state["raz_timestamp"], "Initialisation")
            self.assertEqual(state["pellet_brand"], "Lot Standard DINplus / ENplus A1")
            self.assertIsNone(state["baseline_rpm_per_pa"])
            self.assertEqual(state["last_applied_epoch"], 0)
        finally:
            conn.close()
            save_pellet_batch_state(initial_state)

    def test_evaluate_batch_combustion_and_trim(self):
        conn = get_db("simulation")
        try:
            fake_record = {
                "epoch": 1793800000,
                "status_code": 5,
                "power_actual": 4,
                "temp_probe_k": 590.0,
                "temp_fumes": 140.0,
                "depression_pa": 3.0,
                "exhaust_rpm": 1750,
                "trim_pellet_pct": 0,
                "trim_exhaust_pct": 0,
            }
            pellet_q, exhaust_q = evaluate_batch_combustion_and_trim(conn, fake_record)
            self.assertIn("status", pellet_q)
            self.assertIn("suggested_trim", pellet_q)
            self.assertIn("current_trim", pellet_q)
            self.assertIn("explanation", pellet_q)
            self.assertIn("status", exhaust_q)
            self.assertIn("suggested_trim", exhaust_q)

            # Ensure suggested trims stay strictly clamped between -5 and 5
            self.assertGreaterEqual(pellet_q["suggested_trim"], -5)
            self.assertLessEqual(pellet_q["suggested_trim"], 5)
            self.assertGreaterEqual(exhaust_q["suggested_trim"], -5)
            self.assertLessEqual(exhaust_q["suggested_trim"], 5)
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
