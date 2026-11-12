"""The direct herdr capture: exact argv, bounded, typed failures, sanitized stderr.

Every test here either injects a runner or puts a **fake** herdr on PATH. The live herdr
is never called: the suite must not read the live fleet, and a test that depends on the
operator's terminal state is not a test.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from tests.helpers import (AS_OF, FIXTURE_ROOT, ROOT, fake_herdr_bin, fake_herdr_calls,
                           flat_snapshot, nested_snapshot, require_fixtures)

sys.path.insert(0, ROOT)

from behold import cache as cache_mod  # noqa: E402
from behold import cli, guard  # noqa: E402
from behold.sources import herdr_capture  # noqa: E402

#: The representative herdr SessionSnapshot, checked in and built to the installed
#: herdr's own API schema.
REPRESENTATIVE_FIXTURE = os.path.join(ROOT, "fixtures", "herdr_session_snapshot.json")


def runner_returning(returncode: int, stdout: str, stderr: str = ""):
    """A capture runner that never spawns anything."""
    calls: list[tuple[str, ...]] = []

    def runner(argv, timeout_s):
        calls.append(tuple(argv))
        return returncode, stdout, stderr

    runner.calls = calls  # type: ignore[attr-defined]
    return runner


class TestCaptureContract(unittest.TestCase):
    def test_the_argv_is_exactly_the_api_snapshot(self) -> None:
        runner = runner_returning(0, json.dumps(flat_snapshot()))
        result = herdr_capture.capture(executable="/usr/local/bin/herdr", runner=runner)
        self.assertTrue(result.ok, result.error)
        self.assertEqual(runner.calls, [("/usr/local/bin/herdr", "api", "snapshot")])

    def test_a_missing_binary_is_a_typed_error(self) -> None:
        result = herdr_capture.capture(executable="", runner=runner_returning(0, "{}"))
        self.assertFalse(result.ok)
        self.assertEqual(result.error, "herdr-not-found")
        self.assertIn("--snapshot FILE", result.message or "")

    def test_a_non_zero_exit_is_a_typed_error_with_sanitized_stderr(self) -> None:
        runner = runner_returning(3, "", "boom: the server is not running\n")
        result = herdr_capture.capture(executable="/usr/local/bin/herdr", runner=runner)
        self.assertFalse(result.ok)
        self.assertEqual(result.error, "herdr-exit-3")
        self.assertIn("boom", result.stderr or "")
        self.assertNotIn("\n", result.stderr or "")

    def test_invalid_json_is_a_typed_error(self) -> None:
        runner = runner_returning(0, "not json at all")
        result = herdr_capture.capture(executable="/usr/local/bin/herdr", runner=runner)
        self.assertFalse(result.ok)
        self.assertEqual(result.error, "herdr-invalid-json")

    def test_a_json_array_is_not_a_snapshot(self) -> None:
        runner = runner_returning(0, "[1, 2, 3]")
        result = herdr_capture.capture(executable="/usr/local/bin/herdr", runner=runner)
        self.assertFalse(result.ok)
        self.assertEqual(result.error, "herdr-invalid-json")

    def test_a_timeout_is_a_typed_error(self) -> None:
        def timeout_runner(argv, timeout_s):
            raise subprocess.TimeoutExpired(cmd=list(argv), timeout=timeout_s)

        result = herdr_capture.capture(executable="/usr/local/bin/herdr",
                                       runner=timeout_runner)
        self.assertFalse(result.ok)
        self.assertEqual(result.error, "herdr-timeout")

    def test_a_spawn_failure_is_a_typed_error(self) -> None:
        def failing_runner(argv, timeout_s):
            raise OSError(13, "Permission denied")

        result = herdr_capture.capture(executable="/usr/local/bin/herdr",
                                       runner=failing_runner)
        self.assertFalse(result.ok)
        self.assertEqual(result.error, "herdr-spawn-failed")
        self.assertIn("Permission denied", result.message or "")

    def test_the_timeout_is_bounded(self) -> None:
        self.assertLessEqual(herdr_capture.DEFAULT_TIMEOUT_S, 30.0)


class TestStderrSanitizing(unittest.TestCase):
    def test_ansi_escapes_are_removed(self) -> None:
        cleaned = herdr_capture.sanitize_stderr("\x1b[31mred\x1b[0m failure")
        self.assertEqual(cleaned, "red failure")

    def test_control_characters_are_removed(self) -> None:
        cleaned = herdr_capture.sanitize_stderr("a\x00b\x07c")
        self.assertNotIn("\x00", cleaned or "")
        self.assertNotIn("\x07", cleaned or "")

    def test_the_home_directory_is_shortened(self) -> None:
        cleaned = herdr_capture.sanitize_stderr(f"cannot read {os.path.expanduser('~')}/x")
        self.assertNotIn(os.path.expanduser("~"), cleaned or "")
        self.assertIn("~/x", cleaned or "")

    def test_the_output_is_truncated(self) -> None:
        cleaned = herdr_capture.sanitize_stderr("x" * 5000)
        self.assertLessEqual(len(cleaned or ""), herdr_capture.MAX_STDERR_CHARS)

    def test_empty_stderr_stays_empty(self) -> None:
        self.assertIsNone(herdr_capture.sanitize_stderr(""))
        self.assertIsNone(herdr_capture.sanitize_stderr(None))


class TestNormalization(unittest.TestCase):
    def test_a_flat_document_passes_through(self) -> None:
        document, notes = herdr_capture.normalize_snapshot(flat_snapshot())
        self.assertEqual(document["protocol"], 22)
        self.assertEqual(document["agents"], [])
        self.assertEqual(notes, [])

    def test_a_nested_document_is_flattened(self) -> None:
        document, notes = herdr_capture.normalize_snapshot(nested_snapshot())
        self.assertEqual(len(document["workspaces"]), 1)
        self.assertEqual(len(document["tabs"]), 1)
        self.assertEqual(len(document["panes"]), 1)
        self.assertEqual(len(document["agents"]), 1)
        agent = document["agents"][0]
        self.assertEqual(agent["pane_id"], "wX:p1")
        self.assertEqual(agent["workspace_id"], "wX")
        self.assertEqual(agent["tab_id"], "wX:t1")
        self.assertEqual(agent["agent"], "pi")
        self.assertTrue(any("flattened" in note for note in notes))

    def test_a_session_id_is_not_turned_into_a_path_pin(self) -> None:
        document = nested_snapshot()
        pane = document["workspaces"][0]["tabs"][0]["panes"][0]
        pane["agent"]["session"] = {"agent": "pi", "kind": "id", "source": "herdr:pi",
                                    "value": "aaaaaaaa-0000-4000-8000-000000000001"}
        normalized, _notes = herdr_capture.normalize_snapshot(document)
        self.assertNotIn("agent_session", normalized["agents"][0])

    def test_a_session_path_becomes_a_pin(self) -> None:
        document = nested_snapshot()
        pane = document["workspaces"][0]["tabs"][0]["panes"][0]
        pane["agent"]["session"] = {"agent": "pi", "kind": "path", "source": "herdr:pi",
                                    "value": "/tmp/sessions/x.jsonl"}
        normalized, _notes = herdr_capture.normalize_snapshot(document)
        self.assertEqual(normalized["agents"][0]["agent_session"]["value"],
                         "/tmp/sessions/x.jsonl")

    def test_a_document_with_no_topology_is_an_error_not_an_empty_roster(self) -> None:
        with self.assertRaises(herdr_capture.SnapshotShapeError):
            herdr_capture.normalize_snapshot({"unrelated": True})

    def test_a_missing_protocol_fails_closed(self) -> None:
        # The protocol is never defaulted: a document that does not carry one is refused,
        # because a default would be a claim the document did not make.
        document = {"workspaces": [], "tabs": [], "panes": [], "agents": []}
        with self.assertRaises(herdr_capture.SnapshotShapeError) as ctx:
            herdr_capture.normalize_snapshot(document)
        self.assertIn("no integer protocol", str(ctx.exception))

    def test_the_api_success_envelope_is_unwrapped(self) -> None:
        inner = {"protocol": 22, "version": "1", "workspaces": [], "tabs": [],
                 "panes": [], "layouts": [], "agents": []}
        document, notes = herdr_capture.normalize_snapshot({"id": "herdr:1", "result": inner})
        self.assertEqual(document["protocol"], 22)
        self.assertTrue(any("envelope" in note for note in notes))

    def test_the_cli_result_snapshot_envelope_is_unwrapped(self) -> None:
        # Measured on herdr 0.9.5 (2026-11-12): `herdr api snapshot` prints the success
        # response with the topology one level deeper, at result.snapshot. Refusing that
        # document made a live roster impossible on the installed herdr.
        inner = {"protocol": 22, "version": "0.9.5", "workspaces": [], "tabs": [],
                 "panes": [], "layouts": [], "agents": []}
        document, notes = herdr_capture.normalize_snapshot(
            {"id": "cli:api:snapshot", "result": {"snapshot": inner}})
        self.assertEqual(document["protocol"], 22)
        self.assertTrue(any("result.snapshot" in note for note in notes))

    def test_a_result_without_a_snapshot_is_still_refused(self) -> None:
        # The unwrap is by one named key, never by guessing: `result` alone that carries no
        # protocol and no snapshot must keep failing closed.
        with self.assertRaises(herdr_capture.SnapshotShapeError):
            herdr_capture.normalize_snapshot({"id": "cli:api:snapshot", "result": {"ok": True}})

    def test_a_document_with_no_topology_is_refused(self) -> None:
        with self.assertRaises(herdr_capture.SnapshotShapeError):
            herdr_capture.normalize_snapshot({"protocol": 22, "unrelated": True})


class TestRepresentativeFixture(unittest.TestCase):
    """The captured document's real shape, taken from the installed herdr's own schema.

    The fixture is synthetic and checked in; the schema is the installed herdr's. This is
    the "inspect the installed API, do not guess" part of the design, made checkable.
    """

    def setUp(self) -> None:
        with open(REPRESENTATIVE_FIXTURE, "r", encoding="utf-8") as fh:
            self.document = json.load(fh)

    def test_the_fixture_has_the_shape_the_roster_reads(self) -> None:
        document, notes = herdr_capture.normalize_snapshot(self.document)
        self.assertEqual(document["protocol"], 22)
        self.assertEqual(len(document["workspaces"]), 2)
        self.assertEqual(len(document["tabs"]), 2)
        self.assertEqual(len(document["panes"]), 3)
        self.assertEqual(len(document["agents"]), 3)
        self.assertEqual(notes, [])

    def test_the_fixture_captures_into_a_roster(self) -> None:
        require_fixtures()
        with tempfile.TemporaryDirectory() as tmp:
            bindir = fake_herdr_bin(tmp, document=self.document)
            proc = subprocess.run(
                [sys.executable, os.path.join(ROOT, "bin", "behold"), "roster",
                 "--root", FIXTURE_ROOT, "--as-of", AS_OF, "--herdr", "--cache", "off"],
                capture_output=True, text=True, timeout=180,
                env={**os.environ, "PATH": bindir + os.pathsep + os.environ.get("PATH", "")})
            self.assertEqual(proc.returncode, 0, proc.stderr[:2000])
            doc = json.loads(proc.stdout)
            self.assertEqual(doc["behold"]["snapshot"]["protocol"], 22)
            self.assertEqual(doc["behold"]["snapshot"]["agents"], 3)
            self.assertEqual(doc["behold"]["snapshot"]["panes"], 3)
            self.assertEqual(doc["behold"]["snapshot"]["workspaces"], 2)
            self.assertEqual(doc["behold"]["snapshot"]["source"],
                             "herdr api snapshot (captured)")

    def test_the_fixture_matches_the_installed_herdr_schema(self) -> None:
        if shutil.which("herdr") is None:
            self.skipTest("herdr is not installed: the fixture is checked against the "
                          "schema's shape in the other tests")
        proc = subprocess.run(["herdr", "api", "schema", "--json"],
                              capture_output=True, text=True, timeout=60)
        if proc.returncode != 0:
            self.skipTest(f"herdr api schema failed: {proc.stderr[:200]}")
        schema = json.loads(proc.stdout)
        self.assertEqual(schema["protocol"], 22)
        definition = schema["schemas"]["success_response"]["$defs"]["SessionSnapshot"]
        required = set(definition["required"])
        self.assertTrue(required.issubset(set(self.document)),
                        f"the fixture is missing {sorted(required - set(self.document))}")
        self.assertEqual(self.document["protocol"], schema["protocol"])
        # every record carries the keys its own definition requires
        for section, def_name in (("workspaces", "WorkspaceInfo"), ("tabs", "TabInfo"),
                                  ("panes", "PaneInfo"), ("agents", "AgentInfo"),
                                  ("layouts", "PaneLayoutSnapshot")):
            record_required = set(
                schema["schemas"]["success_response"]["$defs"][def_name]["required"])
            for record in self.document.get(section, []):
                missing = record_required - set(record)
                self.assertEqual(missing, set(), f"{section}: {sorted(missing)}")
        # and the agent session shape is the API's own
        session_def = schema["schemas"]["success_response"]["$defs"]["AgentSessionInfo"]
        for record in self.document["agents"]:
            session = record.get("agent_session")
            if session is None:
                continue
            self.assertEqual(set(session_def["required"]) - set(session), set())


class TestGuardSeam(unittest.TestCase):
    def test_a_spawn_without_a_permit_is_refused(self) -> None:
        with guard.enforce():
            with self.assertRaises(guard.ReadOnlyViolation):
                subprocess.run(["/bin/echo", "hi"], capture_output=True, check=False)

    def test_the_capture_runs_under_the_guard_with_a_one_shot_permit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bindir = fake_herdr_bin(tmp, document=flat_snapshot())
            # The capture resolves the binary on the *process* PATH, so the fake has to be
            # on the process PATH: passing an env to a child would not be enough.
            with mock.patch.dict(os.environ,
                                 {"PATH": bindir + os.pathsep + os.environ.get("PATH", "")}):
                with guard.enforce():
                    result = herdr_capture.capture()
            self.assertTrue(result.ok, result.error)
            self.assertEqual(fake_herdr_calls(bindir), ["api", "snapshot"])
            # the permit was consumed: nothing is left over
            self.assertEqual(guard.live_spawn_permits(), [])


class TestCliCapture(unittest.TestCase):
    """The CLI's three snapshot paths: capture, file override, fixture tree."""

    def _run(self, bindir: str, extra: list[str], env_extra: dict | None = None):
        env = {**os.environ, "PATH": bindir + os.pathsep + os.environ.get("PATH", "")}
        if env_extra:
            env.update(env_extra)
        return subprocess.run(
            [sys.executable, os.path.join(ROOT, "bin", "behold"), "roster",
             "--root", FIXTURE_ROOT, "--as-of", AS_OF, *extra],
            capture_output=True, text=True, timeout=180, env=env)

    def test_the_herdr_flag_captures_and_the_snapshot_comes_from_the_capture(self) -> None:
        require_fixtures()
        with tempfile.TemporaryDirectory() as tmp:
            bindir = fake_herdr_bin(tmp, document=nested_snapshot())
            proc = self._run(bindir, ["--herdr", "--cache", "off"])
            self.assertEqual(proc.returncode, 0, proc.stderr[:2000])
            doc = json.loads(proc.stdout)
            self.assertEqual(doc["behold"]["snapshot"]["source"],
                             "herdr api snapshot (captured)")
            self.assertEqual(doc["behold"]["guard"]["spawns"], {"herdr-snapshot-capture": 1})
            self.assertEqual(fake_herdr_calls(bindir), ["api", "snapshot"])

    def test_the_document_carries_the_capture_receipt(self) -> None:
        require_fixtures()
        with tempfile.TemporaryDirectory() as tmp:
            bindir = fake_herdr_bin(tmp, document=nested_snapshot())
            proc = self._run(bindir, ["--herdr", "--cache", "off"])
            self.assertEqual(proc.returncode, 0, proc.stderr[:2000])
            doc = json.loads(proc.stdout)
            capture = doc["behold"]["capture"]
            self.assertTrue(capture["ok"])
            self.assertEqual(capture["argv"][1:], ["api", "snapshot"])
            self.assertGreater(capture["duration_ms"], 0)
            self.assertIsNone(capture["error"])
            # the normalizer says what it did with the document
            self.assertTrue(any("flattened" in note for note in capture["notes"]))

    def test_a_fixture_run_never_calls_herdr(self) -> None:
        require_fixtures()
        with tempfile.TemporaryDirectory() as tmp:
            bindir = fake_herdr_bin(tmp, document=flat_snapshot())
            proc = self._run(bindir, ["--cache", "off"])
            self.assertEqual(proc.returncode, 0, proc.stderr[:2000])
            doc = json.loads(proc.stdout)
            self.assertEqual(doc["behold"]["snapshot"]["source"],
                             os.path.join(FIXTURE_ROOT, "herdr", "snapshot.json"))
            self.assertEqual(doc["behold"]["guard"]["spawns"], {})
            self.assertIsNone(fake_herdr_calls(bindir))

    def test_a_snapshot_override_never_calls_herdr(self) -> None:
        require_fixtures()
        snapshot = os.path.join(FIXTURE_ROOT, "herdr", "snapshot.json")
        with tempfile.TemporaryDirectory() as tmp:
            bindir = fake_herdr_bin(tmp, document=flat_snapshot())
            proc = subprocess.run(
                [sys.executable, os.path.join(ROOT, "bin", "behold"), "roster",
                 "--snapshot", snapshot, "--cache", "off"],
                capture_output=True, text=True, timeout=180,
                env={**os.environ,
                     "PATH": bindir + os.pathsep + os.environ.get("PATH", "")})
            self.assertEqual(proc.returncode, 0, proc.stderr[:2000])
            doc = json.loads(proc.stdout)
            self.assertEqual(doc["behold"]["snapshot"]["source"], snapshot)
            self.assertIsNone(fake_herdr_calls(bindir))

    def test_herdr_and_snapshot_together_is_a_usage_error(self) -> None:
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, "bin", "behold"), "roster",
             "--root", FIXTURE_ROOT, "--as-of", AS_OF, "--cache", "off",
             "--herdr", "--snapshot", "/tmp/x.json"],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 2, proc.stderr[:400])
        self.assertIn("mutually exclusive", proc.stderr)

    def test_a_failing_capture_is_a_source_error(self) -> None:
        require_fixtures()
        with tempfile.TemporaryDirectory() as tmp:
            bindir = fake_herdr_bin(tmp, document=flat_snapshot(), exit_code=4,
                                    stderr="herdr: server not running\n")
            proc = self._run(bindir, ["--herdr", "--cache", "off"])
            self.assertEqual(proc.returncode, 3, proc.stdout[:400])
            self.assertIn("herdr-exit-4", proc.stderr)
            self.assertIn("server not running", proc.stderr)


