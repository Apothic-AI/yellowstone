"""Bench: measured numbers against the plan's budget *targets*.

The plan's §8.3 budgets are targets derived from planning-time measurements, not proof about
a whole live fleet. This suite measures the same shapes on a 61-lane synthetic fleet and
prints p50/p95 so a regression is a number, not an opinion. Failures are reported with the
measured value.

Method: N=5 in-process derivations (adapter cost, not Python startup), medians and p95;
``time.perf_counter``. Warm = snapshot + session parse, no git. Cold = with git.
"""

from __future__ import annotations

import argparse
import statistics
import sys
import time
import unittest

from tests.helpers import AS_OF, FIXTURE_ROOT, ROOT, require_fixtures

sys.path.insert(0, ROOT)

from behold import cli, guard, render  # noqa: E402
from behold.sources import herdr  # noqa: E402

N = 5
BUDGETS = render.BUDGET_TARGETS


def percentile(samples: list[float], fraction: float) -> float:
    ordered = sorted(samples)
    index = min(len(ordered) - 1, int(round(fraction * (len(ordered) - 1))))
    return ordered[index]


def measure(fn, n: int = N) -> tuple[float, float]:
    samples = []
    for _ in range(n):
        started = time.perf_counter()
        fn()
        samples.append((time.perf_counter() - started) * 1000.0)
    return statistics.median(samples), percentile(samples, 0.95)


def args_for(extra: list[str]) -> argparse.Namespace:
    return cli.build_parser().parse_args(["roster", "--root", FIXTURE_ROOT, "--as-of", AS_OF, *extra])


class TestBench(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        require_fixtures()

    def _derive(self, extra: list[str]):
        args = args_for(extra)
        policy = guard.Policy()
        runner = cli.Runner(args, policy)
        lanes, inputs, sessions = runner.lanes_and_inputs()
        doc = runner.document(lanes, runner.last_ctx)
        return doc, lanes

    def test_snapshot_load(self):
        path = f"{FIXTURE_ROOT}/herdr/snapshot.json"
        policy = guard.Policy()
        p50, p95 = measure(lambda: herdr.load(path, policy))
        print(f"\n  snapshot load           p50={p50:7.2f} ms  p95={p95:7.2f} ms  "
              f"budget<={BUDGETS['snapshot_ms']} ms")
        self.assertLess(p50, BUDGETS["snapshot_ms"] * 4, "4x budget is a real regression")

    def test_warm_roster_61_lanes(self):
        p50, p95 = measure(lambda: self._derive([]))
        print(f"  warm roster (no child)    p50={p50:7.2f} ms  p95={p95:7.2f} ms  "
              f"budget<={BUDGETS['warm_metadata_roster_61_lanes_ms']} ms")
        self.assertLess(
            p50, BUDGETS["warm_metadata_roster_61_lanes_ms"] * 4,
            f"warm roster p50={p50:.1f} ms exceeds 4x the {BUDGETS['warm_metadata_roster_61_lanes_ms']} ms target",
        )

    def test_single_lane(self):
        p50, p95 = measure(lambda: self._derive(["--lane", "w1A:p1"]))
        print(f"  single lane             p50={p50:7.2f} ms  p95={p95:7.2f} ms  "
              f"budget<={BUDGETS['single_lane_ms']} ms")
        self.assertLess(p50, BUDGETS["single_lane_ms"] * 4)

    def test_full_roster_without_external_adapters(self):
        # V3 runs no child process, so the "cold with git" budget is not applicable; the run
        # must simply stay well inside the same ceiling.
        p50, p95 = measure(lambda: self._derive([]), n=3)
        print(f"  full roster (no child)  p50={p50:7.2f} ms  p95={p95:7.2f} ms  "
              f"ceiling<={BUDGETS['cold_full_roster_git_ms']} ms")
        self.assertLess(p50, BUDGETS["cold_full_roster_git_ms"] * 4)

    def test_multi_mb_session_parse(self):
        from behold import session

        path = self._big_session()
        policy = guard.Policy()
        p50, p95 = measure(lambda: session.load(path, policy), n=3)
        size_mb = round(len(open(path, "rb").read()) / 1_048_576, 2)
        print(f"  multi-MB session ({size_mb} MB) p50={p50:7.2f} ms  p95={p95:7.2f} ms  "
              f"budget<={BUDGETS['session_parse_multi_mb_ms']} ms")
        self.assertGreater(size_mb, 1.0, "the fixture must be substantially bigger than 398 KiB")
        self.assertLess(p50, BUDGETS["session_parse_multi_mb_ms"] * 2)

    def _big_session(self) -> str:
        import json
        import os

        for base, _dirs, files in os.walk(f"{FIXTURE_ROOT}/instances"):
            for name in files:
                if name.endswith(".jsonl") and "000000000007" in name:
                    return os.path.join(base, name)
        self.skipTest("multi-MB fixture session not found")

    def test_bench_prints_full_table(self):
        print("\n  budget targets (targets, not measured whole-fleet proof):")
        for key, value in BUDGETS.items():
            if key == "note":
                continue
            print(f"    {key}: {value}")


if __name__ == "__main__":
    unittest.main()
