"""Tests de validation de contrats d'API et détection d'anomalies via Schemathesis."""
import unittest
import schemathesis
from main import app
from database import get_sys_db

# S'assurer que le mode simulation est actif pour l'introspection OpenAPI ASGI, puis restaurer
_sconn = get_sys_db()
_orig_import_mode = "agua_cloud"
try:
    _row = _sconn.execute("SELECT value FROM settings WHERE key = 'comm_mode'").fetchone()
    if _row and _row["value"]:
        _orig_import_mode = _row["value"]
    _sconn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('comm_mode', 'simulation')")
    _sconn.commit()
finally:
    _sconn.close()

# Chargement in-process de la spécification OpenAPI depuis l'application FastAPI
schema = schemathesis.openapi.from_asgi("/openapi.json", app)

_sconn_restore = get_sys_db()
try:
    _sconn_restore.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('comm_mode', ?)", (_orig_import_mode,))
    _sconn_restore.commit()
finally:
    _sconn_restore.close()


class TestSchemathesisContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from database import get_sys_db
        sconn = get_sys_db()
        try:
            row = sconn.execute("SELECT value FROM settings WHERE key = 'comm_mode'").fetchone()
            cls.orig_comm_mode = row["value"] if (row and row["value"]) else "agua_cloud"
            sconn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('comm_mode', 'simulation')")
            sconn.commit()
        finally:
            sconn.close()

    @classmethod
    def tearDownClass(cls):
        from database import get_sys_db
        sconn = get_sys_db()
        try:
            mode = getattr(cls, "orig_comm_mode", "agua_cloud") or "agua_cloud"
            sconn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('comm_mode', ?)", (mode,))
            sconn.commit()
        finally:
            sconn.close()

    def test_openapi_schema_structure(self):
        """Vérifie que le schéma OpenAPI est complet et valide."""
        self.assertIsNotNone(schema.raw_schema)
        self.assertIn("paths", schema.raw_schema)
        paths = schema.raw_schema["paths"]
        self.assertIn("/health", paths)
        self.assertIn("/api/latest", paths)
        self.assertIn("/api/dashboard", paths)
        self.assertIn("/api/silence/status", paths)
        self.assertIn("/api/snapshots", paths)

    def test_health_contract(self):
        """Valide le contrat OpenAPI sur l'endpoint /health."""
        case = schema["/health"]["GET"].as_strategy().example()
        response = case.call()
        self.assertEqual(response.status_code, 200)
        case.validate_response(response)

    def test_api_latest_contract(self):
        """Valide le contrat OpenAPI sur l'endpoint /api/latest."""
        case = schema["/api/latest"]["GET"].as_strategy().example()
        response = case.call()
        self.assertEqual(response.status_code, 200)
        case.validate_response(response)

    def test_api_dashboard_contract(self):
        """Valide le contrat OpenAPI sur l'endpoint /api/dashboard."""
        case = schema["/api/dashboard"]["GET"].as_strategy().example()
        response = case.call()
        self.assertEqual(response.status_code, 200)
        case.validate_response(response)

    def test_silence_status_contract(self):
        """Valide le contrat OpenAPI sur l'endpoint /api/silence/status."""
        case = schema["/api/silence/status"]["GET"].as_strategy().example()
        response = case.call()
        self.assertEqual(response.status_code, 200)
        case.validate_response(response)

    def test_snapshots_list_contract(self):
        """Valide le contrat OpenAPI sur l'endpoint /api/snapshots."""
        case = schema["/api/snapshots"]["GET"].as_strategy().example()
        response = case.call()
        self.assertEqual(response.status_code, 200)
        case.validate_response(response)


if __name__ == "__main__":
    unittest.main()
