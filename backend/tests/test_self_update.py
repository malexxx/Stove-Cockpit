"""Tests unitaires et d'intégration pour le système de mise à jour interne au conteneur."""
import asyncio
from contextlib import asynccontextmanager
import io
import os
import tarfile
import tempfile
from unittest.mock import patch

import config
import database
from services.installer_auth import clear_installer_sessions
from services.update_bootstrap import (
    build_child_env,
    compare_versions,
    is_valid_release_dir,
    mark_active_release_healthy,
    parse_semver_tuple,
    read_update_state,
    resolve_boot_target,
    rollback_after_boot_failure,
    write_update_state,
)
from services.update_service import (
    _extract_tarball_safely,
    _validate_github_url,
    _validate_staged_release,
    apply_internal_update,
    rollback_internal_update,
)
import server as server_mod
from tests.helpers import BugBountyTestCase, temporary_settings


def _build_synthetic_release_tarball(app_version: str = "2.4.0", *, broken_syntax: bool = False) -> bytes:
    with open(os.path.join(config.BASE_DIR, "requirements.txt"), encoding="utf-8") as fh:
        req_txt = fh.read()
    with open(os.path.join(config.BASE_DIR, "matter_bridge", "package.json"), encoding="utf-8") as fh:
        pkg_json = fh.read()

    files: dict[str, str] = {
        "malexxx-Nobis.Supervisor-abcdef1/server.py": "def main():\n    pass\n",
        "malexxx-Nobis.Supervisor-abcdef1/main.py": "app = object()\n",
        "malexxx-Nobis.Supervisor-abcdef1/config.py": (
            'import os\n'
            f'APP_VERSION: str = os.environ.get("APP_VERSION", "{app_version}").strip() or "{app_version}"\n'
        ),
        "malexxx-Nobis.Supervisor-abcdef1/requirements.txt": req_txt,
        "malexxx-Nobis.Supervisor-abcdef1/routers/admin.py": "# router\n",
        "malexxx-Nobis.Supervisor-abcdef1/services/update_service.py": (
            "def broken(:\n" if broken_syntax else "# service\n"
        ),
        "malexxx-Nobis.Supervisor-abcdef1/static/index.html": "<html></html>\n",
        "malexxx-Nobis.Supervisor-abcdef1/static/css/tailwind.generated.css": "body{}\n",
        "malexxx-Nobis.Supervisor-abcdef1/matter_bridge/package.json": pkg_json,
    }

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for arc_name, text in files.items():
            raw = text.encode("utf-8")
            ti = tarfile.TarInfo(arc_name)
            ti.size = len(raw)
            tf.addfile(ti, io.BytesIO(raw))
    return buf.getvalue()


class _FakeResp:
    def __init__(self, status_code: int, json_data=None, text_data: str = "", headers=None):
        self.status_code = status_code
        self._json = json_data
        self.text = text_data
        self.headers = headers or {}

    def json(self):
        return self._json


class _FakeStreamResp:
    def __init__(self, status_code: int, body: bytes = b"", headers=None):
        self.status_code = status_code
        self._body = body
        self.headers = headers or {}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def aiter_bytes(self, chunk_size: int = 65536):
        for idx in range(0, len(self._body), chunk_size):
            yield self._body[idx : idx + chunk_size]


class _FakeGitHubClient:
    def __init__(self, remote_sha: str, tar_bytes: bytes):
        self.remote_sha = remote_sha
        self.tar_bytes = tar_bytes

    async def get(self, url: str, **_kwargs):
        if "/commits/main" in url or "/commits/v2" in url:
            return _FakeResp(
                200,
                json_data={
                    "sha": self.remote_sha,
                    "html_url": "https://github.com/malexxx/Stove-Cockpit/commit/" + self.remote_sha,
                    "commit": {
                        "message": "feat: version 2.5.0 test",
                        "committer": {"date": "2026-11-23T00:00:00Z"},
                    },
                },
            )
        if "raw.githubusercontent.com" in url:
            return _FakeResp(200, text_data='APP_VERSION = "2.5.0"\n')
        return _FakeResp(404, json_data={})

    def stream(self, _method: str, url: str, **_kwargs):
        if "api.github.com/repos/" in url:
            return _FakeStreamResp(
                302,
                headers={
                    "location": f"https://codeload.github.com/malexxx/Nobis.Supervisor/legacy.tar.gz/{self.remote_sha}"
                },
            )
        return _FakeStreamResp(200, body=self.tar_bytes)