class TestCliCacheWiring(unittest.TestCase):
    def _run(self, extra: list[str], env_extra: dict | None = None):
        env = {**os.environ}
        if env_extra:
            env.update(env_extra)
        return subprocess.run(
            [sys.executable, os.path.join(ROOT, "bin", "behold"), "roster",
             "--root", FIXTURE_ROOT, "--as-of", AS_OF, *extra],
            capture_output=True, text=True, timeout=180, env=env)

    def test_an_offline_run_writes_no_cache_by_default(self) -> None:
        require_fixtures()
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "behold.db")
            proc = self._run(["--cache-db", db])
            self.assertEqual(proc.returncode, 0, proc.stderr[:2000])
            doc = json.loads(proc.stdout)
            self.assertFalse(doc["behold"]["cache"]["enabled"])
            self.assertEqual(doc["behold"]["cache"]["state"], "disabled")
            self.assertFalse(os.path.exists(db), "the offline run created a cache file")

    def test_an_offline_run_writes_the_cache_when_asked(self) -> None:
        require_fixtures()
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "behold.db")
            proc = self._run(["--cache", "on", "--cache-db", db])
            self.assertEqual(proc.returncode, 0, proc.stderr[:2000])
            doc = json.loads(proc.stdout)
            self.assertTrue(doc["behold"]["cache"]["enabled"])
            self.assertEqual(doc["behold"]["cache"]["state"], "present")
            self.assertTrue(os.path.exists(db))
            # the topology of the run is in the cache
            self.assertEqual(doc["behold"]["cache"]["rows"]["herdr_snapshot_current"], 1)
            self.assertEqual(doc["behold"]["cache"]["snapshot"]["state"], "fresh")

    def test_the_cache_never_holds_the_fixture_sentinels(self) -> None:
        require_fixtures()
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "behold.db")
            proc = self._run(["--cache", "on", "--cache-db", db])
            self.assertEqual(proc.returncode, 0, proc.stderr[:2000])
            with open(db, "rb") as fh:
                blob = fh.read()
            for sentinel in (b"SENTINEL_GOAL_TEXT", b"SENTINEL_TODO_SUBJECT",
                             b"SENTINEL_CRON_PROMPT", b"SENTINEL_ROOM_BODY",
                             b"SENTINEL_BEAD_DESCRIPTION", b"SENTINEL_SESSION_MESSAGE",
                             b"SENTINEL_TOOL_ARGUMENTS", b"SENTINEL_SKILL_BODY",
                             b"SENTINEL_PROMPT_BODY", b"SENTINEL_API_KEY"):
                self.assertNotIn(sentinel, blob)

    def test_the_spool_is_ingested_into_the_cache(self) -> None:
        require_fixtures()
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "behold.db")
            inbox = cache_mod.inbox_dir_for(db)
            os.makedirs(inbox, exist_ok=True)
            pane = "w1A:p1"
            record = {
                "behold_state": cache_mod.STATE_RECORD_VERSION,
                "pane_id": pane,
                "tab_id": "w1A:t1",
                "session_id": "aaaaaaaa-0000-4000-8000-000000000001",
                "incarnation": "11111111-2222-3333-4444-555555555555:4001:900001",
                "boot_id": "11111111-2222-3333-4444-555555555555",
                "incarnation_start_ticks": 900001,
                "incarnation_boot_epoch": 5000.0,
                "seq": 12345,
                "observed_at": "2026-11-12T00:00:00Z",
                "observed_at_epoch": time.time(),
                "mono_epoch": time.time(),
                "state": {"model_id": "acme-fast-1", "idle": True},
                "writer": "pi-extension",
            }
            with open(os.path.join(inbox, cache_mod.spool_file_name(pane, "w1A:t1")), "w",
                      encoding="utf-8") as fh:
                json.dump(record, fh)
            proc = self._run(["--cache", "on", "--cache-db", db])
            self.assertEqual(proc.returncode, 0, proc.stderr[:2000])
            doc = json.loads(proc.stdout)
            self.assertEqual(doc["behold"]["cache"]["rows"]["pi_state_current"], 1)
            self.assertEqual(doc["behold"]["cache"]["pi_state"]["by_state"]["fresh"], 1)
            cache = cache_mod.Cache(db)
            self.addCleanup(cache.close)
            read = cache.read_pi_state(pane, session_id=record["session_id"])
            self.assertEqual(read.state, cache_mod.FRESH)
            self.assertEqual(read.value["model_id"], "acme-fast-1")


