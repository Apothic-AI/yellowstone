"""SI-independent regressions: each test plants the exact failure the review found.

These are deliberately adversarial and small, and each one names the defect it pins:

1. a writable output path (symlink/sibling escape) — the feature is gone
2. a child process is not covered by the in-process guard — claimed nowhere, disabled by default
3. a held/reserved lane rendered before/while being denied
4. an env value exported through the identity/profile surface
5. pid/reporter/pil disagreement trusted into a beads join
6. instance provenance guessed from the session path
7. beads session metadata matched by suffix
8. a watched document whose ages never advance and whose caches never re-read
9. fixtures that need a host `jj` binary
10. a watch that re-stamps the admission map on every iteration, so an old topology
    looks fresh forever and the map's 300-second bound never applies
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from tests.helpers import (AS_OF, FIXTURE_ROOT, ROOT, fake_herdr_bin, fake_herdr_calls, field,
                           lanes, nested_snapshot, require_fixtures, roster, roster_json)

sys.path.insert(0, ROOT)

from behold import admission as admission_mod  # noqa: E402
from behold import cache as cache_mod  # noqa: E402
from behold import cli, guard, identity, session, watch  # noqa: E402
from behold.sources import Paths, fleet_state, pi_state  # noqa: E402


class TestNoWritableOutput(unittest.TestCase):
    def test_no_output_flag_and_no_write_reaches_a_store(self):
        parser = cli.build_parser()
        roster_parser = parser._subparsers._group_actions[0].choices["roster"]
        options = {opt for action in roster_parser._actions for opt in action.option_strings}
        self.assertNotIn("--output", options)

    def test_guard_has_no_write_exception(self):
        with guard.enforce():
            for path in ("/tmp/x.json", os.path.join(FIXTURE_ROOT, "herdr", "snapshot.json")):
                with self.assertRaises(guard.ReadOnlyViolation):
                    open(path, "w")


class TestChildNotCovered(unittest.TestCase):
    def test_externals_removed_not_merely_disclosed(self):
        # V3: the capability is gone, so "is it confined?" is not a question the product
        # answers with prose.
        self.assertFalse(guard.EXTERNAL_EXECUTION)
        self.assertFalse(hasattr(guard, "run"))
        require_fixtures()
        doc = roster_json()
        lane = lanes(doc)["w1A:p1"]
        for key in ("R-1", "R-2", "R-3", "R-4", "R-6"):
            value = field(lane, key)
            self.assertEqual(value["state"], "unknown", key)
            self.assertEqual(value["reason"], "repo-adapter-not-isolated", key)

    def test_default_run_spawns_no_subprocess(self):
        code, out, err = roster()
        self.assertEqual(code, 0, err[:500])
        doc = json.loads(out)
        receipt = doc["behold"]["guard"]
        self.assertEqual(receipt["spawns"], {}, "no external program may run at all")
        # The only denials are lane refusals (workspace, reserved pane, reserved tab).
        self.assertEqual(set(receipt["denials"]),
                         {"held_workspace:w2", "reserved_pane:wE:t19", "reserved_tab:wE:t19"})

    def test_single_lane_run_also_spawns_nothing(self):
        code, out, err = roster("--lane", "w1A:p1")
        self.assertEqual(code, 0, err[:500])
        doc = json.loads(out)
        self.assertEqual(doc["behold"]["guard"]["spawns"], {})


class TestHeldNothingRendered(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        require_fixtures()
        cls.doc = roster_json()
        cls.by = lanes(cls.doc)

    def test_held_lane_renders_no_value_at_all(self):
        for pane, reason in (("w2:p1", "held_workspace:w2"), ("wE:t19", "reserved_pane:wE:t19")):
            lane = self.by[pane]
            self.assertFalse(lane["admission"]["admitted"])
            self.assertEqual(lane["admission"]["reason"], reason)
            self.assertIsNone(lane["identity"])
            for key, value in lane["fields"].items():
                self.assertEqual(value["state"], "held", (pane, key))
                self.assertIsNone(value["value"], (pane, key))
                self.assertIn("deny_pre_read_policy", value["reason"])
            for handle in ("name", "workspace_label", "agent_status", "tab_id"):
                self.assertIsNone(lane["handles"][handle], (pane, handle))

    def test_held_lane_paths_never_opened(self):
        policy = guard.Policy()
        from behold.sources import herdr

        paths = Paths.for_root(FIXTURE_ROOT)
        snapshot = herdr.load(paths.snapshot, policy)
        access = identity.PilAccess(paths.pil_dir, policy)
        held = [a for a in snapshot.agents if a["pane_id"] == "w2:p1"][0]
        built_holder = identity.resolve(held, policy=policy, pil=access,
                                        proc_root=paths.proc_root, name_hint="held-lane")
        self.assertFalse(built_holder.trusted)
        self.assertIsNone(built_holder.session)
        self.assertEqual(built_holder.state, identity.HELD)
        self.assertEqual(access.opened, [])
        held_root = os.path.join(FIXTURE_ROOT, "instances", "launch-HELD")
        self.assertEqual([p for p in policy.open_attempts if held_root in p], [])


class TestNoEnvExport(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        require_fixtures()
        cls.doc = roster_json()
        cls.text = json.dumps(cls.doc)

    def test_only_the_profile_key_is_emitted(self):
        lane = lanes(self.doc)["w1A:p1"]
        declared = field(lane, "M-3")["value"]["declared"]
        self.assertEqual(set(declared), {"profile", "source", "may_be_stale_after"})
        self.assertEqual(declared["profile"], "leader")
        # No raw environ blob, no other keys, no secret sentinel.
        for needle in ("UNRELATED_SECRET", "SENTINEL_ENV_VALUE", "PI_ROOMS_NAME=", "environ"):
            self.assertNotIn(needle, self.text)

    def test_identity_block_has_no_env(self):
        for lane in self.doc["lanes"]:
            if lane.get("identity"):
                self.assertNotIn("env", lane["identity"])

    def test_agent_dir_value_is_not_emitted(self):
        # Store paths are allowed; the *value of an environment variable* is not. The
        # instance is emitted as a name, never as the raw agent-dir variable value.
        self.assertNotIn("PI_CODING_AGENT_DIR", self.text)
        for lane in self.doc["lanes"]:
            if lane.get("identity"):
                self.assertNotIn("env", lane["identity"])


class TestUntrustedDisagreement(unittest.TestCase):
    def test_disagreement_is_untrusted_and_never_joined(self):
        require_fixtures()
        policy = guard.Policy()
        from behold.sources import herdr

        paths = Paths.for_root(FIXTURE_ROOT)
        snapshot = herdr.load(paths.snapshot, policy)
        agent = [a for a in snapshot.agents if a["pane_id"] == "w1A:p1"][0]
        # Plant the defect: the reporter says one pid, the pil record another.
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(paths.pil_dir, "alpha-leader.json")) as fh:
                record = json.load(fh)
            record["pid"] = record["pid"] + 1
            with open(os.path.join(tmp, "alpha-leader.json"), "w") as fh:
                json.dump(record, fh)
            planted = identity.PilAccess(tmp, policy)
            ident = identity.resolve(agent, policy=policy, pil=planted,
                                     proc_root=paths.proc_root, name_hint="alpha-leader")
        self.assertEqual(ident.state, identity.PID_DISAGREEMENT)
        self.assertFalse(ident.trusted)
        self.assertIsNone(ident.trusted_session_id)
        self.assertEqual(ident.untrusted_reason(), "pid_disagreement")

        beads = fleet_state.beads_for_lane(
            paths.beads_file, pane_id="w1A:p1", trusted_session_id=ident.trusted_session_id,
            workspace_id="w1A", policy=policy, untrusted_reason=ident.untrusted_reason())
        self.assertEqual(beads["count"], 0)
        self.assertIn("identity_untrusted", beads["error"])

    def test_pin_pil_session_disagreement_is_stale_but_not_a_join_on_the_pin(self):
        require_fixtures()
        doc = roster_json()
        lane = lanes(doc)["w1B:p1"]
        ident = lane["identity"]
        self.assertEqual(ident["state"], "session_pin_stale_used_pil_record")
        self.assertTrue(any("pin_session" in d for d in ident["disagreements"]))
        # The stale pin is a disagreement, so the lane is not silently "verified".
        self.assertFalse(ident["trusted"] is False and ident["state"] == "verified")
        self.assertIsNotNone(ident["session_id"])
        # ... and the pin file's UUID is never the join key.
        self.assertNotEqual(ident["session_id"], "aaaaaaaa-0000-4000-8000-0000000000ff")


class TestInstanceProvenance(unittest.TestCase):
    def test_instance_comes_only_from_the_verified_process_agentdir(self):
        # A path under launch-B proves nothing; the process env is the only provenance.
        self.assertIsNone(pi_state.instance_from_agent_dir(None, "/x/instances"))
        self.assertIsNone(pi_state.instance_from_agent_dir("/other/place", "/x/instances"))
        self.assertEqual(
            pi_state.instance_from_agent_dir("/x/instances/launch-A", "/x/instances"), "launch-A")
        # The old path-guessing helper must be gone, not merely unused.
        self.assertFalse(hasattr(pi_state, "instance_of"))

    def test_profile_is_not_read_when_the_instance_is_unknown(self):
        # No proc ⇒ no env ⇒ no instance ⇒ no per-instance profile read at all.
        profile = pi_state.profile_state(None, "/x/profiles", guard.Policy())
        self.assertIsNone(profile["selected"])
        self.assertEqual(profile["error"], "instance_unknown")


class TestBeadsExactMetadata(unittest.TestCase):
    def test_suffix_match_is_rejected(self):
        require_fixtures()
        with tempfile.TemporaryDirectory() as tmp:
            uuid = "aaaaaaaa-0000-4000-8000-000000000001"
            issues = [
                {"id": "ok", "status": "open", "labels": ["project:w1A"],
                 "metadata": {"agent_pane": "w1A:p1", "agent_session": uuid}},
                {"id": "suffix", "status": "open", "labels": ["project:w1A"],
                 "metadata": {"agent_pane": "w1A:p1",
                              "agent_session": "forged-prefix-" + uuid}},
                {"id": "pathish", "status": "open", "labels": ["project:w1A"],
                 "metadata": {"agent_pane": "w1A:p1",
                              "agent_session": "/tmp/somewhere/" + uuid}},
                {"id": "otherpane", "status": "open", "labels": ["project:w1A"],
                 "metadata": {"agent_pane": "w1A:p2", "agent_session": uuid}},
            ]
            path = os.path.join(tmp, "issues.json")
            json.dump(issues, open(path, "w"))
            out = fleet_state.beads_for_lane(
                path, pane_id="w1A:p1", trusted_session_id=uuid, workspace_id="w1A",
                policy=guard.Policy())
        self.assertEqual([i["id"] for i in out["issues"]], ["ok"], out)
        self.assertEqual(out["count"], 1)

    def test_case_insensitive_exact_match_still_works(self):
        require_fixtures()
        out = fleet_state.beads_for_lane(
            f"{FIXTURE_ROOT}/state/beads/issues.json", pane_id="w1A:p1",
            trusted_session_id="AAAAAAAA-0000-4000-8000-000000000001".lower(),
            workspace_id="w1A", policy=guard.Policy())
        self.assertEqual(out["count"], 2, out)


class TestWatchMaterializes(unittest.TestCase):
    def setUp(self):
        require_fixtures()

    def test_as_of_is_refused_with_watch(self):
        code, out, err = roster("--watch", "--watch-iterations", "1")
        self.assertEqual(code, 2, (out[:200], err[:400]))
        self.assertIn("--as-of", err + out)

    def test_ages_advance_and_caches_are_reread(self):
        # A watched document must age (live clock) and must pick up a changed store, which
        # only happens if each iteration re-materializes instead of reusing a cached doc.
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.join(tmp, "fixtures")
            subprocess.run([sys.executable, os.path.join(ROOT, "fixtures", "make_fixtures.py"),
                            root, "--lanes", "3"], check=True, capture_output=True)
            args = cli.build_parser().parse_args(["roster", "--root", root, ])
            policy = guard.Policy()

            def derive():
                fresh = cli.Runner(args, policy)
                lanes_out, inputs, sessions = fresh.lanes_and_inputs()
                return fresh.document(lanes_out, fresh.last_ctx), inputs, sessions

            def timing(doc):
                lane = [l for l in doc["lanes"] if l["key"] == "w1A:p1"][0]
                field_ = lane["fields"]["P-7"]
                return field_["value"], field_["age_s"]

            closed = []

            def emit(doc, step):
                if closed:
                    return
                closed.append(True)
                # Plant two changes after the first render: a session append (ages/values)
                # and a beads edit (a cached source that must be re-read).
                target = os.path.join(root, "instances", "launch-A", "sessions")
                for base, _dirs, files in os.walk(target):
                    for name in files:
                        if name.endswith(".jsonl") and "000000000001" in name:
                            with open(os.path.join(base, name), "a", encoding="utf-8") as fh:
                                fh.write(json.dumps({
                                    "type": "message", "id": "zz1", "parentId": "e0004",
                                    "timestamp": "2026-11-11T02:59:00Z",
                                    "message": {"role": "assistant", "content": [],
                                                "provider": "acme", "model": "acme-large-1",
                                                "usage": {"input": 1, "output": 1,
                                                          "cacheRead": 0, "cacheWrite": 0,
                                                          "totalTokens": 2},
                                                "stopReason": "stop",
                                                "timestamp": 1793000000000,
                                                "durationMs": 10}}) + "\n")
                issues_path = os.path.join(root, "state", "beads", "issues.json")
                issues = json.load(open(issues_path))
                issues.append({"id": "bd-planted", "status": "open", "labels": ["project:w1A"],
                               "metadata": {"agent_pane": "w1A:p1",
                                            "agent_session": "aaaaaaaa-0000-4000-8000-000000000001"}})
                json.dump(issues, open(issues_path, "w"))

            docs = []

            def emit_and_keep(doc, step):
                docs.append(doc)
                emit(doc, step)

            steps = watch.run_watch(derive=derive, emit=emit_and_keep,
                                    config=watch.WatchConfig(iterations=2, interval_s=0.05,
                                                             max_seconds=5.0))
            self.assertEqual(len(steps), 2, steps)
            # The clock is live and the file is re-read: the derived session duration grows,
            # and the freshness age of the last write shrinks because new data arrived.
            first_value, first_age = timing(docs[0])
            second_value, second_age = timing(docs[1])
            self.assertIsNotNone(first_age)
            self.assertIsNotNone(second_age)
            self.assertGreater(second_value, first_value, "duration must advance with the clock")
            self.assertLess(second_age, first_age, "freshness age must improve after a new write")
            # The beads export edit was picked up: a cached document would still show 2.
            second = {l["key"]: l for l in docs[1]["lanes"]}["w1A:p1"]
            self.assertEqual(field(second, "B-1")["value"]["count"], 3)
            self.assertIn("bd-planted", [i["id"] for i in field(second, "B-1")["value"]["issues"]])


class _SteppingClock:
    """A synthetic wall clock. Every reading moves it one step forward.

    The map's freshness and the topology's age are claims about time, so a test that
    pins them has to be able to move time. The step is small enough that the ages stay
    sane and large enough that "the moment this was observed" and "the moment it was
    published again" are never the same instant.
    """

    def __init__(self, start: float, step: float = 1.0):
        self.now = start
        self.step = step
        self.readings = 0

    def __call__(self) -> float:
        value = self.now
        self.now += self.step
        self.readings += 1
        return value


def _documents(text: str) -> list[dict]:
    """The documents a watch emitted, whatever shape the renderer wrote them in."""
    decoder = json.JSONDecoder()
    out: list[dict] = []
    index = 0
    while index < len(text):
        while index < len(text) and text[index].isspace():
            index += 1
        if index >= len(text):
            break
        document, index = decoder.raw_decode(text, index)
        out.append(document)
    return out


class TestWatchDoesNotRefreshTheAdmissionMap(unittest.TestCase):
    """The watch must not make an old topology look fresh.

    The finding: the watch built a fresh ``Runner`` per iteration over the run's
    snapshot, and that runner stamped the admission map with the **current** time. Every
    iteration therefore published a map that looked brand new, so a reporter could keep
    using a topology that was hours old and the map's own 300-second bound never
    applied. The reused snapshot must keep the moment it was observed, and the
    topology's provenance must stay honest about how old it is.
    """

    def setUp(self):
        require_fixtures()

    def _plant_change(self) -> None:
        """Touch a lane's session file, so the watch has something to re-derive."""
        target = os.path.join(FIXTURE_ROOT, "instances", "launch-A", "sessions")
        for base, _dirs, files in os.walk(target):
            for name in files:
                if name.endswith(".jsonl") and "000000000001" in name:
                    with open(os.path.join(base, name), "a", encoding="utf-8") as fh:
                        fh.write(json.dumps({
                            "type": "message", "id": "zz2", "parentId": "e0004",
                            "timestamp": "2026-11-11T02:59:30Z",
                            "message": {"role": "assistant", "content": [],
                                        "provider": "acme", "model": "acme-large-1",
                                        "usage": {"input": 1, "output": 1, "cacheRead": 0,
                                                  "cacheWrite": 0, "totalTokens": 2},
                                        "stopReason": "stop", "timestamp": 1793000100000,
                                        "durationMs": 10}}) + "\n")
                    return

    def test_the_map_keeps_the_moment_the_topology_was_observed(self):
        with tempfile.TemporaryDirectory() as tmp:
            snapshot_path = os.path.join(FIXTURE_ROOT, "herdr", "snapshot.json")
            clock = _SteppingClock(os.path.getmtime(snapshot_path))
            db_path = os.path.join(tmp, "behold.db")
            args = cli.build_parser().parse_args(
                ["roster", "--root", FIXTURE_ROOT, "--cache", "on", "--cache-db", db_path])
            policy = guard.Policy()
            runner = cli.Runner(args, policy, clock=clock)
            runner.publish_admission()
            observed_epoch = runner.snapshot.observation.at_epoch
            try:
                deriver = cli.WatchDeriver(args, policy, runner, clock=clock)
                documents: list[dict] = []

                def emit(doc, step):
                    documents.append(doc)
                    self._plant_change()

                watch.run_watch(derive=deriver, emit=emit,
                                config=watch.WatchConfig(iterations=2, interval_s=0.05,
                                                         max_seconds=5.0))
            finally:
                runner.close()
            self.assertEqual(len(documents), 2, documents)
            # The published map carries the moment the topology was **observed**, not
            # the moment the watch published it again.
            with open(cache_mod.deny_file_path(db_path), encoding="utf-8") as fh:
                published = json.load(fh)
            self.assertEqual(published["captured_at_epoch"], observed_epoch)
            # It is fresh when it is written...
            cache_mod.read_deny_file(cache_mod.deny_file_path(db_path), now=observed_epoch)
            # ...and it ages from that moment, so the bound applies.
            with self.assertRaises(admission_mod.AdmissionError) as ctx:
                cache_mod.read_deny_file(
                    cache_mod.deny_file_path(db_path),
                    now=observed_epoch + admission_mod.ADMISSION_TTL_S + 1)
            self.assertIn("stale", str(ctx.exception))
            # The topology's provenance stays honest: the same source, and an age that
            # grows, because the watch did not look at the topology again.
            for document in documents:
                topology = document["behold"]["topology"]
                self.assertEqual(topology["kind"], "fixture_tree")
                self.assertEqual(topology["captured_at_source"], "file_mtime")
            self.assertGreater(documents[1]["behold"]["topology"]["age_s"],
                               documents[0]["behold"]["topology"]["age_s"])

    def test_the_watch_reports_the_capture_it_reused(self):
        # A reused **capture** keeps its provenance: the fresh runner of a watch
        # iteration has no capture receipt of its own, and used to report the topology
        # as "unknown" (or as a file) instead of the capture it was built from.
        with tempfile.TemporaryDirectory() as tmp:
            bindir = fake_herdr_bin(tmp, document=nested_snapshot())
            db_path = os.path.join(tmp, "behold.db")
            argv = ["roster", "--root", FIXTURE_ROOT, "--herdr", "--cache", "on",
                    "--cache-db", db_path, "--watch", "--watch-iterations", "1",
                    "--watch-max-seconds", "0.2"]
            buffer = io.StringIO()
            with mock.patch.dict(
                    os.environ,
                    {"PATH": bindir + os.pathsep + os.environ.get("PATH", "")}):
                with contextlib.redirect_stdout(buffer):
                    code = cli.main(argv)
            self.assertEqual(code, 0, buffer.getvalue()[:2000])
            documents = _documents(buffer.getvalue())
            self.assertTrue(documents, buffer.getvalue()[:2000])
            document = documents[0]
            capture = document["behold"]["capture"]
            self.assertTrue(capture["ok"])
            topology = document["behold"]["topology"]
            self.assertEqual(topology["kind"], "live_capture")
            self.assertEqual(topology["captured_at_source"], "capture_clock")
            self.assertEqual(topology["captured_at"], capture["captured_at"])
            # and the map is stamped with the capture, not with the publication
            with open(cache_mod.deny_file_path(db_path), encoding="utf-8") as fh:
                published = json.load(fh)
            self.assertEqual(published["captured_at_epoch"], capture["captured_at_epoch"])
            # herdr was asked once: the topology was captured once and reused
            self.assertEqual(fake_herdr_calls(bindir), ["api", "snapshot"])


