"""V3 residuals: the fourteen independent-review expectations, promoted into the suite.

Each test names the review item it pins. They are deliberately about *source behaviour* —
attempted opens, typed reasons, trust gates — not about a pretty rendered string, because the
V2 review showed that a passing happy-path assertion can hide an unread store.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest

from tests.helpers import AS_OF, FIXTURE_ROOT, ROOT, field, lanes, require_fixtures, roster, roster_json

sys.path.insert(0, ROOT)

from behold import cli, guard, identity, util  # noqa: E402
from behold.sources import Paths, herdr, pi_state, repo  # noqa: E402


class TestR1HeldBeforeRead(unittest.TestCase):
    """V2-R1: real tab topology, pre-read filtering, no post-hoc redaction."""

    @classmethod
    def setUpClass(cls):
        require_fixtures()
        cls.doc = roster_json()
        cls.by = lanes(cls.doc)

    def test_reserved_tab_with_innocent_pane_is_denied(self):
        lane = self.by["wE:p99"]
        self.assertFalse(lane["admission"]["admitted"])
        self.assertEqual(lane["admission"]["reason"], "reserved_tab:wE:t19")
        self.assertTrue(all(v["state"] == "held" for v in lane["fields"].values()))
        self.assertIsNone(lane["identity"])

    def test_held_and_reserved_paths_are_never_opened(self):
        policy = guard.Policy()
        paths = Paths.for_root(FIXTURE_ROOT)
        snapshot = herdr.load(paths.snapshot, policy)
        access = identity.PilAccess(paths.pil_dir, policy)
        ctx = cli.Runner(cli.build_parser().parse_args(
            ["roster", "--root", FIXTURE_ROOT, "--as-of", AS_OF]), policy)
        for agent in snapshot.agents:
            if agent["pane_id"] in ("w2:p1", "wE:t19", "wE:p99"):
                cli.lane_mod.build_lane(agent, ctx.context())
        del access
        attempts = policy.open_attempts
        for forbidden in ("launch-HELD", "launch-RESERVED"):
            hits = [p for p in attempts if forbidden in p]
            self.assertEqual(hits, [], f"{forbidden} paths were opened: {hits}")

    def test_no_global_instance_scan(self):
        # The global profile block is derived from admitted+trusted lanes only, and a run with
        # no such lane must read nothing from the instances directory.
        policy = guard.Policy()
        paths = Paths.for_root(FIXTURE_ROOT)
        runner = cli.Runner(cli.build_parser().parse_args(
            ["roster", "--root", FIXTURE_ROOT, "--as-of", AS_OF, "--lane", "w1C:p2"]), policy)
        lanes_out, _inputs, _sessions = runner.lanes_and_inputs()
        doc = runner.document(lanes_out, runner.last_ctx)
        self.assertEqual(doc["global"]["M-4"]["state"], "unknown")
        self.assertIn("noaccess", doc["global"]["M-4"]["value"]["reason"])
        self.assertEqual([p for p in policy.open_attempts if "launch-HELD" in p], [])


class TestR2Ownership(unittest.TestCase):
    """V2-R2: a present tuple is not proof; disagreement unfits the lane for every preload."""

    @classmethod
    def setUpClass(cls):
        require_fixtures()
        cls.paths = Paths.for_root(FIXTURE_ROOT)
        cls.policy = guard.Policy()
        cls.snapshot = herdr.load(cls.paths.snapshot, cls.policy)
        cls.agent = [a for a in cls.snapshot.agents if a["pane_id"] == "w1A:p1"][0]

    def _plant(self, **changes) -> identity.Identity:
        with open(os.path.join(self.paths.pil_dir, "alpha-leader.json")) as fh:
            record = json.load(fh)
        record.update(changes)
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "alpha-leader.json"), "w") as fh:
                json.dump(record, fh)
            access = identity.PilAccess(tmp, self.policy)
            return identity.resolve(self.agent, policy=self.policy, pil=access,
                                    proc_root=self.paths.proc_root, name_hint="alpha-leader")

    def test_starttime_mismatch_is_untrusted(self):
        ident = self._plant(starttime=999999999)
        self.assertEqual(ident.state, identity.TUPLE_DISAGREEMENT)
        self.assertFalse(ident.trusted)
        self.assertEqual(ident.tuple_state, identity.TUPLE_MISMATCH)
        self.assertIsNone(ident.trusted_session_id)

    def test_boot_mismatch_is_untrusted(self):
        ident = self._plant(boot_id="DIFFERENT-SYNTHETIC-BOOT")
        self.assertEqual(ident.state, identity.TUPLE_DISAGREEMENT)
        self.assertFalse(ident.trusted)

    def test_envpane_mismatch_is_untrusted(self):
        with open(os.path.join(self.paths.proc_root, "4001", "environ"), "rb") as fh:
            original = fh.read()

        def rewrite(data: bytes) -> None:
            with open(os.path.join(self.paths.proc_root, "4001", "environ"), "wb") as fh:
                fh.write(data)

        try:
            rewrite(original.replace(b"HERDR_PANE_ID=w1A:p1", b"HERDR_PANE_ID=wOTHER:p9"))
            access = identity.PilAccess(self.paths.pil_dir, self.policy)
            ident = identity.resolve(self.agent, policy=self.policy, pil=access,
                                     proc_root=self.paths.proc_root, name_hint="alpha-leader")
            self.assertEqual(ident.state, identity.ENVPANE_DISAGREEMENT)
            self.assertFalse(ident.trusted)
            self.assertIsNone(ident.trusted_session_id)
        finally:
            rewrite(original)

    def test_unrecorded_tuple_is_reported_unrecorded_only(self):
        """V4: assert UNRECORDED exactly. V3 accepted UNRECORDED *or* VERIFIED, so it could
        not fail for the case it was named after."""
        verified = self._plant()
        self.assertEqual(verified.tuple_state, identity.TUPLE_VERIFIED)

        # A record that carries no expected tuple cannot be cross-checked.
        with open(os.path.join(self.paths.pil_dir, "alpha-leader.json")) as fh:
            record = json.load(fh)
        record.pop("boot_id", None)
        record.pop("starttime", None)
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "alpha-leader.json"), "w") as fh:
                json.dump(record, fh)
            access = identity.PilAccess(tmp, self.policy)
            ident = identity.resolve(self.agent, policy=self.policy, pil=access,
                                     proc_root=self.paths.proc_root, name_hint="alpha-leader")
        self.assertEqual(ident.tuple_state, identity.TUPLE_UNRECORDED)
        checks = {c.name: c for c in ident.checks}
        self.assertIn("proc.tuple_expected", checks)
        self.assertIsNone(checks["proc.tuple_expected"].ok,
                          "unrecorded must be an absent check, not a passed one")
        self.assertIn("unrecorded", checks["proc.tuple_expected"].detail)

    def test_pin_only_is_not_verified(self):
        # No pil record and no proc: a self-consistent pin alone is not ownership.
        agent = dict(self.agent, workspace_id="w1A", tab_id="w1A:t1")
        access = identity.PilAccess(self.paths.pil_dir, self.policy)
        ident = identity.resolve(agent, policy=self.policy, pil=access,
                                 proc_root="", name_hint="no-such-lane")
        self.assertEqual(ident.state, identity.PIN_ONLY_UNVERIFIED)
        self.assertFalse(ident.trusted)
        self.assertIsNone(ident.trusted_session_id)

    def test_disagreement_blocks_profile_and_instance(self):
        doc = roster_json()
        by = lanes(doc)
        # beta has a stale-pin witness disagreement: no profile value, no instance.
        beta = by["w1B:p1"]
        self.assertFalse(beta["identity"]["trusted"])
        m3 = field(beta, "M-3")
        self.assertEqual(m3["state"], "unknown")
        self.assertIsNone(m3["value"])

    def test_nested_agent_dir_is_not_an_instance(self):
        self.assertIsNone(pi_state.instance_from_agent_dir(
            "/x/instances/launch-A/not-agent-dir", "/x/instances"))


class TestR3ExternalBoundary(unittest.TestCase):
    """V2-R3: exact argv is not containment; the capability is gone."""

    def test_no_execution_api(self):
        self.assertFalse(guard.EXTERNAL_EXECUTION)
        for attr in ("run", "ALLOWED_ARGVS", "ALLOWED_BINARIES", "CHILD_UNSANDBOXED"):
            self.assertFalse(hasattr(guard, attr), attr)

    def test_repo_adapter_is_absent(self):
        for attr in ("git_status", "git_identity", "stash_count", "jj_query", "_jj"):
            self.assertFalse(hasattr(repo, attr), attr)

    def test_herdr_capture_replaces_the_refusal(self):
        # V5: the refusal is gone and the capture is the path. The capture is exercised with
        # a FAKE herdr on PATH: this suite never touches the live herdr.
        from tests.helpers import fake_herdr_bin, flat_snapshot
        with tempfile.TemporaryDirectory() as tmp:
            bindir = fake_herdr_bin(tmp, document=flat_snapshot())
            env = {**os.environ, "PATH": bindir + os.pathsep + os.environ.get("PATH", "")}
            proc = subprocess.run(
                [sys.executable, os.path.join(ROOT, "bin", "behold"), "roster",
                 "--root", FIXTURE_ROOT, "--as-of", AS_OF, "--herdr", "--cache", "off"],
                capture_output=True, text=True, timeout=180, env=env)
        self.assertEqual(proc.returncode, 0, proc.stderr[:2000])
        doc = json.loads(proc.stdout)
        self.assertEqual(doc["behold"]["snapshot"]["source"], "herdr api snapshot (captured)")
        self.assertEqual(doc["behold"]["guard"]["spawns"], {"herdr-snapshot-capture": 1})

    def test_repo_fields_carry_the_stable_reason(self):
        require_fixtures()
        lane = lanes(roster_json())["w1A:p1"]
        for key in ("R-1", "R-3", "R-4", "R-6"):
            self.assertEqual(field(lane, key)["reason"], guard.REPO_ADAPTER_NOT_ISOLATED)


class TestR4WatchDependencies(unittest.TestCase):
    """V2-R4: per-source invalidation, not session-only."""

    def test_dependency_set_includes_profile_and_config_stores(self):
        require_fixtures()
        runner = cli.Runner(cli.build_parser().parse_args(
            ["roster", "--root", FIXTURE_ROOT, "--as-of", AS_OF]), guard.Policy())
        _lanes, inputs, _sessions = runner.lanes_and_inputs()
        joined = "\n".join(inputs)
        for needle in ("pi-profile.json", "pi-todo-state.json", "settings.json",
                       "models-store.json", "beads/issues.json", "cron/tasks.json",
                       "dagr/recent", "profiles/leader.json"):
            self.assertIn(needle, joined, needle)

    def test_profile_only_change_is_a_watched_input(self):
        # The path a profile edit would touch is in the invalidation set, so a change there
        # produces a new derivation instead of being silently ignored.
        require_fixtures()
        runner = cli.Runner(cli.build_parser().parse_args(
            ["roster", "--root", FIXTURE_ROOT, "--as-of", AS_OF]), guard.Policy())
        _lanes, inputs, _sessions = runner.lanes_and_inputs()
        self.assertTrue(any("/instances/launch-A/pi-profile.json" in p for p in inputs), inputs)

    def test_as_of_with_watch_is_refused(self):
        code, _out, err = roster("--watch", "--watch-iterations", "1")
        self.assertEqual(code, 2)
        self.assertIn("--as-of", err)


class TestR5TimeAndBranch(unittest.TestCase):
    """V2-R5: timezone/fractions, disk-vs-runtime leaf, composed mode authority."""

    def test_offsets_and_fractions(self):
        self.assertEqual(util.parse_iso("2026-11-11T03:00:00Z"),
                         util.parse_iso("2026-11-10T22:00:00-05:00"))
        delta = util.parse_iso("2026-11-11T03:00:00.125Z") - util.parse_iso("2026-11-11T03:00:00Z")
        self.assertAlmostEqual(delta, 0.125, places=6)

    def test_leaf_is_labelled_disk_reconstructed(self):
        require_fixtures()
        lane = lanes(roster_json())["w1A:p1"]
        p4 = field(lane, "P-4")["value"]
        self.assertEqual(p4["leaf_authority"], "DISK_RECONSTRUCTED")
        self.assertIsNone(p4["runtime_leaf"])
        self.assertIn("DISK_RECONSTRUCTED", field(lane, "P-4")["note"])

    def test_composed_mode_is_unverifiable_not_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            mode = {"schemaVersion": 1, "key": "leader", "label": "Leader",
                    "description": "d", "promptStrategy": "append", "systemPrompt": "x",
                    "requires": [], "conflictsWith": [], "before": [], "after": []}
            path = os.path.join(tmp, "leader.json")
            with open(path, "w") as fh:
                json.dump(mode, fh)
            digest = pi_state.mode_definition_fingerprint(dict(mode, scope="global", path=path))
            drift = pi_state.mode_drift(
                {"leader": {"digest": digest, "scope": "global", "path": path}},
                policy=guard.Policy(), global_mode_dir=tmp, cwd=None, overlays=["deep-review"])
            self.assertEqual(drift["state"], "unverifiable")
            self.assertIn("composed", drift["reason"])

    def test_project_scope_is_unverifiable(self):
        drift = pi_state.mode_drift(
            {"leader": {"digest": "x", "scope": "project", "path": "/tmp/x.json"}},
            policy=guard.Policy(), global_mode_dir="/tmp", cwd=None)
        self.assertEqual(drift["state"], "unverifiable")


class TestHonesty(unittest.TestCase):
    """Field/ID counts, E-1 exactness and transfer claims."""

    @classmethod
    def setUpClass(cls):
        require_fixtures()
        cls.doc = roster_json()

    def test_field_id_count_is_unique_and_matches_the_ledger(self):
        per_lane = {k for lane in self.doc["lanes"] for k in lane["fields"]}
        self.assertEqual(len(per_lane), 57, sorted(per_lane))
        ledger = os.path.join(ROOT, "FIELD-LEDGER.md")
        with open(ledger, encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("58 unique field ids", text)
        self.assertIn("57 per-lane", text)

    def test_e1_does_not_promise_exact_extension_inventory(self):
        lane = lanes(self.doc)["w1A:p1"]
        e1 = field(lane, "E-1")
        self.assertEqual(e1["state"], "inferred")
        self.assertIn("cannot", e1["value"]["limitation"].lower()
                      + " " + e1["reason"].lower() if e1["reason"] else e1["value"]["limitation"].lower())
        # The renderer must not advertise an exact P3 method it does not implement.
        from behold import render
        self.assertNotIn("getAllTools", json.dumps(render.RUNTIME_ONLY_PENDING))

    def test_transfer_plan_has_no_generic_staging(self):
        with open(os.path.join(ROOT, "TRANSFER.md"), encoding="utf-8") as fh:
            text = fh.read()
        self.assertNotIn("add -A", text)
        self.assertNotIn("git add .", text)
        # rollback must be an explicit, reviewed CAS, not a blind delete
        self.assertIn("expected-current", text)
        self.assertIn("manifest", text.lower())


if __name__ == "__main__":
    unittest.main()


class TestV4GlobalHandlesBeforeRead(unittest.TestCase):
    """V4 binding: global state handles come from admitted+verified instances, before any read.

    The V3 negative was tautological — it used `--lane w1C:p2` (no trusted instance, so the
    reader was never called). This one runs the **full roster** with a held-instance and a
    foreign-instance `pi-profile-state.json` planted, asserts a *trusted positive control*
    (the trusted instance's value is read), and then proves the assertion is sensitive by
    re-running with a faithful reconstruction of the V3 scanner.
    """

    @classmethod
    def setUpClass(cls):
        import subprocess as _sp

        cls.tmp = tempfile.mkdtemp(prefix="behold-v4-")
        cls.root = os.path.join(cls.tmp, "fixtures")
        _sp.run([sys.executable, os.path.join(ROOT, "fixtures", "make_fixtures.py"),
                 cls.root, "--lanes", "3"], check=True, capture_output=True)
        # Plant: the held lane's instance (launch-HELD is its instance in the stock fixture)
        # and an instance with no lane at all.
        for name, value in (("launch-HELD", "SENTINEL_HELD_PROFILE"),
                            ("launch-FOREIGN", "SENTINEL_FOREIGN_PROFILE")):
            os.makedirs(os.path.join(cls.root, "instances", name), exist_ok=True)
            with open(os.path.join(cls.root, "instances", name, "pi-profile-state.json"),
                      "w", encoding="utf-8") as fh:
                json.dump({"activeProfile": value}, fh)

    @classmethod
    def tearDownClass(cls):
        import shutil

        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _full_roster(self):
        args = cli.build_parser().parse_args(
            ["roster", "--root", self.root, "--as-of", AS_OF])
        policy = guard.Policy()
        runner = cli.Runner(args, policy)
        lanes_out, _inputs, _sessions = runner.lanes_and_inputs()
        doc = runner.document(lanes_out, runner.last_ctx)
        return doc, policy

    def test_full_roster_never_opens_held_or_foreign_instance_state(self):
        doc, policy = self._full_roster()
        attempts = policy.open_attempts
        for forbidden in ("launch-HELD", "launch-FOREIGN"):
            hits = [p for p in attempts if forbidden in p]
            self.assertEqual(hits, [], f"{forbidden} state was opened: {hits}")
        text = json.dumps(doc)
        self.assertNotIn("SENTINEL_HELD_PROFILE", text)
        self.assertNotIn("SENTINEL_FOREIGN_PROFILE", text)

    def test_trusted_positive_control_is_actually_read(self):
        # Without this, "nothing was opened" could simply mean the reader never ran.
        doc, policy = self._full_roster()
        m4 = doc["global"]["M-4"]
        self.assertEqual(m4["state"], "present", m4)
        self.assertEqual(m4["value"]["activeProfile"], "worker")
        instances = m4["value"]["derived_from"]["instances"]
        self.assertTrue(instances, "expected at least one admitted+verified instance")
        self.assertEqual(instances, sorted(instances))
        for foreign in ("launch-HELD", "launch-FOREIGN", "launch-RESERVED"):
            self.assertNotIn(foreign, instances)
        self.assertTrue(
            [p for p in policy.open_attempts if p.endswith("launch-A/pi-profile-state.json")],
            "the trusted instance's state file was not read, so the negative proves nothing")

    def test_no_directory_listing_of_the_instances_root(self):
        from behold.sources import pi_state as ps

        with open(ps.__file__, encoding="utf-8") as fh:
            source = fh.read()
        self.assertNotIn("listdir(instances_dir)", source)
        self.assertNotIn("listdir(instances_dir", source)

    def test_negative_is_sensitive_to_the_v3_scanner(self):
        """A faithful V3 scanner must be caught by the assertions above.

        This is the mutant-sensitivity proof: the same planted root, the same full roster, but
        with `global_profile_active` replaced by the V3 implementation (sorted listdir of the
        instances root, then open every `<instance>/pi-profile-state.json`). If the negative
        were tautological, this too would pass.
        """
        from behold.sources import pi_state as ps

        real = ps.global_profile_active

        def v3_scanner(instances_dir, allowed_instances, policy):
            out = {"activeProfile": None, "path": None, "scope": "global_file",
                   "copies": [], "state": "absent", "error": None}
            if not instances_dir or not os.path.isdir(instances_dir):
                return out
            candidates = []
            for name in sorted(os.listdir(instances_dir)):
                path = os.path.join(instances_dir, name, "pi-profile-state.json")
                if os.path.exists(path):
                    candidates.append(path)
            values = {}
            for path in candidates:
                raw = guard.read_json(path, policy, "pi-profile-global-state")
                if isinstance(raw, dict) and isinstance(raw.get("activeProfile"), str):
                    values[path] = raw["activeProfile"]
                    out["copies"].append({"path": path, "activeProfile": raw["activeProfile"]})
            if not values:
                out["error"] = "no_global_profile_state_file"
                return out
            distinct = sorted(set(values.values()))
            if len(distinct) > 1:
                out["state"] = "conflict"
                out["error"] = f"global copies disagree: {distinct}"
            else:
                out["state"] = "present"
                out["activeProfile"] = distinct[0]
            return out

        ps.global_profile_active = v3_scanner
        try:
            doc, policy = self._full_roster()
        finally:
            ps.global_profile_active = real

        opened = [p for p in policy.open_attempts
                  if "launch-HELD" in p or "launch-FOREIGN" in p]
        leaked = [s for s in ("SENTINEL_HELD_PROFILE", "SENTINEL_FOREIGN_PROFILE")
                  if s in json.dumps(doc)]
        self.assertTrue(
            opened or leaked,
            "the V3 scanner was NOT caught by the negative test: the test is tautological")
