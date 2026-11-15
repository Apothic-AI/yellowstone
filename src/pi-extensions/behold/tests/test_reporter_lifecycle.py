"""The reporter's lifecycle, end to end: timer -> spool -> SQLite -> P-11.

The independent review of ``d8aa39f`` found a contradiction in the timestamp story:
the timer kept the *first* observation's ISO time, but ``collectState`` re-read the
context on every tick and ``writeSpool`` stamped the record with the *write* time, while
the reader computes the freshness from the epoch. So the ISO string and the epoch could
disagree, and the claim that the timer "keeps the observation stale" was false.

Pi's own extension contract settles what a sample is: "Context values are resolved at
call time, so changes via bindCore/bindUI are reflected". The context is a live view, so
a tick samples the session again, and the record is stamped with the sampling instant.

These tests are the evidence, and they use the **real** extension under node, a real
timer, the real spool, the real SQLite cache and the real roster join -- with temporary
fixtures only.
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

from tests.helpers import AS_OF, FIXTURE_ROOT, ROOT

sys.path.insert(0, ROOT)

from behold import admission as admission_mod  # noqa: E402
from behold import cache as cache_mod  # noqa: E402
from behold import cli, guard  # noqa: E402

NODE = shutil.which("node")
EXTENSION = os.path.join(ROOT, "pi-extension", "behold-state.ts")

SESSION = "aaaaaaaa-0000-4000-8000-000000000001"

#: A lane that starts with one model, changes it, and then goes idle. The tick has to
#: see the *new* value -- that is the whole point of the re-sample.
HARNESS = """
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import install from "file://%(extension)s";

process.env.HERDR_PANE_ID = "w1A:p1";
process.env.HERDR_WORKSPACE_ID = "w1A";
process.env.HERDR_TAB_ID = "w1A:t1";
if ("%(state_dir)s") process.env.BEHOLD_STATE_DIR = "%(state_dir)s";

const ctx = {
  cwd: "/tmp/lane",
  model: { id: "model-before-the-tick", provider: "acme" },
  thinkingLevel: "medium",
  sessionManager: {
    getSessionFile: () => "/tmp/sessions/x.jsonl",
    getSessionId: () => "%(session)s",
    getLeafId: () => "entry-7",
  },
  isIdle: () => true,
  hasPendingMessages: () => false,
  getContextUsage: () => ({ tokens: 100, contextWindow: 200000, percent: 0.05 }),
  getSystemPrompt: () => "SENTINEL_PROMPT_BODY you are a helpful assistant",
};

const handlers = {};
install({ on: (event, fn) => { handlers[event] = fn; } });
handlers["turn_end"]({}, ctx);

// the lane changes and goes idle: nothing else happens
ctx.model = { id: "model-after-the-tick", provider: "acme" };

await new Promise((resolve) => setTimeout(resolve, %(wait_ms)s));