class TestRunModeSelection(unittest.TestCase):
    """Which run mode a set of flags selects. No run, no fleet read."""

    def _args(self, argv: list[str]):
        return cli.build_parser().parse_args(["roster", *argv])

    def test_a_bare_run_is_the_live_run(self) -> None:
        args = self._args([])
        self.assertEqual(cli._run_mode(args), "live")
        self.assertEqual(cli._cache_mode(args, "live"), "on")

    def test_a_snapshot_run_is_offline_and_leaves_the_cache_alone(self) -> None:
        args = self._args(["--snapshot", "/tmp/x.json"])
        self.assertEqual(cli._run_mode(args), "snapshot")
        self.assertEqual(cli._cache_mode(args, "snapshot"), "off")

    def test_a_fixture_run_is_offline_and_leaves_the_cache_alone(self) -> None:
        args = self._args(["--root", "/tmp/fixture"])
        self.assertEqual(cli._run_mode(args), "fixture")
        self.assertEqual(cli._cache_mode(args, "fixture"), "off")

    def test_the_cache_can_be_forced_on_offline(self) -> None:
        args = self._args(["--root", "/tmp/fixture", "--cache", "on"])
        self.assertEqual(cli._cache_mode(args, "fixture"), "on")

    def test_the_cache_can_be_forced_off(self) -> None:
        args = self._args(["--cache", "off"])
        self.assertEqual(cli._cache_mode(args, "live"), "off")

    def test_the_database_path_comes_from_the_flag_then_the_environment(self) -> None:
        args = self._args(["--cache-db", "/tmp/explicit.db"])
        self.assertEqual(cli._cache_path(args), "/tmp/explicit.db")
        original = os.environ.get(cache_mod.CACHE_PATH_ENV)
        try:
            os.environ[cache_mod.CACHE_PATH_ENV] = "/tmp/from-env.db"
            args = self._args([])
            self.assertEqual(cli._cache_path(args), "/tmp/from-env.db")
        finally:
            if original is None:
                os.environ.pop(cache_mod.CACHE_PATH_ENV, None)
            else:
                os.environ[cache_mod.CACHE_PATH_ENV] = original


if __name__ == "__main__":
    unittest.main()
