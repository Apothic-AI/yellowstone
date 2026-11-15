"""Watch: bounded file/event invalidation with honest freshness, and no daemon.

Each test drives ``watch.run_watch`` with a callback that mutates exactly one input between
iterations, so the assertions are deterministic instead of timing-dependent.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

from tests.helpers import FIXTURE_ROOT, ROOT, require_fixtures

sys.path.insert(0, ROOT)

from behold import cli, watch  # noqa: E402


class WatchHarness:
    """A small fixture fleet in a temp dir, driven through the real CLI runner."""

    def __init__(self, lanes: int = 3):
        self.tmp = tempfile.mkdtemp(prefix="behold-watch-")
        self.root = os.path.join(self.tmp, "fixtures")
        subprocess.run([sys.executable, os.path.join(ROOT, "fixtures", "make_fixtures.py"),
                        self.root, "--lanes", str(lanes)],
                       check=True, capture_output=True, text=True)
        self.manifest = json.loads(subprocess.run(
            [sys.executable, os.path.join(ROOT, "fixtures", "make_fixtures.py"), "--help"],
            capture_output=True, text=True).stdout and "{}")
        self.session = os.path.join(self.root, "instances", "launch-A", "sessions")
        self.runner_args = self._args()

    def _args(self):
        import argparse

        parser = cli.build_parser()
        args = parser.parse_args(["roster", "--root", self.root,
                                  "--as-of", "2026-11-11T03:00:00Z"])
        return args

    def policy(self):
        from behold import guard

        return guard.Policy()

    def derive(self):
        from behold import cli as cli_mod

        runner = cli_mod.Runner(self._args(), self.policy())
        lanes, inputs, sessions = runner.lanes_and_inputs()
        return runner.document(lanes, runner.last_ctx), inputs, sessions

    def close(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestWatchInvalidation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        require_fixtures()
        cls.h = WatchHarness(lanes=3)

    @classmethod
    def tearDownClass(cls):
        cls.h.close()

    def _session_for(self, lane: str) -> str:
        sessions = {}
        _doc, _inputs, sessions = self.h.derive()
        return sessions[lane]

    def test_append_invalidates_only_the_changed_lane(self):
        target = self._session_for("w1A:p1")
        doc, inputs, sessions = self.h.derive()
        state = {"done": False}

        def mutate():
            if state["done"]:
                return
            state["done"] = True
            with open(target, "a", encoding="utf-8") as fh:
                fh.write(json.dumps({
                    "type": "message", "id": "e9001", "parentId": "e0004",
                    "timestamp": "2026-11-11T02:58:00Z",
                    "message": {"role": "assistant", "content": [],
                                "provider": "acme", "model": "acme-large-1",
                                "usage": {"input": 5, "output": 5, "cacheRead": 0,
                                          "cacheWrite": 0, "totalTokens": 10},
                                "stopReason": "stop", "timestamp": 1793000000000,
                                "durationMs": 100},
                }) + "\n")

        steps = watch.run_watch(
            derive=self.h.derive,
            emit=lambda doc, step: mutate(),
            config=watch.WatchConfig(iterations=2, interval_s=0.05, max_seconds=10.0),
        )
        self.assertEqual(len(steps), 2)
        self.assertEqual(steps[1].refreshed_lanes, 1)
        self.assertGreaterEqual(len(steps[1].changed_sources), 1)
        self.assertIn(target, steps[1].changed_sources)
        self.assertEqual(steps[1].rotated, [])

    def test_events_only_change_does_not_refresh_session_fields(self):
        events = os.path.join(self.h.tmp, "events.jsonl")
        with open(events, "w", encoding="utf-8") as fh:
            fh.write("{}\n")
        state = {"done": False}

        def mutate():
            if state["done"]:
                return
            state["done"] = True
            with open(events, "a", encoding="utf-8") as fh:
                fh.write('{"event":"workspace.updated"}\n')

        steps = watch.run_watch(
            derive=self.h.derive,
            emit=lambda doc, step: mutate(),
            config=watch.WatchConfig(iterations=2, interval_s=0.05, max_seconds=10.0,
                                     events_file=events),
        )
        self.assertEqual(len(steps), 2)
        self.assertEqual(steps[1].refreshed_lanes, 0, "herdr events must not refresh session data")
        self.assertTrue(any(src.startswith("events:") for src in steps[1].changed_sources))

    def test_rotation_is_detected(self):
        target = self._session_for("w1A:p2")
        with open(target, "r", encoding="utf-8") as fh:
            original = fh.read()
        state = {"done": False}

        def mutate():
            if state["done"]:
                return
            state["done"] = True
            replacement = target + ".new"
            with open(replacement, "w", encoding="utf-8") as fh:
                fh.write(original)
            os.replace(replacement, target)

        steps = watch.run_watch(
            derive=self.h.derive,
            emit=lambda doc, step: mutate(),
            config=watch.WatchConfig(iterations=2, interval_s=0.05, max_seconds=10.0),
        )
        self.assertEqual(len(steps), 2)
        self.assertIn(target, steps[1].rotated)

    def test_process_exit_is_reported(self):
        proc_stat = os.path.join(self.h.root, "proc", "4002", "stat")
        state = {"done": False}

        def mutate():
            if state["done"]:
                return
            state["done"] = True
            os.unlink(proc_stat)

        steps = watch.run_watch(
            derive=self.h.derive,
            emit=lambda doc, step: mutate(),
            config=watch.WatchConfig(iterations=2, interval_s=0.05, max_seconds=10.0),
        )
        self.assertEqual(len(steps), 2)
        self.assertIn("w1A:p2", steps[1].process_exits)

    def test_no_change_no_render(self):
        steps = watch.run_watch(
            derive=self.h.derive,
            emit=lambda doc, step: None,
            config=watch.WatchConfig(iterations=4, interval_s=0.05, max_seconds=0.4),
        )
        # Nothing changed, so exactly one document was emitted and the loop stopped early.
        self.assertEqual(len(steps), 1)
        # bounded by max_seconds; the loop cannot spin past it
        self.assertLessEqual(steps[-1].elapsed_s, 0.9)

    def test_spin_loop_is_refused(self):
        for bad in (watch.WatchConfig(iterations=1, interval_s=0.01),
                    watch.WatchConfig(iterations=0, interval_s=0.5),
                    watch.WatchConfig(iterations=1, interval_s=0.5, max_seconds=0)):
            with self.assertRaises(ValueError):
                bad.validate()

    def test_watch_is_bounded_by_iterations_and_seconds(self):
        state = {"n": 0}

        def mutate():
            state["n"] += 1
            # append every iteration so the loop always has something to do
            target = self._session_for("w1F:p1")
            with open(target, "a", encoding="utf-8") as fh:
                fh.write(json.dumps({"type": "label", "id": f"L{state['n']}",
                                     "parentId": "e0004", "timestamp": "2026-11-11T02:59:00Z",
                                     "targetId": "e0001", "label": "x"}) + "\n")

        steps = watch.run_watch(
            derive=self.h.derive,
            emit=lambda doc, step: mutate(),
            config=watch.WatchConfig(iterations=3, interval_s=0.05, max_seconds=0.5),
        )
        self.assertLessEqual(len(steps), 3)
        self.assertLess(steps[-1].elapsed_s, 1.0)


class TestRotationProbe(unittest.TestCase):
    def test_shrink_or_inode_change_is_rotation(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "s.jsonl")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write('{"a":1}\n' * 10)
            import os as _os

            st = _os.stat(path)
            previous = {"inode": st.st_ino, "size": st.st_size}
            rotated, current = _denoise(path, previous)
            self.assertFalse(rotated)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("")
            rotated, current = _denoise(path, previous)
            self.assertTrue(rotated)


def _denoise(path, previous):
    from behold import session
    return session.probe_rotation(path, previous)


if __name__ == "__main__":
    unittest.main()