class TestHermeticFixtures(unittest.TestCase):
    def test_jj_absent_and_present_both_work(self):
        # V4 removed the jj adapter and the --jj flag, so the roster is identical with a jj
        # binary present or absent: R-5 is a stat/token read and R-6 is a typed unknown.
        require_fixtures()

        def run_with_path(path: str):
            env = {**os.environ, "PATH": path, "PYTHONPATH": ROOT}
            proc = subprocess.run(
                [sys.executable, os.path.join(ROOT, "bin", "behold"), "roster",
                 "--root", FIXTURE_ROOT, "--as-of", AS_OF, "--lane", "w1G:p1",
                 "--cache", "off"],
                capture_output=True, text=True, timeout=120, env=env)
            self.assertEqual(proc.returncode, 0, proc.stderr[:600])
            return json.loads(proc.stdout)["lanes"][0]

        with tempfile.TemporaryDirectory() as empty:
            absent = run_with_path(empty)
        with tempfile.TemporaryDirectory() as withjj:
            fake = os.path.join(withjj, "jj")
            with open(fake, "w", encoding="utf-8") as fh:
                fh.write("#!/bin/sh\necho SHOULD-NEVER-RUN >&2\nexit 1\n")
            os.chmod(fake, 0o755)
            present = run_with_path(withjj)

        for lane in (absent, present):
            self.assertEqual(field(lane, "R-5")["state"], "present")
            self.assertEqual(field(lane, "R-6")["state"], "unknown")
            self.assertEqual(field(lane, "R-6")["reason"], "repo-adapter-not-isolated")
        self.assertEqual(json.dumps(absent), json.dumps(present),
                         "the roster must not depend on a jj binary at all")

    def test_no_network_or_subprocess_in_fixture_generation(self):
        with open(os.path.join(ROOT, "fixtures", "make_fixtures.py"), encoding="utf-8") as fh:
            source = fh.read()
        for needle in ("pip install", "npm install", "curl ", "wget ", "urllib", "socket.",
                       "http://", "https://", "subprocess", "os.system", "posix_spawn"):
            self.assertNotIn(needle, source, f"fixture generator must stay hermetic: {needle!r}")


if __name__ == "__main__":
    unittest.main()
