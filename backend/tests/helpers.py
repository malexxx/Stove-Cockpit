"""Utilitaires et classes de base partagés pour la suite de tests Nobis.Supervisor."""
from contextlib import contextmanager
import unittest

from fastapi.testclient import TestClient

from database import encrypt_setting_value, get_sys_db, init_all_databases
from main import app
from matter_service import matter_manager


def get_matter_webhook_headers(extra: dict | None = None) -> dict:
    """Retourne l'en-tête interne X-Matter-Secret attendu par /api/matter/webhook."""
    headers = {"X-Matter-Secret": matter_manager.webhook_secret}
    if extra:
        headers.update(extra)
    return headers
from src.calibration.nobis_calibration import (
    CalibrationMode,
    CalibrationResult,
    PhaseBreakdownStats,
)


@contextmanager
def temporary_settings(overrides: dict):
    """Sauvegarde et restaure strictement les clés modifiées dans settings."""
    conn = get_sys_db()
    originals = {}
    try:
        for k, v in overrides.items():
            row = conn.execute("SELECT value FROM settings WHERE key = ?", (k,)).fetchone()
            originals[k] = row["value"] if row is not None else None
            if v is None:
                conn.execute("DELETE FROM settings WHERE key = ?", (k,))
            else:
                conn.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                    (k, encrypt_setting_value(k, str(v))),
                )
        conn.commit()
    finally:
        conn.close()

    try:
        yield
    finally:
        conn = get_sys_db()
        try:
            for k, orig in originals.items():
                if orig is None:
                    conn.execute("DELETE FROM settings WHERE key = ?", (k,))
                else:
                    conn.execute(
                        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                        (k, orig),
                    )
            conn.commit()
        finally:
            conn.close()


def make_calibration_result(off70: int = 2, off71: int = -1) -> CalibrationResult:
    """Construit un objet CalibrationResult factice pour les tests de régression."""
    return CalibrationResult(
        mode=CalibrationMode.COMBINED_BOTH,
        weighed_bag_kg=15.0,
        intrinsic_k_factor=1.0,
        before_flows_kgh={4: 1.51},
        measured_raw_flows_kgh={4: 1.51},
        coupled_effective_flows_kgh={4: 1.51},
        recommended_offset_70=off70,
        recommended_offset_71=off71,
        current_offset_70=0,
        current_offset_71=0,
        time_per_power_hours={4: 2.0},
        phase_stats=PhaseBreakdownStats(),
        mean_smoke_temp_delta_c=0.0,
        mean_pressure_error_pct=0.0,
        diagnostic_summary="Test diagnostic",
        closed_by_al03=True,
    )


class BugBountyTestCase(unittest.TestCase):
    """Classe de base pour les tests de régression sécurité/calibration/télémétrie."""

    @classmethod
    def setUpClass(cls):
        init_all_databases()
        cls.client = TestClient(app, raise_server_exceptions=False)


class SimulationApiTestCase(unittest.TestCase):
    """Classe de base configurant temporairement le mode simulation avec restauration propre."""

    @classmethod
    def setUpClass(cls):
        sconn = get_sys_db()
        try:
            row = sconn.execute("SELECT value FROM settings WHERE key = 'comm_mode'").fetchone()
            cls.orig_comm_mode = row["value"] if (row and row["value"]) else "agua_cloud"
            sconn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('comm_mode', 'simulation')")
            sconn.commit()
        finally:
            sconn.close()
        cls.client = TestClient(app, raise_server_exceptions=False)

    @classmethod
    def tearDownClass(cls):
        sconn = get_sys_db()
        try:
            mode = getattr(cls, "orig_comm_mode", "agua_cloud") or "agua_cloud"
            sconn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('comm_mode', ?)", (mode,))
            sconn.commit()
        finally:
            sconn.close()