const dir = "%(state_dir)s/inbox";
const files = existsSync(dir) ? readdirSync(dir) : [];
writeFileSync("%(out)s", JSON.stringify({
  files,
  records: files.map((name) => JSON.parse(readFileSync(dir + "/" + name, "utf-8"))),
}));
"""


def _iso_to_epoch(iso: str) -> float:
    from datetime import datetime

    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def _epoch_to_iso(epoch: float) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat().replace(
        "+00:00", "Z")


@unittest.skipUnless(NODE, "node is not installed: the static contract still holds")
class TestTheReporterLifecycle(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name
        self.state_dir = os.path.join(self.tmp, "state")
        os.makedirs(self.state_dir, exist_ok=True)
        self.db_path = os.path.join(self.tmp, "state", "behold.db")
        self.addCleanup(self._tmp.cleanup)
        self.write_admission()

    def write_admission(self) -> None:
        admission = admission_mod.build_map(
            policy=guard.Policy(),
            panes=[{"pane_id": "w1A:p1", "tab_id": "w1A:t1", "workspace_id": "w1A"}],
            topology_revision="lifecycle-test")
        with open(os.path.join(self.state_dir, admission_mod.ADMISSION_FILE_NAME), "w",
                  encoding="utf-8") as fh:
            json.dump(admission.to_dict(), fh)

    def run_lane(self, wait_ms: int = 2500) -> list[dict]:
        """Run the real extension with a real timer and return the records it wrote."""
        out_path = os.path.join(self.tmp, "out.json")
        script = os.path.join(self.tmp, "lane.mjs")
        with open(script, "w", encoding="utf-8") as fh:
            fh.write(HARNESS % {"extension": EXTENSION, "state_dir": self.state_dir,
                                "out": out_path, "wait_ms": wait_ms, "session": SESSION})
        env = {**os.environ, "BEHOLD_STATE_INTERVAL_MS": "1000",
               "BEHOLD_STATE_DIR": self.state_dir}
        proc = subprocess.run([NODE, script], capture_output=True, text=True,
                              timeout=120, env=env)
        self.assertEqual(proc.returncode, 0, proc.stderr[:2000])
        with open(out_path, "r", encoding="utf-8") as fh:
            return json.load(fh)["records"]

    def ingest(self) -> dict:
        """Ingest the spool into a real SQLite cache and return the ingest result."""
        with cache_mod.Cache(self.db_path) as cache:
            admission = admission_mod.build_map(
                policy=guard.Policy(),
                panes=[{"pane_id": "w1A:p1", "tab_id": "w1A:t1", "workspace_id": "w1A"}],
                topology_revision="lifecycle-test")
            return cache.ingest_inbox(admission_map=admission)

    def roster(self) -> dict:
        """Run the roster against the fixture tree and the cache, in-process."""
        import contextlib
        import io

        buffer = io.StringIO()
        argv = ["roster", "--root", FIXTURE_ROOT, "--as-of", AS_OF,
                "--cache", "on", "--cache-db", self.db_path]
        with contextlib.redirect_stdout(buffer):
            code = cli.main(argv)
        self.assertEqual(code, 0, buffer.getvalue()[:2000])
        return json.loads(buffer.getvalue())

    def newest_record_path(self) -> str:
        inbox = os.path.join(self.state_dir, "inbox")
        names = sorted(os.listdir(inbox))
        self.assertTrue(names, "the lane wrote no record")
        return os.path.join(inbox, names[-1])

    def test_the_tick_samples_the_context_again_and_stamps_the_sample_time(self) -> None:
        """The timer -> spool -> SQLite -> P-11 path, with a changed state.

        The lane starts with one model, the model changes, and then the lane is idle: no
        event happens. The tick has to sample the **new** value and stamp the record with
        the sampling instant.
        """
        records = self.run_lane()
        self.assertGreaterEqual(len(records), 2, records)
        by_seq = {record["seq"]: record for record in records}
        self.assertEqual(sorted(by_seq), list(range(1, len(records) + 1)))
        # the event's record saw the old model, the tick's record the new one
        self.assertEqual(by_seq[1]["state"]["model_id"], "model-before-the-tick")
        last = by_seq[max(by_seq)]
        self.assertEqual(last["state"]["model_id"], "model-after-the-tick")

        # the ISO string and the epoch are the same moment
        for record in records:
            self.assertAlmostEqual(_iso_to_epoch(record["observed_at"]),
                                   record["observed_at_epoch"], places=2,
                                   msg=record["observed_at"])
        # the tick's record is stamped at the TICK, not at the event: the delay shows
        self.assertGreater(last["observed_at_epoch"], by_seq[1]["observed_at_epoch"])
        self.assertAlmostEqual(last["observed_at_epoch"], time.time(), delta=30)
        # and the reporter's monotone clock agrees with the wall clock
        for record in records:
            self.assertLess(abs(record["mono_epoch"] - record["observed_at_epoch"]), 60)

        # the spool -> SQLite step keeps the newest observation
        result = self.ingest()
        self.assertEqual(result["written"], 1, result)
        with cache_mod.Cache(self.db_path) as cache:
            read = cache.read_pi_state("w1A:p1", session_id=SESSION)
            self.assertEqual(read.state, cache_mod.FRESH)
            self.assertEqual(read.value["model_id"], "model-after-the-tick")

        # and the roster joins it onto the lane as P-11
        doc = self.roster()
        lanes = {lane["key"]: lane for lane in doc["lanes"]}
        field = lanes["w1A:p1"]["fields"]["P-11"]
        self.assertEqual(field["state"], "present", field)
        self.assertEqual(field["value"]["freshness"], "fresh", field)
        self.assertEqual(field["value"]["observed"]["model_id"], "model-after-the-tick")

    def test_a_record_whose_clock_disagrees_is_disputed_through_the_join(self) -> None:
        """The clock behaviour, through the same path.

        A record whose monotone clock disagrees with the wall clock has an age that
        cannot be trusted, so the join must say so instead of calling it fresh.
        """
        records = self.run_lane(wait_ms=1200)
        self.assertTrue(records)
        path = self.newest_record_path()
        with open(path, "r", encoding="utf-8") as fh:
            record = json.load(fh)
        record["mono_epoch"] = record["observed_at_epoch"] - 3600
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(record, fh)
        result = self.ingest()
        self.assertEqual(result["written"], 1, result)
        doc = self.roster()
        lanes = {lane["key"]: lane for lane in doc["lanes"]}
        field = lanes["w1A:p1"]["fields"]["P-11"]
        # a disputed observation has no age, so no value is returned at all
        self.assertEqual(field["state"], "unknown", field)
        self.assertIsNone(field["value"], field)
        self.assertIn("clock_disputed", field["reason"], field)

    def test_a_stale_record_is_stale_through_the_join(self) -> None:
        """An old observation stays old: the freshness is the age, not a habit."""
        records = self.run_lane(wait_ms=1200)
        self.assertTrue(records)
        path = self.newest_record_path()
        with open(path, "r", encoding="utf-8") as fh:
            record = json.load(fh)
        age = cache_mod.DEFAULT_FRESHNESS_S * 10
        record["observed_at_epoch"] = time.time() - age
        record["observed_at"] = _epoch_to_iso(record["observed_at_epoch"])
        record["mono_epoch"] = record["observed_at_epoch"]
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(record, fh)
        result = self.ingest()
        self.assertEqual(result["written"], 1, result)
        doc = self.roster()
        lanes = {lane["key"]: lane for lane in doc["lanes"]}
        field = lanes["w1A:p1"]["fields"]["P-11"]
        self.assertEqual(field["value"]["freshness"], "stale", field)
        self.assertNotEqual(field["state"], "present")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