def _make_fake_github_borrow(remote_sha: str, tar_bytes: bytes):
    client = _FakeGitHubClient(remote_sha, tar_bytes)

    @asynccontextmanager
    async def _fake_borrow(timeout: float = 15.0):
        yield client

    return _fake_borrow


class TestSelfUpdateSystem(BugBountyTestCase):
    def test_semver_and_boot_target_resolution_and_image_newer_guard(self):
        self.assertEqual(parse_semver_tuple("v2.2.0+abc1234"), (2, 2, 0))
        self.assertEqual(compare_versions("2.2.0", "2.1.9"), 1)
        self.assertEqual(compare_versions("v2.2.0", "2.2"), 0)
        self.assertEqual(compare_versions("2.2.0", "2.3.0"), -1)

        with tempfile.TemporaryDirectory() as data_dir, tempfile.TemporaryDirectory() as img_dir:
            self.assertIsNone(is_valid_release_dir(data_dir, "../escape"))
            self.assertIsNone(is_valid_release_dir(data_dir, "missing_rel"))

            rel_id = "v2.2.5-1111111"
            rel_dir = os.path.join(data_dir, "updates", "releases", rel_id)
            os.makedirs(rel_dir, exist_ok=True)
            for fname in ("server.py", "main.py"):
                with open(os.path.join(rel_dir, fname), "w", encoding="utf-8") as fh:
                    fh.write("# stub\n")

            self.assertIsNotNone(is_valid_release_dir(data_dir, rel_id))
            write_update_state(
                data_dir,
                {
                    "active_release": {
                        "id": rel_id,
                        "app_version": "2.2.5",
                        "display_version": "v2.2.5+1111111",
                        "sha": "1111111" + "0" * 33,
                        "pending_verify": False,
                    }
                },
            )

            target = resolve_boot_target(data_dir, img_dir, "2.2.0", "")
            self.assertTrue(target["is_override"])
            self.assertEqual(os.path.realpath(target["target_dir"]), os.path.realpath(rel_dir))
            self.assertTrue(server_mod._should_auto_rollback(data_dir, target, rc=1, uptime_s=1.0))
            self.assertFalse(server_mod._should_auto_rollback(data_dir, target, rc=1, uptime_s=60.0))

            # Garde-fou : une nouvelle image Docker (2.4.0 > 2.2.5) désactive la vieille release
            newer = resolve_boot_target(data_dir, img_dir, "2.4.0", "deadbeef")
            self.assertFalse(newer["is_override"])
            self.assertEqual(newer["target_dir"], img_dir)
            state_after = read_update_state(data_dir)
            self.assertIsNone(state_after["active_release"])
            self.assertEqual(state_after["last_rollback"]["reason"], "docker_image_newer")

    def test_auto_rollback_on_boot_failure_and_healthy_confirmation(self):
        with tempfile.TemporaryDirectory() as data_dir, tempfile.TemporaryDirectory() as img_dir:
            for rel_id in ("v2.2.1-aaaaaaa", "v2.2.2-bbbbbbb"):
                rdir = os.path.join(data_dir, "updates", "releases", rel_id)
                os.makedirs(rdir, exist_ok=True)
                for fn in ("server.py", "main.py"):
                    with open(os.path.join(rdir, fn), "w", encoding="utf-8") as fh:
                        fh.write("# ok\n")
            os.makedirs(os.path.join(data_dir, "updates", "releases", "v2.2.2-bbbbbbb", "pydeps"), exist_ok=True)

            prev_rel = {
                "id": "v2.2.1-aaaaaaa",
                "app_version": "2.2.1",
                "display_version": "v2.2.1+aaaaaaa",
                "sha": "a" * 40,
                "pending_verify": False,
            }
            new_rel = {
                "id": "v2.2.2-bbbbbbb",
                "app_version": "2.2.2",
                "display_version": "v2.2.2+bbbbbbb",
                "sha": "b" * 40,
                "pending_verify": True,
            }
            write_update_state(data_dir, {"active_release": dict(new_rel), "previous_release": prev_rel})

            target = resolve_boot_target(data_dir, img_dir, "2.2.0", "")
            env = build_child_env({"PATH": "/usr/bin"}, target, img_dir, "2.2.0", "0" * 40)
            self.assertEqual(env["APP_VERSION"], "2.2.2")
            self.assertEqual(env["DOCKER_VERSION"], "v2.2.2+bbbbbbb")
            self.assertEqual(env["NOBIS_ASSET_BUST"], "v2.2.2-bbbbbbb")
            self.assertIn("pydeps", env["PYTHONPATH"])

            # Simulation crash précoce au boot -> rollback auto vers v2.2.1
            rollback_after_boot_failure(data_dir, "v2.2.2-bbbbbbb", exit_code=1, uptime_s=1.2)
            st = read_update_state(data_dir)
            self.assertEqual(st["active_release"]["id"], "v2.2.1-aaaaaaa")
            self.assertIsNone(st["previous_release"])
            self.assertTrue(st["last_rollback"]["automatic"])

            # Si une release démarre correctement, mark_active_release_healthy confirme
            st["active_release"]["pending_verify"] = True
            write_update_state(data_dir, st)
            self.assertTrue(mark_active_release_healthy(data_dir, "v2.2.1-aaaaaaa"))
            st2 = read_update_state(data_dir)
            self.assertFalse(st2["active_release"]["pending_verify"])
            self.assertTrue(st2["active_release"].get("verified_at"))

            img_env = build_child_env(env, {"target_dir": img_dir, "is_override": False, "release": None}, img_dir, "2.2.0")
            self.assertEqual(img_env["APP_VERSION"], "2.2.0")
            self.assertNotIn("NOBIS_ACTIVE_RELEASE_ID", img_env)
            self.assertNotIn("NOBIS_ASSET_BUST", img_env)

    def test_tarball_security_rejects_traversal_symlinks_missing_files_and_syntax_errors(self):
        with self.assertRaises(ValueError):
            _validate_github_url("http://api.github.com/repos/malexxx/Nobis.Supervisor")
        with self.assertRaises(ValueError):
            _validate_github_url("https://169.254.169.254/latest/meta-data")
        self.assertTrue(_validate_github_url("https://codeload.github.com/malexxx/Nobis.Supervisor/tar.gz/v2").startswith("https://"))

        def _make_raw_tar(entries: list[tuple[str, bytes, int]]) -> bytes:
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode="w:gz") as tf:
                for name, data, ttype in entries:
                    ti = tarfile.TarInfo(name)
                    ti.type = ttype
                    if ttype == tarfile.SYMTYPE:
                        ti.linkname = "/etc/passwd"
                    else:
                        ti.size = len(data)
                    tf.addfile(ti, io.BytesIO(data) if ttype == tarfile.REGTYPE else None)
            return buf.getvalue()

        with tempfile.TemporaryDirectory() as tmpdir:
            trav_tar = os.path.join(tmpdir, "trav.tar.gz")
            with open(trav_tar, "wb") as fh:
                fh.write(_make_raw_tar([("root/../escape.py", b"x=1", tarfile.REGTYPE)]))
            with self.assertRaises(ValueError):
                _extract_tarball_safely(trav_tar, os.path.join(tmpdir, "out1"))

            sym_tar = os.path.join(tmpdir, "sym.tar.gz")
            with open(sym_tar, "wb") as fh:
                fh.write(_make_raw_tar([("root/badlink", b"", tarfile.SYMTYPE)]))
            with self.assertRaises(ValueError):
                _extract_tarball_safely(sym_tar, os.path.join(tmpdir, "out2"))

            incomplete_tar = os.path.join(tmpdir, "incomplete.tar.gz")
            with open(incomplete_tar, "wb") as fh:
                fh.write(_make_raw_tar([("root/server.py", b"print(1)\n", tarfile.REGTYPE)]))
            inc_dir = os.path.join(tmpdir, "out_inc")
            _extract_tarball_safely(incomplete_tar, inc_dir)
            with self.assertRaises(ValueError):
                _validate_staged_release(inc_dir, config.BASE_DIR)

            syntax_tar = os.path.join(tmpdir, "syntax.tar.gz")
            with open(syntax_tar, "wb") as fh:
                fh.write(_build_synthetic_release_tarball("2.4.0", broken_syntax=True))
            syn_dir = os.path.join(tmpdir, "out_syn")
            _extract_tarball_safely(syntax_tar, syn_dir)
            with self.assertRaises(ValueError):
                _validate_staged_release(syn_dir, config.BASE_DIR)

    def test_end_to_end_apply_and_rollback_with_synthetic_tarball(self):
        remote_sha = "abcdef1234567890" + "0" * 24
        tar_bytes = _build_synthetic_release_tarball("2.5.0")
        fake_borrow = _make_fake_github_borrow(remote_sha, tar_bytes)

        with tempfile.TemporaryDirectory() as iso_dir:
            iso_sys = os.path.join(iso_dir, "nobis_a10_system.db")
            iso_modes = {
                "simulation": os.path.join(iso_dir, "nobis_a10_simulation.db"),
                "agua_cloud": os.path.join(iso_dir, "nobis_a10_agua_cloud.db"),
                "local_gateway": os.path.join(iso_dir, "nobis_a10_local_gateway.db"),
            }
            try:
                with (
                    patch.object(database, "DATA_DIR", iso_dir),
                    patch.object(database, "SYSTEM_DB_PATH", iso_sys),
                    patch.object(database, "MODE_DB_PATHS", iso_modes),
                    patch("services.update_service.borrow_http_client", fake_borrow),
                    patch.dict(os.environ, {"NOBIS_SUPERVISOR_ENABLED": "1"}, clear=False),
                ):
                    database.reset_secret_key_cache()
                    database.reset_db_caches()
                    database.init_all_databases()

                    res = asyncio.run(
                        apply_internal_update(
                            channel="main",
                            data_dir=iso_dir,
                            image_dir=config.BASE_DIR,
                            trigger_restart=False,
                        )
                    )
                    self.assertEqual(res["status"], "applying")
                    self.assertEqual(res["version"], "2.5.0")
                    self.assertTrue(res["backup_created"])
                    self.assertFalse(res["matter_deps_changed"])

                    backups_dir = os.path.join(iso_dir, "updates", "backups")
                    self.assertTrue(any(f.endswith(".zip") for f in os.listdir(backups_dir)))

                    target = resolve_boot_target(iso_dir, config.BASE_DIR, "2.4.0", "")
                    self.assertTrue(target["is_override"])
                    self.assertEqual(target["release"]["id"], res["release_id"])

                    rb = asyncio.run(rollback_internal_update(data_dir=iso_dir, trigger_restart=False))
                    self.assertEqual(rb["status"], "rolling_back")
                    target_after = resolve_boot_target(iso_dir, config.BASE_DIR, "2.4.0", "")
                    self.assertFalse(target_after["is_override"])
            finally:
                database.reset_secret_key_cache()
                database.reset_db_caches()

    def test_update_http_endpoints_auth_validation_and_cache_busting(self):
        clear_installer_sessions()
        with tempfile.TemporaryDirectory() as iso_dir:
            iso_sys = os.path.join(iso_dir, "nobis_a10_system.db")
            iso_modes = {
                "simulation": os.path.join(iso_dir, "nobis_a10_simulation.db"),
                "agua_cloud": os.path.join(iso_dir, "nobis_a10_agua_cloud.db"),
                "local_gateway": os.path.join(iso_dir, "nobis_a10_local_gateway.db"),
            }
            try:
                with (
                    patch.object(database, "DATA_DIR", iso_dir),
                    patch.object(database, "SYSTEM_DB_PATH", iso_sys),
                    patch.object(database, "MODE_DB_PATHS", iso_modes),
                ):
                    database.reset_secret_key_cache()
                    database.reset_db_caches()
                    database.init_all_databases()
                    with temporary_settings({"comm_mode": "simulation", "agua_password": "upd-secret-pass"}):
                        r_stat = self.client.get("/api/system/update/status")
                        self.assertEqual(r_stat.status_code, 200)
                        self.assertIn("channel", r_stat.json())

                        self.assertEqual(self.client.post("/api/system/update/check").status_code, 403)
                        self.assertEqual(self.client.post("/api/system/update/apply").status_code, 403)
                        self.assertEqual(self.client.post("/api/system/update/rollback").status_code, 403)
                        self.assertEqual(
                            self.client.post("/api/system/update/config", json={"channel": "v2"}).status_code,
                            403,
                        )

                        tok = self.client.post("/api/installer/verify", json={"password": "upd-secret-pass"}).json()["token"]
                        headers = {"X-Installer-Token": tok}

                        self.assertEqual(
                            self.client.post("/api/system/update/config", json={"channel": "evil"}, headers=headers).status_code,
                            400,
                        )
                        self.assertEqual(
                            self.client.post("/api/system/update/check", json={"channel": "evil"}, headers=headers).status_code,
                            400,
                        )
                        self.assertEqual(
                            self.client.post("/api/system/update/rollback", headers=headers).status_code,
                            400,
                        )

                        r_cfg = self.client.post(
                            "/api/system/update/config",
                            json={"channel": "releases", "auto_check": False, "auto_apply": False},
                            headers=headers,
                        )
                        self.assertEqual(r_cfg.status_code, 200)
                        self.assertEqual(r_cfg.json()["channel"], "releases")
                        self.assertFalse(r_cfg.json()["auto_check"])
            finally:
                database.reset_secret_key_cache()
                database.reset_db_caches()

        r_health = self.client.get("/health")
        self.assertEqual(r_health.status_code, 200)
        self.assertIn("active_release_id", r_health.json())
        self.assertIn("self_update_supported", r_health.json())

        with patch.dict(
            os.environ,
            {
                "NOBIS_ASSET_BUST": "v3.0.1-abcdef1",
                "NOBIS_ACTIVE_RELEASE_ID": "v3.0.1-abcdef1",
                "NOBIS_SUPERVISOR_ENABLED": "1",
            },
            clear=False,
        ):
            r_spa = self.client.get("/")
            self.assertEqual(r_spa.status_code, 200)

            r_health2 = self.client.get("/health")
            self.assertEqual(r_health2.status_code, 200)
            self.assertEqual(r_health2.json()["active_release_id"], "v3.0.1-abcdef1")
            self.assertTrue(r_health2.json()["self_update_supported"])

    def test_dockerfile_and_workflow_git_commit_arg(self):
        with open(os.path.join(config.BASE_DIR, "Dockerfile"), encoding="utf-8") as fh:
            df = fh.read()
        self.assertIn('ARG GIT_COMMIT=""', df)
        self.assertIn("NOBIS_IMAGE_COMMIT=${GIT_COMMIT}", df)

        repo_root = os.path.dirname(config.BASE_DIR)
        pub_path = os.path.join(repo_root, ".github", "workflows", "docker-publish.yml")
        if os.path.isfile(pub_path):
            with open(pub_path, encoding="utf-8") as fh:
                pub = fh.read()
            self.assertIn("GIT_COMMIT=${{ github.sha }}", pub)

    def test_docker_env_version_vars_and_stale_env_guard(self):
        from services.update_service import _APP_VERSION_RE

        with open(os.path.join(config.BASE_DIR, "Dockerfile"), encoding="utf-8") as fh:
            df = fh.read()
        self.assertIn("ARG APP_VERSION=0.0.3", df)
        self.assertIn("ARG DOCKER_VERSION=v0.0.3", df)
        self.assertIn("APP_VERSION=${APP_VERSION}", df)
        self.assertIn("DOCKER_VERSION=${DOCKER_VERSION}", df)

        with open(os.path.join(config.BASE_DIR, "config.py"), encoding="utf-8") as fh:
            cfg_txt = fh.read()
        m_ver = _APP_VERSION_RE.search(cfg_txt)
        self.assertIsNotNone(m_ver)
        self.assertEqual(m_ver.group(1), "0.0.3")

        # Garde-fou anti-variable figée (ex: conteneur mis à jour ayant conservé APP_VERSION=2.2.0)
        with patch.dict(os.environ, {"APP_VERSION": "2.2.0", "DOCKER_VERSION": "2.2.0"}, clear=False):
            os.environ.pop("NOBIS_ACTIVE_RELEASE_ID", None)
            self.assertEqual(config._resolve_app_version("2.4.0"), "2.4.0")
            self.assertEqual(config._resolve_docker_version("2.4.0"), "v2.4.0")

        # Une variable >= code ou un override actif est respecté
        with patch.dict(os.environ, {"APP_VERSION": "2.5.0", "DOCKER_VERSION": "v2.5.0"}, clear=False):
            os.environ.pop("NOBIS_ACTIVE_RELEASE_ID", None)
            self.assertEqual(config._resolve_app_version("2.4.0"), "2.5.0")
            self.assertEqual(config._resolve_docker_version("2.5.0"), "v2.5.0")

        with patch.dict(
            os.environ,
            {"APP_VERSION": "2.2.0", "DOCKER_VERSION": "v2.2.0+abc", "NOBIS_ACTIVE_RELEASE_ID": "v2.2.0-abc"},
            clear=False,
        ):
            self.assertEqual(config._resolve_app_version("2.4.0"), "2.2.0")
            self.assertEqual(config._resolve_docker_version("2.2.0"), "v2.2.0+abc")

        # build_child_env corrige aussi DOCKER_VERSION obsolète au démarrage sur image Docker
        child_env = build_child_env(
            {"PATH": "/usr/bin", "APP_VERSION": "2.2.0", "DOCKER_VERSION": "2.2.0"},
            {"target_dir": config.BASE_DIR, "is_override": False, "release": None},
            config.BASE_DIR,
            "2.4.0",
        )
        self.assertEqual(child_env["APP_VERSION"], "2.4.0")
        self.assertEqual(child_env["DOCKER_VERSION"], "v2.4.0")

        # Aucun artefact v1.0 résiduel
        for rel_v1 in (
            "docs/screenshots/cockpit_triarc_v1.0.png",
            "docs/screenshots/cockpit_timeline_v1.0.png",
        ):
            self.assertFalse(os.path.exists(os.path.join(config.BASE_DIR, *rel_v1.split("/"))))
        index_html = os.path.join(config.FRONTEND_DIST_DIR, "index.html")
        if os.path.isfile(index_html):
            with open(index_html, encoding="utf-8") as fh:
                self.assertNotIn("v1.0", fh.read())
        with open(os.path.join(config.REPO_ROOT, "README.md"), encoding="utf-8") as fh:
            self.assertNotIn("v1.0", fh.read())
