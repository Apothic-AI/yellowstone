"""The safety boundary, tested as a boundary and not as a claim.

* read-only: a write open, a filesystem mutation, a non-allowlisted subprocess and a
  network connect each raise **inside the guard** (fail closed), and a full roster run
  leaves the fixture tree byte-identical (supplementary receipts, not the only proof).
* privacy: deny-before-read ordering, denied path markers, env allowlisting.
* no duplicate reporter / no daemon / no DB: a source scan.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from tests.helpers import FIXTURE_ROOT, ROOT, require_fixtures

sys.path.insert(0, ROOT)

from behold import guard, lane as lane_mod, session  # noqa: E402
from behold.sources import Paths, repo  # noqa: E402


class TestReadOnlyBoundary(unittest.TestCase):
    def test_write_open_is_refused(self) -> None:
        with guard.enforce():
            with self.assertRaises(guard.ReadOnlyViolation):
                open("/tmp/behold-guard-should-not-exist.txt", "w")

    def test_append_and_plus_modes_are_refused(self) -> None:
        with guard.enforce():
            for mode in ("a", "x", "r+", "w+", "a+"):
                with self.assertRaises(guard.ReadOnlyViolation, msg=mode):
                    open("/tmp/behold-guard-should-not-exist.txt", mode)

    def test_read_open_is_allowed(self) -> None:
        path = os.path.join(FIXTURE_ROOT, "herdr", "snapshot.json")
        with guard.enforce():
            with open(path, "r", encoding="utf-8") as fh:
                self.assertGreater(len(fh.read(10)), 0)

    def test_filesystem_mutations_are_refused(self) -> None:
        target = os.path.join(FIXTURE_ROOT, "herdr", "snapshot.json")
        with guard.enforce():
            with self.assertRaises(guard.ReadOnlyViolation):
                os.remove(target)
            with self.assertRaises(guard.ReadOnlyViolation):
                os.rename(target, target + ".moved")
            with self.assertRaises(guard.ReadOnlyViolation):
                os.mkdir(os.path.join(FIXTURE_ROOT, "nope"))
            with self.assertRaises(guard.ReadOnlyViolation):
                os.truncate(target, 0)

    def test_network_is_refused(self) -> None:
        import socket
        import urllib.request

        with guard.enforce():
            with self.assertRaises(guard.NetworkViolation):
                socket.create_connection(("127.0.0.1", 9), timeout=0.01)
            with self.assertRaises(guard.NetworkViolation):
                socket.socket().bind(("127.0.0.1", 0))
            with self.assertRaises(guard.NetworkViolation):
                urllib.request.urlopen("http://127.0.0.1:9/", timeout=0.01)

    def test_unlisted_subprocess_is_refused(self) -> None:
        with guard.enforce():
            with self.assertRaises(guard.ReadOnlyViolation):
                subprocess.run(["echo", "hi"], capture_output=True, check=False)

    def test_no_external_execution_api_exists(self) -> None:
        # V3 removed the adapters *and* the machinery: there is no run(), no argv allowlist,
        # no child process path to bypass. V5 adds a one-shot permit for exactly one argv
        # (``herdr api snapshot``) and nothing else: still no allowlist, still no shell.
        self.assertFalse(guard.EXTERNAL_EXECUTION)
        self.assertFalse(hasattr(guard, "run"))
        self.assertFalse(hasattr(guard, "ALLOWED_ARGVS"))
        self.assertFalse(hasattr(guard, "ALLOWED_BINARIES"))
        with self.assertRaises(guard.NotAllowed):
            guard.refuse_external()

    def test_spawn_permit_is_narrow_and_one_shot(self) -> None:
        # The argv is the real interpreter: the point of the test is the permit mechanics
        # (exact argv, one shot), not herdr.
        argv = (sys.executable, "-c", "pass")
        with guard.enforce():
            # A spawn with no permit is refused.
            with self.assertRaises(guard.ReadOnlyViolation):
                subprocess.run(list(argv), capture_output=True, check=False)
            # An unknown purpose is refused before a process can exist.
            with self.assertRaises(guard.NotAllowed):
                guard.permit_spawn(argv, purpose="anything-else")
            permit = guard.permit_spawn(argv, purpose="herdr-snapshot-capture")
            try:
                self.assertEqual(len(guard.live_spawn_permits()), 1)
                # The permit is consumed by the spawn itself: a second one is refused again.
                subprocess.run(list(argv), capture_output=True, check=False)
                self.assertEqual(guard.live_spawn_permits(), [])
                with self.assertRaises(guard.ReadOnlyViolation):
                    subprocess.run(list(argv), capture_output=True, check=False)
            finally:
                permit.revoke()

    def test_spawn_permit_does_not_match_another_argv(self) -> None:
        argv = (sys.executable, "-c", "pass")
        with guard.enforce():
            permit = guard.permit_spawn(argv, purpose="herdr-snapshot-capture")
            try:
                with self.assertRaises(guard.ReadOnlyViolation):
                    subprocess.run(list(argv) + ["--extra"], capture_output=True, check=False)
            finally:
                # the refused spawn did not consume the permit: drop it explicitly
                permit.revoke()
        self.assertEqual(guard.live_spawn_permits(), [])

    def test_cache_write_scope_allows_only_the_cache_path(self) -> None:
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "cache", "behold.db")
            allowed = os.path.join(tmp, "cache")
            with guard.enforce():
                with guard.cache_write_scope([db], dirs=[allowed]):
                    os.makedirs(allowed, exist_ok=True)
                    with open(db, "w", encoding="utf-8") as fh:
                        fh.write("x")
                    # anything outside the scope is still refused
                    with self.assertRaises(guard.ReadOnlyViolation):
                        open(os.path.join(tmp, "other.txt"), "w")
            # and the scope ends with the block
            with guard.enforce():
                with self.assertRaises(guard.ReadOnlyViolation):
                    open(db, "w")

    def test_any_spawn_is_refused_under_the_guard(self) -> None:
        with guard.enforce():
            with self.assertRaises(guard.ReadOnlyViolation):
                subprocess.run(["git", "--version"], capture_output=True, check=False)
            with self.assertRaises(guard.ReadOnlyViolation):
                subprocess.run(["jj", "--ignore-working-copy", "status"], capture_output=True,
                               check=False)

    def test_repo_adapter_reason_is_a_stable_code(self) -> None:
        self.assertEqual(guard.REPO_ADAPTER_NOT_ISOLATED, "repo-adapter-not-isolated")

    def test_pane_and_tab_ids_are_validated(self) -> None:
        self.assertTrue(guard.is_pane_id("w1K:p37"))
        self.assertFalse(guard.is_pane_id("NOT_A_PANE"))
        self.assertFalse(guard.is_pane_id("--version"))
        self.assertFalse(guard.is_pane_id("/etc/passwd"))
        self.assertTrue(guard.is_tab_id("w1K:t2W"))
        self.assertFalse(guard.is_tab_id("wE:t19 "))

    def test_reserved_tab_is_denied_over_the_real_topology(self) -> None:
        policy = guard.Policy()
        admitted, reason = policy.admit_lane("wE", "wE:p99", "wE:t19")
        self.assertFalse(admitted)
        self.assertEqual(reason, "reserved_tab:wE:t19")
        # the innocent-looking pane alone would have been admitted: the tab is what denies
        self.assertEqual(policy.admit_lane("wE", "wE:p99", "wE:t1"), (True, None))

    def test_detection_needs_no_child(self) -> None:
        from behold.sources import repo

        self.assertFalse(hasattr(repo, "git_status"))
        self.assertFalse(hasattr(repo, "jj_query"))
        self.assertFalse(hasattr(repo, "stash_count"))
        detected = repo.detect(FIXTURE_ROOT)
        self.assertEqual(detected.kind, "none")


class TestDenyBeforeRead(unittest.TestCase):
    def _policy(self) -> guard.Policy:
        return guard.Policy()

    def test_held_lane_never_opens_its_paths(self) -> None:
        require_fixtures()
        policy = self._policy()
        paths = Paths.for_root(FIXTURE_ROOT)
        from behold import identity
        from behold.sources import herdr

        snapshot = herdr.load(paths.snapshot, policy)
        agent = [a for a in snapshot.agents if a["pane_id"] == "w2:p1"][0]
        ctx = lane_mod.Context(paths=paths, policy=policy, snapshot=snapshot,
                               as_of=1793000000.0, as_of_iso="2026-11-11T03:00:00Z",
                               pil=identity.PilAccess(paths.pil_dir, policy))
        built = lane_mod.build_lane(agent, ctx)
        self.assertFalse(built.admitted)
        self.assertEqual(built.admission_reason, "held_workspace:w2")
        kinds = [kind for kind, _detail in policy.events]
        self.assertIn("deny", kinds)
        deny_at = kinds.index("deny")
        # The one snapshot read happens before per-lane work; the deny verdict precedes every
        # per-lane path open, and no path belonging to the held lane was touched at all.
        held_session = os.path.join(FIXTURE_ROOT, "instances", "launch-HELD")
        opened = [p for p in policy.open_attempts if held_session in p]
        self.assertEqual(opened, [], f"held lane paths were opened: {opened}")
        after_deny = policy.events[deny_at + 1 :]
        self.assertEqual([e for e in after_deny if held_session in e[1]], [])
        for value in built.fields.values():
            if value.key.startswith("P-") or value.key.startswith("T-"):
                self.assertEqual(value.state, "held")

    def test_reserved_pane_denied(self) -> None:
        require_fixtures()
        policy = self._policy()
        admitted, reason = policy.admit_lane("w1C", "wE:t19")
        self.assertFalse(admitted)
        self.assertEqual(reason, "reserved_pane:wE:t19")

    def test_denied_path_markers_are_refused_before_open(self) -> None:
        policy = self._policy()
        for marker in ("/secrets/token.json", "/home/x/auth.json", "/.ssh/id_ed25519"):
            with self.assertRaises(guard.DeniedRead):
                guard.read_text(marker, policy)
            self.assertNotIn(marker, policy.open_attempts)

    def test_existing_secret_file_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "secrets", "token.json")
            os.makedirs(os.path.dirname(path))
            with open(path, "w", encoding="utf-8") as fh:
                fh.write('{"token":"SENTINEL_API_KEY"}')
            with self.assertRaises(guard.DeniedRead):
                guard.read_json(path, guard.Policy())

    def test_env_allowlist_drops_everything_else(self) -> None:
        require_fixtures()
        policy = self._policy()
        from behold import procfs

        environ = os.path.join(FIXTURE_ROOT, "proc", "4001", "environ")
        values = guard.read_env_allowlist(environ, procfs.ENV_ALLOWLIST, policy)
        self.assertEqual(values.get("PI_PROFILE"), "leader")
        self.assertNotIn("UNRELATED_SECRET", values)
        self.assertFalse(any("SENTINEL_ENV_VALUE" in v for v in values.values()))

    def test_unknown_policy_marker_does_not_hide_a_denial(self) -> None:
        policy = guard.Policy()
        policy.check_path("/tmp/plain.txt", "read")
        self.assertIn("/tmp/plain.txt", policy.open_attempts)
        self.assertEqual(policy.receipt()["denials"], {})


class TestNoServiceOrReporter(unittest.TestCase):
    def test_no_daemon_db_or_reporter_in_source(self) -> None:
        forbidden = {
            "report_agent": "duplicate reporter",
            "report_metadata": "duplicate metadata writer",
            "Thread(": "background thread",
            "daemon=True": "daemon",
            "socketserver": "service",
            "HTTPServer": "service",
            "create_connection": "network client",
        }
        offenders = []
        for base, _dirs, files in os.walk(os.path.join(ROOT, "behold")):
            for name in files:
                if not name.endswith(".py"):
                    continue
                path = os.path.join(base, name)
                with open(path, "r", encoding="utf-8") as fh:
                    text = fh.read()
                for needle, why in forbidden.items():
                    if needle in text:
                        offenders.append(f"{os.path.relpath(path, ROOT)}: {needle} ({why})")
        # guard.py mentions the network events it *refuses* and the reporter names it must
        # not call; those are the boundary itself, and they are asserted separately above.
        offenders = [o for o in offenders if not o.startswith("behold/guard.py")]
        self.assertEqual(offenders, [])

    def test_only_the_cache_module_may_use_sqlite(self) -> None:
        # V5 approved exactly one database: behold's own cache. It is a cache of derived,
        # sanitized state — not a fleet store, not a session file, not a second reporter.
        users = []
        for base, _dirs, files in os.walk(os.path.join(ROOT, "behold")):
            for name in files:
                if not name.endswith(".py"):
                    continue
                path = os.path.join(base, name)
                with open(path, "r", encoding="utf-8") as fh:
                    text = fh.read()
                if "import sqlite3" in text:
                    users.append(os.path.relpath(path, ROOT))
        self.assertEqual(users, ["behold/cache.py"])

    def test_the_cache_module_never_opens_a_session_file(self) -> None:
        # The cache writes its own file and reads its own spool. It must not touch a pi
        # session file: a session is the fleet's, not behold's.
        path = os.path.join(ROOT, "behold", "cache.py")
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
        self.assertNotIn(".jsonl", text)
        # the only file it opens for reading is the spool record
        self.assertIn('open(path, "r", encoding="utf-8")', text)
        self.assertNotIn('open(path, "a"', text)
        # and the cache module itself writes no file at all: the admission map it
        # publishes for the reporter is written by the admission module, which is the
        # only other place in behold that writes.
        writes = [line for line in text.splitlines()
                  if 'open(path, "w"' in line or 'open(path, "wb"' in line]
        self.assertEqual(writes, [], writes)
        admission = os.path.join(ROOT, "behold", "admission.py")
        with open(admission, "r", encoding="utf-8") as fh:
            admission_text = fh.read()
        admission_writes = [line for line in admission_text.splitlines()
                            if 'open(temp, "w"' in line]
        self.assertEqual(len(admission_writes), 1, admission_writes)
        # and it publishes atomically: a temp file and a rename
        self.assertIn("os.replace(temp, path)", admission_text)
        self.assertNotIn(".jsonl", admission_text)

    def test_guard_refuses_the_reporter_methods_by_construction(self) -> None:
        # There is no herdr socket client to call them with: the only herdr interaction is
        # `herdr api snapshot`, which is a read.
        # There is no herdr client, no socket, and no argv allowlist left to reach a reporter.
        self.assertFalse(hasattr(guard, "ALLOWED_ARGVS"))
        self.assertFalse(hasattr(guard, "process_info_argv"))
        self.assertFalse(hasattr(guard, "CHILD_UNSANDBOXED"))


class TestRosterIsReadOnly(unittest.TestCase):
    def test_full_run_leaves_the_fixture_tree_unchanged(self) -> None:
        require_fixtures()

        def manifest() -> dict[str, tuple[int, int, int]]:
            out = {}
            for base, dirs, files in os.walk(FIXTURE_ROOT):
                dirs.sort()
                for name in sorted(files):
                    path = os.path.join(base, name)
                    try:
                        st = os.stat(path)
                    except OSError:
                        continue
                    out[path] = (st.st_ino, st.st_size, st.st_mtime_ns)
            return out

        before = manifest()
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, "bin", "behold"), "roster", "--root", FIXTURE_ROOT,
             "--as-of", "2026-11-11T03:00:00Z", "--cache", "off"],
            capture_output=True, text=True, timeout=180, env={**os.environ, "PYTHONPATH": ROOT},
        )
        self.assertEqual(proc.returncode, 0, proc.stderr[:2000])
        after = manifest()
        changed = [p for p in before if before.get(p) != after.get(p)]
        added = sorted(set(after) - set(before))
        removed = sorted(set(before) - set(after))
        self.assertEqual(changed, [], f"{len(changed)} fixture files changed")
        self.assertEqual(added, [], f"roster added files: {added}")
        self.assertEqual(removed, [], f"roster removed files: {removed}")

    def test_cli_has_no_write_feature_at_all(self) -> None:
        # The --output flag was removed: a writable path inside the guarded process is a
        # symlink/sibling-escape surface, and the shell can redirect stdout instead.
        from behold import cli

        parser = cli.build_parser()
        roster_parser = parser._subparsers._group_actions[0].choices["roster"]
        options = {opt for action in roster_parser._actions for opt in action.option_strings}
        self.assertNotIn("--output", options)
        code = subprocess.run(
            [sys.executable, os.path.join(ROOT, "bin", "behold"), "roster", "--root", FIXTURE_ROOT,
             "--as-of", "2026-11-11T03:00:00Z", "--cache", "off",
             "--output", "/tmp/should-not-exist.json"],
            capture_output=True, text=True, timeout=180, env={**os.environ, "PYTHONPATH": ROOT},
        )
        self.assertEqual(code.returncode, 2, code.stderr[:400])
        self.assertFalse(os.path.exists("/tmp/should-not-exist.json"))

    def test_symlinked_store_path_cannot_be_written(self) -> None:
        # A symlink planted at a would-be output path pointed into a fixture store: with no
        # write feature and no symlink-following allowance, the store is untouched.
        with tempfile.TemporaryDirectory() as tmp:
            store = os.path.join(FIXTURE_ROOT, "herdr", "snapshot.json")
            before = os.stat(store).st_mtime_ns
            link = os.path.join(tmp, "planted.json")
            os.symlink(store, link)
            with guard.enforce():
                with self.assertRaises(guard.ReadOnlyViolation):
                    open(link, "w")
            self.assertEqual(os.stat(store).st_mtime_ns, before)


if __name__ == "__main__":
    unittest.main()
