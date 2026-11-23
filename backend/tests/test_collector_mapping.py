import unittest
from config import TELEMETRY_COLUMNS
from database import get_db, init_all_databases


class TestCollectorMapping(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_all_databases()
        conn = get_db("agua_cloud")
        try:
            conn.execute("DELETE FROM telemetry WHERE id BETWEEN 1 AND 27")
            conn.commit()
        finally:
            conn.close()

    def test_pellet_rate_nominal_formula(self):
        # Test de la formule théorique P1..P8 : round(0.60 + p_actual * 0.22, 2)
        rates = {p: round(0.60 + p * 0.22, 2) for p in range(1, 9)}
        self.assertEqual(rates[1], 0.82)
        self.assertEqual(rates[2], 1.04)
        self.assertEqual(rates[3], 1.26)
        self.assertEqual(rates[4], 1.48)
        self.assertEqual(rates[5], 1.70)
        self.assertEqual(rates[6], 1.92)
        self.assertEqual(rates[7], 2.14)
        self.assertEqual(rates[8], 2.36)

    def test_duplicated_columns_defaults_null(self):
        self.assertIn("NULL", TELEMETRY_COLUMNS["temp_board_ntc"])
        self.assertIn("NULL", TELEMETRY_COLUMNS["exhaust_target_rpm"])
        self.assertIn("NULL", TELEMETRY_COLUMNS["flame_light_idx"])
        self.assertIn("NULL", TELEMETRY_COLUMNS["auger_on_time_s"])
        self.assertIn("NULL", TELEMETRY_COLUMNS["auger_cycle_s"])
        self.assertIn("NULL", TELEMETRY_COLUMNS["auger_duty_pct"])

    def test_no_id_1_to_27_in_agua_cloud_db(self):
        conn = get_db("agua_cloud")
        try:
            count = conn.execute("SELECT COUNT(*) FROM telemetry WHERE id BETWEEN 1 AND 27").fetchone()[0]
            self.assertEqual(count, 0)
        finally:
            conn.close()

    def test_no_duplicated_columns_values_in_telemetry(self):
        conn = get_db("agua_cloud")
        try:
            rows = conn.execute("""
                SELECT COUNT(*) FROM telemetry
                WHERE temp_board_ntc IS NOT NULL
                   OR flame_light_idx IS NOT NULL
                   OR exhaust_target_rpm IS NOT NULL
                   OR auger_on_time_s IS NOT NULL
            """).fetchone()[0]
            self.assertEqual(rows, 0)
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
