"""The cache, tested as a boundary: schema, atomicity, freshness, identity and privacy.

The cache is the one place behold writes, so the tests here are mostly about what it
*refuses* to do: accept an unknown field, overwrite a newer record with an older one,
hand back a value that belongs to another session, or keep a piece of content that was
handed to it by mistake.

Version 2 added the **ownership rule** (an incarnation owns a pane, and only a later
incarnation may take it over) and the **admission map** (the ingester refuses a refused
lane's record before opening it). The tests below are the evidence for both.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
import unittest

from tests.helpers import ROOT

sys.path.insert(0, ROOT)

from behold import admission as admission_mod  # noqa: E402
from behold import cache as cache_mod  # noqa: E402
from behold import guard  # noqa: E402


def _map_for(document: dict) -> "admission_mod.AdmissionMap":
    """An admission map that places the panes in this document.

    The topology filter asks the map where a pane is, so a record that names no tab or
    workspace is placed by the map rather than guessed at.
    """
    panes: list[dict] = []
    for section in ("panes", "agents"):
        for record in document.get(section) or []:
            if isinstance(record, dict):
                panes.append(record)
    if not any(record.get("tab_id") for record in panes):
        panes.append({"pane_id": "w1A:p1", "tab_id": "w1A:t1", "workspace_id": "w1A"})
    return admission_mod.build_map(policy=guard.Policy(), panes=panes,
                                   topology_revision="test")

SESSION_A = "aaaaaaaa-0000-4000-8000-000000000001"
SESSION_B = "bbbbbbbb-0000-4000-8000-000000000002"

BOOT = "11111111-2222-3333-4444-555555555555"
INC_A = f"{BOOT}:4001:900001"
INC_B = f"{BOOT}:4002:900002"   # a later incarnation: same boot, later start ticks
INC_OLD = f"{BOOT}:4000:900000"  # an earlier incarnation
INC_OTHER_BOOT = "99999999-8888-7777-6666-555555555555:5000:100"
INC_OLD_BOOT = "88888888-7777-6666-5555-444444444444:4000:100"


def state(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "model_id": "acme-fast-1",
        "model_provider": "acme",
        "thinking_level": "medium",
        "idle": True,
        "pending_messages": False,
        "context_tokens": 1234,
        "context_window": 200000,
        "context_percent": 0.62,
        "session_file": "/tmp/session.jsonl",
        "leaf_entry_id": "entry-7",
        "cwd": "/tmp/lane",
        "herdr_env": "1",
        "herdr_socket_path": "/run/herdr.sock",
        "herdr_pane_id": "w1A:p1",
        "system_prompt_length": 1234,
        "system_prompt_sha256": "0123456789abcdef",
    }
    base.update(overrides)
    return base


def build_admission(panes: dict[str, tuple[str, str]] | None = None) -> admission_mod.AdmissionMap:
    """An admission map over a small synthetic topology.

    ``panes`` maps a pane id to ``(tab id, workspace id)``.
    """
    records = []
    for pane_id, (tab_id, workspace_id) in (panes or {
        "w1A:p1": ("w1A:t1", "w1A"),
        "w1B:p1": ("w1B:t1", "w1B"),
        "w2:p1": ("w2:t1", "w2"),
        "wE:t19": ("w1C:t1", "w1C"),
        "wE:p99": ("wE:t19", "wE"),
    }).items():
        records.append({"pane_id": pane_id, "tab_id": tab_id, "workspace_id": workspace_id})
    return admission_mod.build_map(policy=guard.Policy(), panes=records,
                                   topology_revision="test-revision")


class CacheTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name
        self.db_path = os.path.join(self.tmp, "state", "behold.db")
        self.cache = cache_mod.Cache(self.db_path)
        self.admission = build_admission()
        self.addCleanup(self._tmp.cleanup)
        self.addCleanup(self.cache.close)


class TestSchema(CacheTestCase):
    def test_tables_and_version_are_explicit(self) -> None:
        conn = self.cache.connect()
        tables = {row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'")}
        self.assertEqual({"cache_meta", "pi_state_current", "pi_state_history",
                          "herdr_snapshot_current"}, tables - {"sqlite_sequence"})
        meta = self.cache.meta()
        self.assertEqual(meta["schema_version"], str(cache_mod.SCHEMA_VERSION))
        user_version = int(conn.execute("PRAGMA user_version").fetchone()[0])
        self.assertEqual(user_version, cache_mod.SCHEMA_VERSION)

    def test_pragmas_are_the_documented_ones(self) -> None:
        conn = self.cache.connect()
        self.assertEqual(str(conn.execute("PRAGMA journal_mode").fetchone()[0]).lower(), "wal")
        self.assertEqual(int(conn.execute("PRAGMA busy_timeout").fetchone()[0]),
                         cache_mod.BUSY_TIMEOUT_MS)
        # synchronous=NORMAL is 1
        self.assertEqual(int(conn.execute("PRAGMA synchronous").fetchone()[0]), 1)

    def test_a_foreign_schema_version_is_refused_not_migrated(self) -> None:
        self.cache.connect()
        self.cache.close()
        conn = sqlite3.connect(self.db_path)
        conn.execute("UPDATE cache_meta SET value = '99' WHERE key = 'schema_version'")
        conn.execute("PRAGMA user_version = 99")
        conn.commit()
        conn.close()
        other = cache_mod.Cache(self.db_path)
        self.addCleanup(other.close)
        with self.assertRaises(cache_mod.CacheError) as ctx:
            other.connect()
        self.assertIn("schema mismatch", str(ctx.exception))

    def test_a_version_1_database_is_migrated_in_place(self) -> None:
        # A version 1 database: keyed by (pane, session), no incarnation, two sessions
        # for one pane. The migration keeps ONE current row per pane and retires the rest.
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        conn = sqlite3.connect(self.db_path)
        conn.execute("""CREATE TABLE cache_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)""")
        conn.execute("""CREATE TABLE pi_state_current (
               pane_id TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
               observed_at TEXT NOT NULL, observed_at_epoch REAL NOT NULL,
               state_json TEXT NOT NULL, sha256 TEXT NOT NULL, writer TEXT NOT NULL,
               PRIMARY KEY (pane_id, session_id))""")
        conn.execute("""CREATE TABLE herdr_snapshot_current (
               id INTEGER PRIMARY KEY CHECK (id = 1), protocol INTEGER NOT NULL,
               seq INTEGER NOT NULL, observed_at TEXT NOT NULL,
               observed_at_epoch REAL NOT NULL, payload_json TEXT NOT NULL,
               sha256 TEXT NOT NULL, source TEXT NOT NULL)""")
        conn.execute("INSERT INTO cache_meta(key, value) VALUES ('schema_version', '1')")
        for session, seq, epoch in ((SESSION_A, 10, 1000.0), (SESSION_B, 11, 2000.0)):
            conn.execute(
                "INSERT INTO pi_state_current VALUES (?,?,?,?,?,?,?,?)",
                ("w1A:p1", session, seq, "2026-11-12T00:00:00Z", epoch,
                 json.dumps({"model_id": f"model-{seq}"}), "digest", "pi-extension"))
        conn.execute("PRAGMA user_version = 1")
        conn.commit()
        conn.close()

        migrated = cache_mod.Cache(self.db_path)
        self.addCleanup(migrated.close)
        migrated.connect()
        self.assertEqual(migrated.meta()["schema_version"], "2")
        self.assertEqual(migrated.meta()["migrated_from"], "1")
        conn = migrated.connect()
        self.assertEqual(int(conn.execute("PRAGMA user_version").fetchone()[0]), 2)
        rows = conn.execute("SELECT pane_id, session_id FROM pi_state_current").fetchall()
        self.assertEqual([(r["pane_id"], r["session_id"]) for r in rows],
                         [("w1A:p1", SESSION_B)])  # the newest observation survives
        history = conn.execute("SELECT session_id FROM pi_state_history").fetchall()
        self.assertEqual([r["session_id"] for r in history], [SESSION_A])
        # the migrated row has no incarnation, so it cannot refuse a real observation
        outcome = migrated.upsert_pi_state(
            pane_id="w1A:p1", session_id=SESSION_A, seq=1,
            observed_at="2026-11-12T00:00:00Z", observed_at_epoch=time.time(),
            state=state(), writer="pi-extension", incarnation=INC_A, boot_id=BOOT,
            start_ticks=900001, boot_epoch=5000.0)
        self.assertEqual(outcome["status"], "written")

    def test_default_path_and_environment_override(self) -> None:
        original = os.environ.get(cache_mod.CACHE_PATH_ENV)
        try:
            os.environ.pop(cache_mod.CACHE_PATH_ENV, None)
            self.assertEqual(cache_mod.default_db_path(),
                             os.path.abspath(os.path.expanduser(
                                 "~/.local/state/behold/behold.db")))
            os.environ[cache_mod.CACHE_PATH_ENV] = "/tmp/somewhere/other.db"
            self.assertEqual(cache_mod.default_db_path(), "/tmp/somewhere/other.db")
        finally:
            if original is None:
                os.environ.pop(cache_mod.CACHE_PATH_ENV, None)
            else:
                os.environ[cache_mod.CACHE_PATH_ENV] = original

    def test_inbox_directory_beside_the_database(self) -> None:
        self.assertEqual(cache_mod.inbox_dir_for("/tmp/x/behold.db"), "/tmp/x/inbox")

    def test_the_spool_name_round_trips(self) -> None:
        for pane in ("w1A:p1", "w2:p1", "wE:p99"):
            name = cache_mod.spool_file_name(pane)
            self.assertEqual(cache_mod.pane_id_from_spool_name(name), pane)
        # the tab travels with the name, so a reserved tab can be refused before the open
        name = cache_mod.spool_file_name("wE:p99", "wE:t19")
        self.assertEqual(cache_mod.pane_and_tab_from_spool_name(name), ("wE:p99", "wE:t19"))
        self.assertEqual(cache_mod.pane_id_from_spool_name(name), "wE:p99")
        self.assertIsNone(cache_mod.pane_id_from_spool_name("random.json"))
        self.assertIsNone(cache_mod.pane_id_from_spool_name("pane-.json"))

    def test_the_admission_map_is_written_and_read(self) -> None:
        path = cache_mod.write_deny_file(self.db_path, self.admission)
        self.assertEqual(path, cache_mod.deny_file_path(self.db_path))
        published = cache_mod.read_deny_file(path)
        self.assertEqual(published.version, cache_mod.DENY_FILE_VERSION)
        self.assertIn("w2", published.denied_workspaces)
        self.assertIn("wE:t19", published.reserved_panes)
        self.assertIn("wE:t19", published.reserved_tabs)
        # the placement of the admitted lanes is published...
        self.assertEqual(published.pane_tab["w1A:p1"], "w1A:t1")
        # ...and the placement of the refused ones is not: the deny lists are enough
        # for both sides to refuse them.
        self.assertNotIn("w2:p1", published.pane_tab)
        self.assertNotIn("wE:p99", published.pane_tab)
        self.assertNotIn("wE:p99", published.pane_workspace)

    def test_a_missing_foreign_or_stale_admission_map_is_refused(self) -> None:
        # Fail closed: "I could not establish admission" is not "admit".
        with self.assertRaises(admission_mod.AdmissionError):
            cache_mod.read_deny_file("/tmp/definitely-not-here.json")
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "foreign.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"version": 99, "denied_workspaces": ["w2"]}, fh)
            with self.assertRaises(admission_mod.AdmissionError):
                cache_mod.read_deny_file(path)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("{not json")
            with self.assertRaises(admission_mod.AdmissionError):
                cache_mod.read_deny_file(path)
            # a stale map is refused too
            stale = admission_mod.AdmissionMap(
                captured_at="2026-11-12T00:00:00Z", captured_at_epoch=1.0,
                topology_revision="x")
            path = os.path.join(tmp, "stale.json")
            admission_mod.publish(path, stale)
            with self.assertRaises(admission_mod.AdmissionError) as ctx:
                cache_mod.read_deny_file(path)
            self.assertIn("stale", str(ctx.exception))

    def test_a_symlinked_cache_path_is_refused(self) -> None:
        # A symlink at the cache path could point at a fleet store, and the write scope
        # would then allow a write into that store. The cache path is Behold's own file.
        target = os.path.join(self.tmp, "elsewhere.db")
        with open(target, "w", encoding="utf-8") as fh:
            fh.write("not a database")
        link = os.path.join(self.tmp, "linked.db")
        os.symlink(target, link)
        other = cache_mod.Cache(link)
        self.addCleanup(other.close)
        with self.assertRaises(cache_mod.CacheError) as ctx:
            other.connect()
        self.assertIn("symlink", str(ctx.exception))
        # and the target was not touched
        with open(target, "r", encoding="utf-8") as fh:
            self.assertEqual(fh.read(), "not a database")


class TestOwnership(CacheTestCase):
    """The incarnation owns the pane; the clock never decides."""

    def _write(self, seq: int = 10, session: str = SESSION_A, *,
               incarnation: str = INC_A, boot_id: str = BOOT, start_ticks: int = 900001,
               boot_epoch: float = 5000.0, pane_id: str = "w1A:p1",
               observed_at_epoch: float | None = None, **overrides: object) -> dict:
        observed = time.time() if observed_at_epoch is None else observed_at_epoch
        return self.cache.upsert_pi_state(
            pane_id=pane_id, session_id=session, seq=seq,
            observed_at="2026-11-12T00:00:00Z",
            observed_at_epoch=observed, state=state(**overrides), writer="pi-extension",
            incarnation=incarnation, boot_id=boot_id, start_ticks=start_ticks,
            boot_epoch=boot_epoch)

    def test_round_trip(self) -> None:
        outcome = self._write()
        self.assertEqual(outcome["status"], "written")
        read = self.cache.read_pi_state("w1A:p1", session_id=SESSION_A)
        self.assertEqual(read.state, cache_mod.FRESH)
        self.assertEqual(read.value["model_id"], "acme-fast-1")
        self.assertEqual(read.seq, 10)
        self.assertEqual(read.session_id, SESSION_A)
        self.assertEqual(read.sha256, outcome["sha256"])
        self.assertEqual(read.incarnation, INC_A)
        # the digest is over the canonical state
        self.assertEqual(read.sha256, cache_mod.digest_of(read.value))

    def test_a_older_sequence_number_is_refused(self) -> None:
        self._write(seq=10)
        outcome = self._write(seq=9)
        self.assertEqual(outcome["status"], "stale_rejected")
        self.assertEqual(outcome["reason"], "seq_not_newer")
        # the stored row is untouched
        read = self.cache.read_pi_state("w1A:p1", session_id=SESSION_A)
        self.assertEqual(read.seq, 10)

    def test_the_same_sequence_number_is_refused(self) -> None:
        self._write(seq=10)
        outcome = self._write(seq=10)
        self.assertEqual(outcome["status"], "stale_rejected")

    def test_a_newer_sequence_number_wins(self) -> None:
        self._write(seq=10)
        outcome = self._write(seq=11, model_id="acme-large-1")
        self.assertEqual(outcome["status"], "written")
        read = self.cache.read_pi_state("w1A:p1", session_id=SESSION_A)
        self.assertEqual(read.value["model_id"], "acme-large-1")
        self.assertEqual(read.seq, 11)

    def test_a_restart_with_a_reset_counter_takes_the_pane_over(self) -> None:
        # A new process starts its sequence at 1 again. It started later, so it owns the
        # pane -- a reset counter must not freeze the observation.
        self._write(seq=40, incarnation=INC_A, start_ticks=900001)
        outcome = self._write(seq=1, incarnation=INC_B, start_ticks=900002,
                              model_id="acme-large-1")
        self.assertEqual(outcome["status"], "written")
        self.assertEqual(outcome["reason"], "new_incarnation")
        read = self.cache.read_pi_state("w1A:p1", session_id=SESSION_A)
        self.assertEqual(read.value["model_id"], "acme-large-1")
        self.assertEqual(read.incarnation, INC_B)

    def test_an_old_reporter_writing_late_is_refused(self) -> None:
        # The late writer started EARLIER: it may not take the pane back.
        self._write(seq=1, incarnation=INC_B, start_ticks=900002, model_id="new-model")
        outcome = self._write(seq=99, incarnation=INC_OLD, start_ticks=900000,
                              model_id="old-model")
        self.assertEqual(outcome["status"], "stale_incarnation")
        self.assertEqual(outcome["reason"], "older_incarnation")
        read = self.cache.read_pi_state("w1A:p1", session_id=SESSION_A)
        self.assertEqual(read.value["model_id"], "new-model")
        self.assertEqual(read.incarnation, INC_B)

    def test_a_record_from_another_boot_is_ordered_by_the_boot_epoch(self) -> None:
        self._write(seq=5, incarnation=INC_A, boot_epoch=5000.0)
        # an EARLIER boot is refused
        outcome = self._write(seq=6, incarnation=INC_OLD_BOOT,
                              boot_id=INC_OLD_BOOT.split(":")[0], start_ticks=100,
                              boot_epoch=5000.0 - 3600.0)
        self.assertEqual(outcome["status"], "stale_incarnation")
        self.assertEqual(outcome["reason"], "older_boot")
        # a LATER boot takes over
        outcome = self._write(seq=1, incarnation=INC_OTHER_BOOT,
                              boot_id=INC_OTHER_BOOT.split(":")[0], start_ticks=100,
                              boot_epoch=5000.0 + 3600.0)
        self.assertEqual(outcome["status"], "written")
        self.assertEqual(outcome["reason"], "new_boot")
        read = self.cache.read_pi_state("w1A:p1", session_id=SESSION_A)
        self.assertEqual(read.incarnation, INC_OTHER_BOOT)

    def test_an_unorderable_record_is_refused_not_guessed(self) -> None:
        # Two boot epochs too close to order: the record is refused.
        self._write(seq=5, incarnation=INC_A, boot_epoch=5000.0)
        outcome = self._write(seq=6, incarnation=INC_OTHER_BOOT,
                              boot_id=INC_OTHER_BOOT.split(":")[0], start_ticks=100,
                              boot_epoch=5000.0 + 5.0)
        self.assertEqual(outcome["status"], "ambiguous_incarnation")
        self.assertEqual(outcome["reason"], "ambiguous_boot_order")
        read = self.cache.read_pi_state("w1A:p1", session_id=SESSION_A)
        self.assertEqual(read.incarnation, INC_A)

    def test_a_backwards_clock_step_does_not_freeze_the_observation(self) -> None:
        # The wall clock steps back an hour between two writes. The ordering is by
        # incarnation and sequence, so the second write still lands -- the observation is
        # not frozen at the value the clock would have refused.
        now = time.time()
        self._write(seq=1, observed_at_epoch=now, mono_epoch=now, model_id="first")
        stepped = now - 3600.0
        outcome = self._write(seq=2, observed_at_epoch=stepped, mono_epoch=stepped + 3600.0,
                              model_id="second")
        self.assertEqual(outcome["status"], "written")
        read = self.cache.read_pi_state("w1A:p1", session_id=SESSION_A, now=now)
        self.assertEqual(read.value["model_id"], "second")
        self.assertEqual(read.seq, 2)
        # and the age is judged by the clock, which says the observation is an hour old
        self.assertEqual(read.state, cache_mod.STALE)

    def test_an_observation_dated_in_the_future_is_disputed(self) -> None:
        # The reader's clock is behind the observation's: its age is unknown, so it is
        # neither fresh nor stale.
        now = time.time()
        self._write(seq=1, observed_at_epoch=now + 120, mono_epoch=now + 120)
        read = self.cache.read_pi_state("w1A:p1", session_id=SESSION_A, now=now)
        self.assertEqual(read.state, cache_mod.CLOCK_DISPUTED)
        self.assertIn("future", read.reason or "")

    def test_identity_mismatch_is_reported_not_returned(self) -> None:
        self._write(seq=10, session=SESSION_A)
        read = self.cache.read_pi_state("w1A:p1", session_id=SESSION_B)
        self.assertEqual(read.state, cache_mod.IDENTITY_MISMATCH)
        self.assertIsNone(read.value)
        self.assertIn(SESSION_A, read.reason or "")

    def test_absent_is_typed(self) -> None:
        read = self.cache.read_pi_state("w1Z:p9", session_id=SESSION_A)
        self.assertEqual(read.state, cache_mod.ABSENT)
        self.assertIsNone(read.value)

    def test_two_sessions_for_one_pane_leave_one_row_and_one_history_row(self) -> None:
        self._write(seq=10, session=SESSION_A)
        self._write(seq=11, session=SESSION_B)
        rows = self.cache.pi_state_freshness()
        self.assertEqual(rows["rows"], 1)
        self.assertEqual(rows["panes"], 1)
        self.assertEqual(rows["history_rows"], 1)

    def test_the_history_is_bounded(self) -> None:
        for step in range(cache_mod.HISTORY_ROWS_PER_PANE + 5):
            self._write(seq=step + 1, incarnation=INC_A, start_ticks=900001 + step)
        rows = self.cache.pi_state_freshness()
        self.assertEqual(rows["rows"], 1)
        self.assertEqual(rows["history_rows"], cache_mod.HISTORY_ROWS_PER_PANE)


class TestFreshness(CacheTestCase):
    def test_old_value_is_stale_not_wrong(self) -> None:
        now = time.time()
        self.cache.upsert_pi_state(
            pane_id="w1A:p1", session_id=SESSION_A, seq=1,
            observed_at="2026-11-12T00:00:00Z", observed_at_epoch=now - 3600,
            state=state(), writer="pi-extension", incarnation=INC_A, boot_id=BOOT,
            start_ticks=900001, boot_epoch=5000.0)
        read = self.cache.read_pi_state("w1A:p1", session_id=SESSION_A, now=now)
        self.assertEqual(read.state, cache_mod.STALE)
        self.assertIsNotNone(read.value)
        self.assertIn("freshness window", read.reason or "")

    def test_freshness_window_is_configurable(self) -> None:
        now = time.time()
        self.cache.upsert_pi_state(
            pane_id="w1A:p1", session_id=SESSION_A, seq=1,
            observed_at="2026-11-12T00:00:00Z", observed_at_epoch=now - 10,
            state=state(), writer="pi-extension", incarnation=INC_A, boot_id=BOOT,
            start_ticks=900001, boot_epoch=5000.0)
        self.assertEqual(
            self.cache.read_pi_state("w1A:p1", session_id=SESSION_A, now=now,
                                     freshness_s=5).state,
            cache_mod.STALE)
        self.assertEqual(
            self.cache.read_pi_state("w1A:p1", session_id=SESSION_A, now=now,
                                     freshness_s=60).state,
            cache_mod.FRESH)

    def test_a_future_dated_observation_is_disputed_not_fresh(self) -> None:
        now = time.time()
        self.cache.upsert_pi_state(
            pane_id="w1A:p1", session_id=SESSION_A, seq=1,
            observed_at="2026-11-12T00:00:00Z", observed_at_epoch=now + 120,
            state=state(), writer="pi-extension", incarnation=INC_A, boot_id=BOOT,
            start_ticks=900001, boot_epoch=5000.0)
        read = self.cache.read_pi_state("w1A:p1", session_id=SESSION_A, now=now)
        self.assertEqual(read.state, cache_mod.CLOCK_DISPUTED)
        self.assertIn("future", read.reason or "")

    def test_a_clock_skewed_observation_is_disputed(self) -> None:
        # The reporter's wall clock and its monotone clock disagree: the clock moved.
        now = time.time()
        self.cache.upsert_pi_state(
            pane_id="w1A:p1", session_id=SESSION_A, seq=1,
            observed_at="2026-11-12T00:00:00Z", observed_at_epoch=now,
            mono_epoch=now + 3600.0,
            state=state(), writer="pi-extension", incarnation=INC_A, boot_id=BOOT,
            start_ticks=900001, boot_epoch=5000.0)
        read = self.cache.read_pi_state("w1A:p1", session_id=SESSION_A, now=now)
        self.assertEqual(read.state, cache_mod.CLOCK_DISPUTED)
        self.assertIn("clock moved", read.reason or "")
        self.assertAlmostEqual(read.clock_skew_s or 0.0, 3600.0, places=3)

    def test_the_vocabulary_is_closed(self) -> None:
        self.assertEqual(set(cache_mod.FRESHNESS_STATES),
                         {"fresh", "stale", "absent", "identity_mismatch", "unreadable",
                          "clock_disputed"})


class TestConcurrency(CacheTestCase):
    def test_concurrent_writers_all_land(self) -> None:
        writers = 8
        per_writer = 12
        errors: list[BaseException] = []

        def worker(index: int) -> None:
            other = cache_mod.Cache(self.db_path)
            try:
                for step in range(per_writer):
                    other.upsert_pi_state(
                        pane_id=f"w1{index}:p1",
                        session_id=f"{index:08x}-0000-4000-8000-{step:012d}",
                        seq=step + 1,
                        observed_at="2026-11-12T00:00:00Z", observed_at_epoch=time.time(),
                        state=state(), writer="pi-extension",
                        incarnation=f"{BOOT}:{5000 + index}:{900000 + index}",
                        boot_id=BOOT, start_ticks=900000 + index, boot_epoch=5000.0)
            except BaseException as exc:  # noqa: BLE001 - the test reports it
                errors.append(exc)
            finally:
                other.close()

        threads = [threading.Thread(target=worker, args=(index,)) for index in range(writers)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=120)
        self.assertEqual(errors, [], f"concurrent writers failed: {errors[:3]}")
        rows = self.cache.pi_state_freshness()["rows"]
        # one current row per pane, however many writes landed
        self.assertEqual(rows, writers)


class TestPrivacy(CacheTestCase):
    def test_unknown_keys_are_dropped(self) -> None:
        clean = cache_mod.sanitize_state({
            "model_id": "acme-fast-1",
            "prompt": "SENTINEL_PROMPT_BODY",
            "messages": [{"role": "user", "content": "SENTINEL_SESSION_MESSAGE"}],
            "tool_arguments": {"command": "SENTINEL_TOOL_ARGUMENTS"},
            "api_key": "SENTINEL_API_KEY",
            "skills": ["SENTINEL_SKILL_BODY"],
            "rooms": ["SENTINEL_ROOM_BODY"],
            "bead_notes": "SENTINEL_BEAD_NOTES",
        })
        self.assertEqual(set(clean), {"model_id"})
        blob = json.dumps(clean)
        for sentinel in ("SENTINEL_PROMPT_BODY", "SENTINEL_SESSION_MESSAGE",
                         "SENTINEL_TOOL_ARGUMENTS", "SENTINEL_API_KEY",
                         "SENTINEL_SKILL_BODY", "SENTINEL_ROOM_BODY", "SENTINEL_BEAD_NOTES"):
            self.assertNotIn(sentinel, blob)

    def test_a_forbidden_payload_never_reaches_the_database(self) -> None:
        self.cache.upsert_pi_state(
            pane_id="w1A:p1", session_id=SESSION_A, seq=1,
            observed_at="2026-11-12T00:00:00Z", observed_at_epoch=time.time(),
            state={"model_id": "acme-fast-1", "prompt": "SENTINEL_PROMPT_BODY",
                   "messages": ["SENTINEL_SESSION_MESSAGE"]},
            writer="pi-extension", incarnation=INC_A, boot_id=BOOT, start_ticks=900001,
            boot_epoch=5000.0)
        row = self.cache.connect().execute(
            "SELECT state_json FROM pi_state_current WHERE pane_id = 'w1A:p1'").fetchone()
        self.assertNotIn("SENTINEL", row["state_json"])
        self.assertNotIn("prompt", row["state_json"])
        self.assertIn("model_id", row["state_json"])

    def test_wrong_types_are_dropped_not_coerced(self) -> None:
        clean = cache_mod.sanitize_state({
            "context_tokens": "many",        # a string is not a token count
            "idle": 1,                       # a number is not a boolean
            "context_percent": 12.5,
            "model_id": 42,                  # a number is not a model id
        })
        self.assertEqual(clean, {"context_percent": 12.5})

    def test_booleans_are_not_integers(self) -> None:
        # True is an int in Python; a boolean that arrived as a token count is a bug.
        clean = cache_mod.sanitize_state({"context_tokens": True, "idle": True})
        self.assertEqual(clean, {"idle": True})

    def test_topology_sanitizer_keeps_only_the_allowlist(self) -> None:
        document = {
            "protocol": 22,
            "agents": [{
                "pane_id": "w1A:p1", "workspace_id": "w1A", "tab_id": "w1A:t1",
                "agent": "pi", "name": "alpha", "cwd": "/tmp", "agent_status": "idle",
                "secret_prompt": "SENTINEL_PROMPT_BODY",
                "terminal_title": "pi --session /tmp/x SENTINEL_TOOL_ARGUMENTS",
            }],
            "panes": [{"pane_id": "w1A:p1", "agent_status": "idle"}],
            "workspaces": [{"workspace_id": "w1A", "label": "alpha"}],
            "tabs": [{"tab_id": "w1A:t1", "label": "alpha"}],
            "layouts": [{"anything": "SENTINEL_PROMPT_BODY"}],
        }
        clean = cache_mod.sanitize_topology(document, policy=guard.Policy(),
                                            admission=_map_for(document))
        blob = json.dumps(clean)
        self.assertNotIn("SENTINEL", blob)
        self.assertNotIn("secret_prompt", blob)
        self.assertNotIn("terminal_title\"", blob)
        self.assertEqual(clean["agents"][0]["pane_id"], "w1A:p1")
        self.assertNotIn("layouts", clean)

    def test_topology_keeps_the_paths_the_roster_already_prints(self) -> None:
        document = {
            "protocol": 22,
            "agents": [{
                "pane_id": "w1A:p1",
                "agent_session": {"value": "/tmp/sessions/x.jsonl", "reporter_pid": 42,
                                  "seq": 3},
            }],
            "workspaces": [{
                "workspace_id": "w1A",
                "worktree": {"checkout_path": "/repo", "repo_name": "alpha",
                             "is_linked_worktree": False, "repo_root": "/repo",
                             "repo_key": "/repo/.git"},
                "tokens": {"jj_bookmark": {"value": "tok", "expires_at": "2026-11-11T03:00:00Z"}},
            }],
        }
        clean = cache_mod.sanitize_topology(document, policy=guard.Policy(),
                                            admission=_map_for(document))
        self.assertEqual(clean["agents"][0]["agent_session"]["value"], "/tmp/sessions/x.jsonl")
        self.assertEqual(clean["agents"][0]["agent_session"]["reporter_pid"], 42)
        self.assertEqual(clean["workspaces"][0]["worktree"]["repo_name"], "alpha")
        self.assertEqual(clean["workspaces"][0]["tokens"]["jj_bookmark"]["value"], "tok")


class TestIngest(CacheTestCase):
    def _record(self, pane_id: str = "w1A:p1", **overrides: object) -> dict:
        record = {
            "behold_state": cache_mod.STATE_RECORD_VERSION,
            "pane_id": pane_id,
            "tab_id": "w1A:t1",
            "session_id": SESSION_A,
            "incarnation": INC_A,
            "boot_id": BOOT,
            "incarnation_start_ticks": 900001,
            "incarnation_boot_epoch": 5000.0,
            "seq": 42,
            "observed_at": "2026-11-12T00:00:00Z",
            "observed_at_epoch": time.time(),
            "mono_epoch": time.time(),
            "state": state(),
            "writer": "pi-extension",
        }
        record.update(overrides)
        return record

    def _spool(self, record: dict, name: str | None = None) -> str:
        inbox = cache_mod.inbox_dir_for(self.db_path)
        os.makedirs(inbox, exist_ok=True)
        path = os.path.join(inbox, name or cache_mod.spool_file_name(
            record["pane_id"], record.get("tab_id")))
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(record, fh)
        return path

    def test_a_valid_record_is_applied(self) -> None:
        self._spool(self._record())
        result = self.cache.ingest_inbox(admission_map=self.admission)
        self.assertEqual(result["written"], 1)
        self.assertEqual(result["skipped_malformed"], 0)
        read = self.cache.read_pi_state("w1A:p1", session_id=SESSION_A)
        self.assertEqual(read.state, cache_mod.FRESH)
        self.assertEqual(read.value["model_id"], "acme-fast-1")
        self.assertEqual(read.incarnation, INC_A)

    def test_without_an_admission_map_nothing_is_opened(self) -> None:
        # Fail closed: with no map the ingester cannot tell a refused lane from an
        # admitted one, so it opens nothing.
        self._spool(self._record())
        result = self.cache.ingest_inbox()
        self.assertEqual(result["written"], 0)
        self.assertEqual(result["skipped_admission"], 1)
        self.assertEqual(self.cache.pi_state_freshness()["rows"], 0)

    def test_a_record_in_a_foreign_file_is_skipped(self) -> None:
        # The file name carries the pane id: a file named for another lane cannot inject
        # a row for this one.
        self._spool(self._record(), name=cache_mod.spool_file_name("w1B:p1", "w1B:t1"))
        result = self.cache.ingest_inbox(admission_map=self.admission)
        self.assertEqual(result["written"], 0)
        self.assertEqual(result["skipped_identity"], 1)
        self.assertEqual(self.cache.pi_state_freshness()["rows"], 0)

    def test_a_record_for_a_pane_the_topology_does_not_know_is_refused(self) -> None:
        # The admission map is the authority: a pane it does not know is refused before
        # the file is opened.
        self._spool(self._record(pane_id="w1Z:p9"),
                    name=cache_mod.spool_file_name("w1Z:p9", "w1Z:t9"))
        result = self.cache.ingest_inbox(admission_map=self.admission)
        self.assertEqual(result["written"], 0)
        self.assertEqual(result["skipped_unknown"], 1)
        self.assertEqual(self.cache.pi_state_freshness()["rows"], 0)

    def test_a_malformed_file_is_skipped_and_the_others_still_land(self) -> None:
        inbox = cache_mod.inbox_dir_for(self.db_path)
        os.makedirs(inbox, exist_ok=True)
        # a lane-named file with broken content: it is a lane record, and it is malformed
        with open(os.path.join(inbox, cache_mod.spool_file_name("w1B:p1", "w1B:t1")), "w",
                  encoding="utf-8") as fh:
            fh.write("{not json")
        self._spool(self._record())
        result = self.cache.ingest_inbox(admission_map=self.admission)
        self.assertEqual(result["written"], 1)
        self.assertEqual(result["skipped_malformed"], 1)

    def test_an_unknown_record_version_is_skipped(self) -> None:
        self._spool(self._record(behold_state=99))
        result = self.cache.ingest_inbox(admission_map=self.admission)
        self.assertEqual(result["written"], 0)
        self.assertEqual(result["skipped_version"], 1)

    def test_a_record_without_an_incarnation_is_refused(self) -> None:
        # Without an incarnation there is no ordering and no ownership: refused.
        record = self._record()
        record.pop("incarnation")
        self._spool(record)
        result = self.cache.ingest_inbox(admission_map=self.admission)
        self.assertEqual(result["written"], 0)
        self.assertEqual(result["skipped_malformed"], 1)

    def test_an_older_record_does_not_overwrite_a_newer_one(self) -> None:
        self._spool(self._record(seq=50))
        self.cache.ingest_inbox(admission_map=self.admission)
        self._spool(self._record(seq=49))
        result = self.cache.ingest_inbox(admission_map=self.admission)
        self.assertEqual(result["stale_rejected"], 1)
        read = self.cache.read_pi_state("w1A:p1", session_id=SESSION_A)
        self.assertEqual(read.seq, 50)

    def test_the_ingest_writes_nothing_but_the_database(self) -> None:
        self._spool(self._record())
        self.cache.ingest_inbox(admission_map=self.admission)
        state_dir = os.path.dirname(self.db_path)
        # the database and its WAL sidecars, and the inbox. Nothing else.
        self.assertTrue(set(os.listdir(state_dir)).issubset(
            {"behold.db", "behold.db-wal", "behold.db-shm", "behold.db-journal", "inbox"}),
            sorted(os.listdir(state_dir)))


class TestObservationGaps(CacheTestCase):
    def test_the_api_gaps_are_always_reported(self) -> None:
        gaps = cache_mod.observation_gaps({"model_id": "acme-fast-1"})
        by_field = {gap["field"]: gap for gap in gaps}
        self.assertEqual(by_field["agent_status"]["kind"], "not_available")
        self.assertIn("isIdle", by_field["agent_status"]["reason"])
        self.assertIn("ttft_ms", by_field)

    def test_a_field_the_reporter_did_not_send_is_not_observed(self) -> None:
        gaps = cache_mod.observation_gaps({"model_id": "acme-fast-1"})
        by_field = {gap["field"]: gap for gap in gaps}
        self.assertNotIn("model_id", by_field)
        self.assertEqual(by_field["thinking_level"]["kind"], "not_observed")

    def test_no_gap_is_ever_a_value(self) -> None:
        gaps = cache_mod.observation_gaps({})
        for gap in gaps:
            self.assertEqual(set(gap), {"field", "reason", "kind"})


class TestSummary(CacheTestCase):
    def test_summary_of_a_missing_cache(self) -> None:
        summary = cache_mod.summarize(cache_mod.Cache(self.db_path), mode="auto",
                                      enabled=True)
        self.assertEqual(summary.state, "absent")
        self.assertEqual(summary.writes, "enabled")
        self.assertIn("not disk truth", summary.to_dict()["note"])

    def test_summary_of_a_disabled_cache(self) -> None:
        summary = cache_mod.summarize(None, mode="off", enabled=False)
        self.assertEqual(summary.state, "disabled")
        self.assertEqual(summary.writes, "disabled")


if __name__ == "__main__":
    unittest.main()
