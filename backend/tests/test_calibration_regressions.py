# -*- coding: utf-8 -*-
"""Tests de régression de l'assistant d'étalonnage couplé Nobis A10 (BB-02, BB-04, BB-05, BB-07)."""
import time
from unittest.mock import AsyncMock, patch

from database import get_db
from src.calibration.calibration_service import (
    CALIBRATION_SETTINGS_KEY,
    build_sample_from_record,
    get_calibration_service,
)
from src.calibration.nobis_calibration import CalibrationState
from tests.helpers import (
    BugBountyTestCase,
    get_installer_auth_headers,
    make_calibration_result as _make_calibration_result,
    temporary_settings,
)


class TestCalibrationRegressions(BugBountyTestCase):
    def test_bb02_calibration_step1_and_step2_await_and_send_170_not_85(self):
        srv = get_calibration_service()
        with temporary_settings({"comm_mode": "simulation", CALIBRATION_SETTINGS_KEY: None}):
            srv.reset_session()
            sconn = get_db("simulation")
            row_id = None
            try:
                cur = sconn.execute(
                    "INSERT INTO telemetry (epoch, timestamp, status_code, alarm_code, power_level, power_actual, fun_pwf_set) "
                    "VALUES (?, ?, 10, 3, 4, 4, 1)",
                    (int(time.time()) + 60, "2026-11-15T12:00:00"),
                )
                row_id = cur.lastrowid
                sconn.commit()
            finally:
                sconn.close()

            try:
                headers = get_installer_auth_headers(self.client)
                with patch("routers.calibration.execute_register_write", new_callable=AsyncMock) as mock_write:
                    mock_write.return_value = {"status": "ok"}

                    r1 = self.client.post("/api/calibration/step1-start", json={"mode": "COMBINED_BOTH"}, headers=headers)
                    self.assertEqual(r1.status_code, 200)
                    mock_write.assert_awaited_with("fun_pwf_set", 0.0, 33154, skip_poll=True)

                    mock_write.reset_mock()
                    srv.engine.state = CalibrationState.WAITING_INITIAL_AL03
                    r2 = self.client.post("/api/calibration/step2-confirm-al03", headers=headers)
                    self.assertEqual(r2.status_code, 200)
                    mock_write.assert_awaited_once_with("status_code", 170.0, 232, skip_poll=True)
                    for call in mock_write.await_args_list:
                        self.assertNotEqual(call.args[1], 85.0)
            finally:
                srv.reset_session()
                if row_id is not None:
                    sconn = get_db("simulation")
                    try:
                        sconn.execute("DELETE FROM telemetry WHERE id = ?", (row_id,))
                        sconn.commit()
                    finally:
                        sconn.close()

    def test_bb04_optical_reserve_not_mapped_to_al03_or_starvation(self):
        sample_reserve = build_sample_from_record(
            {
                "epoch": 1700000000,
                "status_code": 5,
                "alarm_code": 0,
                "popup_pellet_empty": 1,
                "power_level": 4,
                "power_actual": 4,
                "auger_rpm_actual": 3.0,
                "auger_rpm_set": 3.0,
                "depression_pa": 3.0,
            }
        )
        self.assertIsNone(sample_reserve.alarm_code)
        self.assertEqual(sample_reserve.auger_current_ma, 150.0)
        self.assertNotEqual(sample_reserve.auger_current_ma, 45.0)

        sample_al03 = build_sample_from_record(
            {
                "epoch": 1700000060,
                "status_code": 10,
                "alarm_code": 3,
                "popup_pellet_empty": 0,
                "power_level": 4,
                "power_actual": 4,
            }
        )
        self.assertEqual(sample_al03.alarm_code, "AL-03")
        self.assertEqual(sample_al03.auger_current_ma, 45.0)

    def test_bb05_dual_scale_target_coax_pa(self):
        low_p4 = build_sample_from_record({"epoch": 1, "status_code": 5, "power_level": 4, "depression_pa": 3.0})
        self.assertEqual(low_p4.flue_pressure_set_pa, 3.0)

        low_p7 = build_sample_from_record({"epoch": 2, "status_code": 5, "power_level": 7, "depression_pa": 2.5})
        self.assertEqual(low_p7.flue_pressure_set_pa, 3.75)

        bench = build_sample_from_record({"epoch": 3, "status_code": 5, "power_level": 4, "depression_pa": 18.2})
        self.assertEqual(bench.flue_pressure_set_pa, 18.0)

    def test_bb07_calibration_step5_apply_real_readback_and_agua_cloud_flag(self):
        srv = get_calibration_service()
        with temporary_settings({"comm_mode": "simulation", CALIBRATION_SETTINGS_KEY: None}):
            srv.reset_session()
            try:
                headers = get_installer_auth_headers(self.client)
                srv.engine.state = CalibrationState.COMPLETED_LOCKED
                srv.engine.result = _make_calibration_result(off70=2, off71=-1)

                with (
                    patch("routers.calibration.execute_registers_batch_write", new_callable=AsyncMock) as mock_batch,
                    patch(
                        "routers.calibration.get_registers_dict",
                        return_value={
                            "trim_pellet_pct": {"current_val": 2.0, "offset": 70},
                            "trim_exhaust_pct": {"current_val": -1.0, "offset": 71},
                        },
                    ),
                ):
                    mock_batch.return_value = {"status": "ok"}
                    r_ok = self.client.post("/api/calibration/step5-apply", headers=headers)
                    self.assertEqual(r_ok.status_code, 200)
                    body_ok = r_ok.json()
                    self.assertTrue(body_ok["success"])
                    self.assertNotIn("remote_manual_required", body_ok)
                    mock_batch.assert_awaited_once()

                with (
                    patch("routers.calibration.execute_registers_batch_write", new_callable=AsyncMock) as mock_batch,
                    patch(
                        "routers.calibration.get_registers_dict",
                        return_value={
                            "trim_pellet_pct": {"current_val": 0.0, "offset": 70},
                            "trim_exhaust_pct": {"current_val": 0.0, "offset": 71},
                        },
                    ),
                ):
                    mock_batch.return_value = {"status": "ok"}
                    r_mismatch = self.client.post("/api/calibration/step5-apply", headers=headers)
                    self.assertEqual(r_mismatch.status_code, 200)
                    body_mismatch = r_mismatch.json()
                    self.assertFalse(body_mismatch["success"])
                    self.assertIn("relecture", body_mismatch["message"])

                with temporary_settings({"comm_mode": "agua_cloud"}):
                    with (
                        patch("routers.calibration.execute_registers_batch_write", new_callable=AsyncMock) as mock_batch,
                        patch(
                            "routers.calibration.get_registers_dict",
                            return_value={
                                "trim_pellet_pct": {"current_val": 2.0, "offset": 70},
                                "trim_exhaust_pct": {"current_val": -1.0, "offset": 71},
                            },
                        ),
                    ):
                        mock_batch.return_value = {"status": "ok"}
                        r_cloud = self.client.post("/api/calibration/step5-apply", headers=headers)
                        self.assertEqual(r_cloud.status_code, 200)
                        body_cloud = r_cloud.json()
                        self.assertTrue(body_cloud["success"])
                        self.assertTrue(body_cloud["remote_manual_required"])
            finally:
                srv.reset_session()
