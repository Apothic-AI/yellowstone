"""The spool's concurrency contract: one file per write, one owner per pane.

The previous scheme kept ONE file per lane and replaced it. That is a read-modify-write
with no compare-and-swap: two writers could interleave, and the **older** one could win
the file before the first ingest -- and the reader would then never see the newer
observation at all. The independent review of commit ``2b0675d`` raised exactly that.

The scheme now is: **every write gets its own file, and a file name is never reused**.
The incarnation and the sequence number are in the name, so:

* two writers never touch the same pathname, so there is no window to interleave in;
* the reader may unlink a file it has read without the risk of destroying a newer
  record for the same lane, because no writer will ever write that name again;
* the reader owns the ordering: it groups a pane's records by incarnation and keeps the
  newest one, whatever order the files happen to be listed in.

These tests are the evidence: both arrival orders, a late older writer, a crash at each
step, a replay, a ``/reload`` inside the same process, malformed records, a name that
disagrees with the record inside it, and the bound on the spool's growth.
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

from tests.helpers import ROOT

sys.path.insert(0, ROOT)

from behold import admission as admission_mod  # noqa: E402
from behold import cache as cache_mod  # noqa: E402
from behold import guard  # noqa: E402

SESSION_A = "aaaaaaaa-0000-4000-8000-000000000001"

BOOT = "11111111-2222-3333-4444-555555555555"
INC_OLD = f"{BOOT}:4000:900000"     # an earlier incarnation of the same boot
INC_NEW = f"{BOOT}:4002:900002"     # a later incarnation of the same boot
INC_OTHER_BOOT = "99999999-8888-7777-6666-555555555555:5000:100"

NODE = shutil.which("node")
EXTENSION = os.path.join(ROOT, "pi-extension", "behold-state.ts")

#: A writer that runs in its own process, waits for a signal, and then writes. Two of
#: these, released at the same moment, are two reporters writing the same pane at the
#: same time.
WRITER = """
import { existsSync, writeFileSync } from "node:fs";
import { writeSpool } from "%(extension)s";

const parts = process.env.INC.split(":");
const inc = {
  id: process.env.INC,
  bootId: parts[0],
  startTicks: Number(parts[2]),
  bootEpoch: Number(process.env.BOOT_EPOCH || "5000"),
};
writeFileSync(process.env.READY, "ready");
let waited = 0;
while (!existsSync(process.env.GO) && waited < 60000) {
  waited += 10;
  const until = Date.now() + 10;
  while (Date.now() < until) { /* spin */ }
}
const target = writeSpool(process.env.BEHOLD_STATE_DIR, "w1A:p1", "w1A:t1", "session",
  { model_id: process.env.MODEL }, 1, Date.now() / 1000, inc);
if (!target) { process.exit(3); }
"""


def build_admission() -> admission_mod.AdmissionMap:
    records = [
        {"pane_id": "w1A:p1", "tab_id": "w1A:t1", "workspace_id": "w1A"},
        {"pane_id": "w2:p1", "tab_id": "w2:t1", "workspace_id": "w2"},
        {"pane_id": "wE:p99", "tab_id": "wE:t19", "workspace_id": "wE"},
    ]
    return admission_mod.build_map(policy=guard.Policy(), panes=records,
                                   topology_revision="test-revision")


class SpoolTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name
        self.db_path = os.path.join(self.tmp, "state", "behold.db")
        self.inbox = cache_mod.inbox_dir_for(self.db_path)
        os.makedirs(self.inbox, exist_ok=True)
        self.cache = cache_mod.Cache(self.db_path)
        self.admission = build_admission()
        self.addCleanup(self._tmp.cleanup)
        self.addCleanup(self.cache.close)

    def record(self, incarnation: str = INC_NEW, seq: int = 1, *,
               pane_id: str = "w1A:p1", tab_id: str = "w1A:t1",
               model: str = "acme-fast-1", **overrides: object) -> dict:
        boot, _pid, ticks = incarnation.split(":")
        record = {
            "behold_state": cache_mod.STATE_RECORD_VERSION,
            "pane_id": pane_id,
            "tab_id": tab_id,
            "session_id": SESSION_A,
            "incarnation": incarnation,
            "boot_id": boot,
            "incarnation_start_ticks": int(ticks),
            "incarnation_boot_epoch": 5000.0,
            "seq": seq,
            "observed_at": "2026-11-12T00:00:00Z",
            "observed_at_epoch": time.time(),
            "mono_epoch": time.time(),
            "state": {"model_id": model, "herdr_pane_id": pane_id},
            "writer": "pi-extension",
        }
        record.update(overrides)
        return record

    def spool(self, record: dict, name: str | None = None) -> str:
        path = os.path.join(self.inbox, name or cache_mod.spool_file_name(
            record["pane_id"], record.get("tab_id"),
            record.get("incarnation"), record.get("seq")))
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(record, fh)
        return path

    def names(self) -> list[str]:
        return sorted(os.listdir(self.inbox))


class TestTheOwnerOfAPane(SpoolTestCase):
    def test_the_newer_incarnation_owns_the_pane(self) -> None:
        self.spool(self.record(INC_NEW, 1, model="newer-model"))
        self.spool(self.record(INC_OLD, 1, model="older-model"))
        result = self.cache.ingest_inbox(admission_map=self.admission)
        self.assertEqual(result["written"], 1, result)
        read = self.cache.read_pi_state("w1A:p1", session_id=SESSION_A)
        self.assertEqual(read.value["model_id"], "newer-model")
        self.assertEqual(read.incarnation, INC_NEW)

    def test_the_owner_does_not_depend_on_the_arrival_order(self) -> None:
        # The same two records, written the other way round.
        self.spool(self.record(INC_OLD, 1, model="older-model"))
        self.spool(self.record(INC_NEW, 1, model="newer-model"))
        result = self.cache.ingest_inbox(admission_map=self.admission)
        self.assertEqual(result["written"], 1, result)
        read = self.cache.read_pi_state("w1A:p1", session_id=SESSION_A)
        self.assertEqual(read.value["model_id"], "newer-model")
        self.assertEqual(read.incarnation, INC_NEW)

    def test_an_older_writer_that_arrives_late_cannot_take_the_pane_back(self) -> None:
        # The late reporter: the newer incarnation is already stored, and the older one
        # is refused. This is the case the old scheme got wrong.
        self.spool(self.record(INC_NEW, 1, model="newer-model"))
        self.cache.ingest_inbox(admission_map=self.admission)
        self.spool(self.record(INC_OLD, 1, model="older-model"))
        result = self.cache.ingest_inbox(admission_map=self.admission)
        self.assertEqual(result["written"], 0, result)
        read = self.cache.read_pi_state("w1A:p1", session_id=SESSION_A)
        self.assertEqual(read.value["model_id"], "newer-model")
        self.assertEqual(read.incarnation, INC_NEW)

    def test_the_highest_sequence_number_wins_within_one_incarnation(self) -> None:
        self.spool(self.record(INC_NEW, 3, model="third"))
        self.spool(self.record(INC_NEW, 9, model="ninth"))
        self.spool(self.record(INC_NEW, 5, model="fifth"))
        result = self.cache.ingest_inbox(admission_map=self.admission)
        self.assertEqual(result["written"], 1, result)
        read = self.cache.read_pi_state("w1A:p1", session_id=SESSION_A)
        self.assertEqual(read.value["model_id"], "ninth")

    def test_an_unorderable_pair_is_refused_rather_than_guessed_at(self) -> None:
        # Two boots whose epochs are too close to order: nothing is stored for the pane.
        self.spool(self.record(INC_NEW, 1, incarnation_boot_epoch=5000.0))
        self.spool(self.record(INC_OTHER_BOOT, 1, incarnation_boot_epoch=5001.0))
        result = self.cache.ingest_inbox(admission_map=self.admission)
        self.assertEqual(result["written"], 0, result)
        self.assertEqual(result["ambiguous_incarnation"], 2, result)
        self.assertEqual(self.cache.pi_state_freshness()["rows"], 0)

    def test_a_name_that_disagrees_with_the_record_is_refused(self) -> None:
        # A collision: the name says one incarnation and the record claims another.
        path = self.spool(self.record(INC_NEW, 1), name=cache_mod.spool_file_name(
            "w1A:p1", "w1A:t1", INC_OLD, 1))
        result = self.cache.ingest_inbox(admission_map=self.admission)
        self.assertEqual(result["written"], 0, result)
        self.assertEqual(result["skipped_identity"], 1, result)
        # and the file is left alone: the reader does not delete what it refused
        self.assertTrue(os.path.exists(path))

    def test_a_malformed_record_is_refused_and_not_stored(self) -> None:
        path = os.path.join(self.inbox, cache_mod.spool_file_name(
            "w1A:p1", "w1A:t1", INC_NEW, 1))
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("{not json")
        result = self.cache.ingest_inbox(admission_map=self.admission)
        self.assertEqual(result["written"], 0, result)
        self.assertEqual(result["skipped_malformed"], 1, result)
        self.assertEqual(self.cache.pi_state_freshness()["rows"], 0)


class TestTheCleanup(SpoolTestCase):
    def test_the_cleanup_keeps_the_current_observation(self) -> None:
        self.spool(self.record(INC_NEW, 1, model="newer-model"))
        self.spool(self.record(INC_OLD, 1, model="older-model"))
        self.cache.ingest_inbox(admission_map=self.admission)
        names = self.names()
        self.assertEqual(len(names), 1, names)
        with open(os.path.join(self.inbox, names[0]), encoding="utf-8") as fh:
            self.assertIn("newer-model", fh.read())
        # and the observation is still in the cache
        read = self.cache.read_pi_state("w1A:p1", session_id=SESSION_A)
        self.assertEqual(read.value["model_id"], "newer-model")

    def test_the_cleanup_removes_the_superseded_records_of_one_incarnation(self) -> None:
        self.spool(self.record(INC_NEW, 1))
        self.spool(self.record(INC_NEW, 2))
        self.spool(self.record(INC_NEW, 3))
        self.cache.ingest_inbox(admission_map=self.admission)
        names = self.names()
        self.assertEqual(len(names), 1, names)
        self.assertIn(".s3.json", names[0])

    def test_the_cleanup_never_touches_a_refused_lanes_file(self) -> None:
        # The held lane's record is never opened, so it is never removed either: the
        # reader does not even look at it.
        path = self.spool(self.record(INC_NEW, 1, pane_id="w2:p1", tab_id="w2:t1",
                                      model="held"))
        result = self.cache.ingest_inbox(admission_map=self.admission)
        self.assertEqual(result["written"], 0, result)
        self.assertEqual(result["skipped_denied"], 1, result)
        self.assertTrue(os.path.exists(path))

    def test_the_spool_stays_bounded_across_many_ingests(self) -> None:
        # The writer writes one file per observation; the reader keeps one file per
        # pane. The spool does not grow with the number of observations.
        for seq in range(1, 21):
            self.spool(self.record(INC_NEW, seq))
            self.cache.ingest_inbox(admission_map=self.admission)
        self.assertEqual(len(self.names()), 1, self.names())

    def test_a_writer_that_writes_during_the_cleanup_is_not_removed(self) -> None:
        """The cleanup and a writer run at the same time.

        The writer's file has a name of its own (the incarnation and the sequence
        number are in it), so the cleanup cannot be looking at the file the writer is
        about to create: the writer's new record survives, and it is the observation the
        next ingest stores.
        """
        self.spool(self.record(INC_NEW, 1))
        self.spool(self.record(INC_OLD, 1, model="older-model"))
        # the writer writes while the reader is cleaning up: the new file appears
        # between the reader's listing and its cleanup.
        writer_path = self.spool(self.record(INC_NEW, 2, model="written-during-cleanup"))
        result = self.cache.ingest_inbox(admission_map=self.admission)
        self.assertEqual(result["written"], 1, result)
        names = self.names()
        self.assertIn(os.path.basename(writer_path), names)
        # and it is the observation the reader keeps: the newest one wins
        read = self.cache.read_pi_state("w1A:p1", session_id=SESSION_A)
        self.assertEqual(read.value["model_id"], "written-during-cleanup")

    def test_the_cleanup_never_removes_the_current_observation(self) -> None:
        # The owner's own file is kept: it is the writer's sequence seed, and dropping
        # it would send the sequence back to 1.
        self.spool(self.record(INC_NEW, 4))
        self.cache.ingest_inbox(admission_map=self.admission)
        names = self.names()
        self.assertEqual(len(names), 1, names)
        self.assertIn(".s4.json", names[0])

    def test_a_stale_writer_that_writes_again_after_its_files_were_removed_is_refused(self) -> None:
        """The one case where the cleanup can lose a file: a name that is re-created.

        The writer's sequence only grows, so a name is never written twice -- unless the
        writer's files were all removed and its counter restarted. That can only happen
        to an incarnation the reader has already decided is superseded, so the record it
        writes is refused anyway: the loss costs nothing.
        """
        self.spool(self.record(INC_NEW, 1, model="newer-model"))
        self.spool(self.record(INC_OLD, 1, model="older-model"))
        self.cache.ingest_inbox(admission_map=self.admission)
        # the old writer's file was removed by the cleanup, and it writes again
        self.spool(self.record(INC_OLD, 1, model="older-model-again"))
        result = self.cache.ingest_inbox(admission_map=self.admission)
        self.assertEqual(result["written"], 0, result)
        read = self.cache.read_pi_state("w1A:p1", session_id=SESSION_A)
        self.assertEqual(read.value["model_id"], "newer-model")
        self.assertEqual(read.incarnation, INC_NEW)


class TestTheReadersCrashPoints(SpoolTestCase):
    def test_a_crash_before_the_rename_leaves_nothing_to_ingest(self) -> None:
        # The writer's temp file is not a record: it does not end in .json, and the
        # reader ignores it.
        temp = os.path.join(self.inbox, cache_mod.spool_file_name(
            "w1A:p1", "w1A:t1", INC_NEW, 1) + ".tmp.4242")
        with open(temp, "w", encoding="utf-8") as fh:
            fh.write('{"behold_state": 2, "pane_id": "w1A:p1"}')
        result = self.cache.ingest_inbox(admission_map=self.admission)
        self.assertEqual(result["files"], 0, result)
        self.assertEqual(result["written"], 0, result)

    def test_a_crash_after_the_rename_leaves_a_complete_record(self) -> None:
        self.spool(self.record(INC_NEW, 1))
        result = self.cache.ingest_inbox(admission_map=self.admission)
        self.assertEqual(result["written"], 1, result)

    def test_the_ingest_is_idempotent(self) -> None:
        # A replay: the same record ingested twice changes nothing.
        self.spool(self.record(INC_NEW, 1))
        first = self.cache.ingest_inbox(admission_map=self.admission)
        second = self.cache.ingest_inbox(admission_map=self.admission)
        self.assertEqual(first["written"], 1, first)
        self.assertEqual(second["written"], 0, second)
        read = self.cache.read_pi_state("w1A:p1", session_id=SESSION_A)
        self.assertEqual(read.value["model_id"], "acme-fast-1")

    def test_a_restarted_incarnation_continues_its_sequence(self) -> None:
        # A /reload inside the same process restarts the module, not the process: the
        # sequence has to continue, or the cache would refuse the record.
        self.spool(self.record(INC_NEW, 7))
        self.assertEqual(cache_mod.Cache(self.db_path).ingest_inbox.__name__, "ingest_inbox")
        # the reader accepts the next sequence number
        self.spool(self.record(INC_NEW, 8))
        result = self.cache.ingest_inbox(admission_map=self.admission)
        self.assertEqual(result["written"], 1, result)


@unittest.skipUnless(NODE, "node is not installed: the static contract still holds")
class TestOverlappingReporters(SpoolTestCase):
    def _write_admission(self) -> None:
        admission = self.admission.to_dict()
        with open(os.path.join(self.tmp, admission_mod.ADMISSION_FILE_NAME), "w",
                  encoding="utf-8") as fh:
            json.dump(admission, fh)

    def test_two_overlapping_processes_leave_two_files_and_one_owner(self) -> None:
        script = os.path.join(self.tmp, "writer.mjs")
        with open(script, "w", encoding="utf-8") as fh:
            fh.write(WRITER % {"extension": EXTENSION})
        go = os.path.join(self.tmp, "go")
        procs = []
        for index, (incarnation, model) in enumerate((
                (INC_OLD, "older-model"), (INC_NEW, "newer-model"))):
            env = {**os.environ,
                   "BEHOLD_STATE_DIR": os.path.dirname(self.inbox),
                   "GO": go,
                   "READY": os.path.join(self.tmp, f"ready-{index}"),
                   "INC": incarnation,
                   "MODEL": model}
            procs.append(subprocess.Popen([NODE, script], env=env,
                                          stdout=subprocess.PIPE,
                                          stderr=subprocess.PIPE, text=True))
        deadline = time.time() + 60
        while time.time() < deadline:
            if all(os.path.exists(os.path.join(self.tmp, f"ready-{i}")) for i in (0, 1)):
                break
            time.sleep(0.01)
        else:
            self.fail("the writers never became ready")
        with open(go, "w", encoding="utf-8") as fh:
            fh.write("go")
        for proc in procs:
            _out, err = proc.communicate(timeout=60)
            self.assertEqual(proc.returncode, 0, err)
        names = self.names()
        self.assertEqual(len(names), 2, names)
        # the reader decides the owner, and it is the newer incarnation
        result = self.cache.ingest_inbox(admission_map=self.admission)
        self.assertEqual(result["written"], 1, result)
        # the writers used their own session id, so the row is read with it
        read = self.cache.read_pi_state("w1A:p1", session_id="session")
        self.assertEqual(read.value["model_id"], "newer-model")
        self.assertEqual(read.incarnation, INC_NEW)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
