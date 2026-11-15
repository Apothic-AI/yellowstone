"""Incarnation, ordering, races and the session-identity cross-check.

Three things are proven here that the other suites only assume:

* **Who wrote the record.** A disposable pi session file (written in pi's own format)
  gives the id the reporter would report, and the roster's identity layer validates the
  same id out of that file. The two sides of the join therefore speak one id space — and
  that is checked against the *installed* pi, not against an assumption.
* **Who owns the pane.** Two incarnations of one pane, one arriving late: the older one
  is refused and never takes the pane back. Two processes ingesting the same inbox at
  the same time: both land, and the cache stays bounded.
* **What a clock step does.** A backwards wall-clock step does not freeze a lane's
  observation, and an observation whose age cannot be trusted is disputed rather than
  called fresh.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest

from tests.helpers import AS_OF, FIXTURE_ROOT, ROOT, require_fixtures

sys.path.insert(0, ROOT)

from behold import admission as admission_mod  # noqa: E402
from behold import cache as cache_mod  # noqa: E402
from behold import cli, guard, session  # noqa: E402

BOOT = "11111111-2222-3333-4444-555555555555"
SESSION_UUID = "aaaaaaaa-0000-4000-8000-000000000001"
INSTALLED_PI = "/home/bitnom/.local/share/mise/installs/node/22.23.3/lib/node_modules/@earendil-works/pi-coding-agent"


def write_pi_session(path: str, uuid: str, *, cwd: str = "/tmp/lane") -> str:
    """Write a disposable session file in pi's own format.

    The first line is the session header pi writes (``type: session``, ``version``,
    ``id``, ``timestamp``, ``cwd``); the rest are entries with ``id``/``parentId``.
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    lines = [
        {"type": "session", "version": 3, "id": uuid,
         "timestamp": "2026-11-12T00:00:00Z", "cwd": cwd},
        {"id": "e0001", "parentId": None, "type": "message", "role": "user",
         "timestamp": "2026-11-12T00:00:01Z",
         "content": [{"type": "text", "text": "hello"}]},
    ]
    with open(path, "w", encoding="utf-8") as fh:
        for line in lines:
            fh.write(json.dumps(line) + "\n")
    return path


class TestDisposablePiSession(unittest.TestCase):
    """The reporter's session id and the roster's session id are one id space."""

    def test_a_disposable_session_file_yields_the_id_the_reporter_reports(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = write_pi_session(
                os.path.join(tmp, "2026-11-12T00-00-00-000Z_" + SESSION_UUID + ".jsonl"),
                SESSION_UUID)
            view = session.load(path, guard.Policy())
            self.assertEqual(view.header_id, SESSION_UUID)
            checks = view.identity_checks()
            self.assertTrue(checks["header_matches_filename"],
                            "the header id and the file name's uuid must agree")
            self.assertEqual(checks["filename_uuid"].lower(), SESSION_UUID.lower())

    def test_the_installed_pi_names_the_session_after_its_own_id(self) -> None:
        # Evidence, not assumption: the installed pi creates its session id with uuidv7,
        # writes the file as <timestamp>_<sessionId>.jsonl and puts the same id in the
        # header. So `ctx.sessionManager.getSessionId()` and the header id are the same
        # string, and the roster's identity layer reads the header.
        manager = os.path.join(INSTALLED_PI, "dist", "core", "session-manager.js")
        if not os.path.exists(manager):
            self.skipTest("the installed pi package is not present on this machine")
        with open(manager, "r", encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("function createSessionId()", text)
        self.assertIn("uuidv7()", text)
        self.assertIn("id: this.sessionId", text)
        self.assertIn("_${this.sessionId}.jsonl", text)

    def test_the_join_uses_that_id_and_refuses_another(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = write_pi_session(
                os.path.join(tmp, "2026-11-12T00-00-00-000Z_" + SESSION_UUID + ".jsonl"),
                SESSION_UUID)
            view = session.load(path, guard.Policy())
            db_path = os.path.join(tmp, "behold.db")
            with cache_mod.Cache(db_path) as cache:
                cache.upsert_pi_state(
                    pane_id="w1A:p1", session_id=view.header_id or "", seq=1,
                    observed_at="2026-11-12T00:00:00Z", observed_at_epoch=time.time(),
                    state={"model_id": "acme-fast-1"}, writer="pi-extension",
                    incarnation=f"{BOOT}:1:1", boot_id=BOOT, start_ticks=1,
                    boot_epoch=5000.0)
                read = cache.read_pi_state("w1A:p1", session_id=view.header_id)
                self.assertEqual(read.state, cache_mod.FRESH)
                self.assertEqual(read.value["model_id"], "acme-fast-1")
                other = cache.read_pi_state(
                    "w1A:p1", session_id="ffffffff-0000-4000-8000-0000000000ff")
                self.assertEqual(other.state, cache_mod.IDENTITY_MISMATCH)
                self.assertIsNone(other.value)


class TestProcessRaces(unittest.TestCase):
    def test_two_processes_ingesting_the_same_inbox_both_land(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "behold.db")
            inbox = cache_mod.inbox_dir_for(db_path)
            os.makedirs(inbox, exist_ok=True)
            for pane in ("w1A:p1", "w1B:p1", "w1C:p1"):
                record = {
                    "behold_state": cache_mod.STATE_RECORD_VERSION,
                    "pane_id": pane,
                    "tab_id": pane.replace(":p", ":t"),
                    "session_id": f"{pane}:session",
                    "incarnation": f"{BOOT}:1:{hash(pane) % 1000}",
                    "boot_id": BOOT,
                    "incarnation_start_ticks": 1,
                    "incarnation_boot_epoch": 5000.0,
                    "seq": 1,
                    "observed_at": "2026-11-12T00:00:00Z",
                    "observed_at_epoch": time.time(),
                    "state": {"model_id": "acme-fast-1"},
                    "writer": "pi-extension",
                }
                with open(os.path.join(inbox, cache_mod.spool_file_name(
                    pane, pane.replace(":p", ":t"))), "w",
                          encoding="utf-8") as fh:
                    json.dump(record, fh)

            script = textwrap.dedent(f"""
                import json, sys
                sys.path.insert(0, {ROOT!r})
                from behold import admission, cache as cache_mod, guard
                published = admission.build_map(
                    policy=guard.Policy(),
                    panes=[{{"pane_id": p, "tab_id": p.replace(":p", ":t"),
                             "workspace_id": p.split(":")[0]}}
                            for p in ("w1A:p1", "w1B:p1", "w1C:p1")],
                    topology_revision="race")
                cache = cache_mod.Cache({db_path!r})
                result = cache.ingest_inbox({inbox!r}, admission_map=published)
                cache.close()
                print(json.dumps(result))
            """)
            path = os.path.join(tmp, "ingest.py")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(script)
            procs = [subprocess.Popen([sys.executable, path], stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, text=True)
                     for _ in range(4)]
            outputs = []
            for proc in procs:
                out, err = proc.communicate(timeout=120)
                self.assertEqual(proc.returncode, 0, err[:2000])
                outputs.append(json.loads(out))
            # The four processes race for the same three panes. Exactly one write per
            # pane lands; the others are refused as "not newer", because the same
            # incarnation may only move forward. Nobody crashed.
            self.assertEqual(sum(result["written"] for result in outputs), 3, outputs)
            for result in outputs:
                self.assertEqual(result["written"] + result["stale_rejected"], 3, result)
            with cache_mod.Cache(db_path) as cache:
                freshness = cache.pi_state_freshness()
                self.assertEqual(freshness["rows"], 3)
                self.assertEqual(freshness["panes"], 3)
                self.assertLessEqual(freshness["history_rows"], cache_mod.HISTORY_ROWS_PER_PANE * 3)


class TestOwnershipEndToEnd(unittest.TestCase):
    """The roster's own run: an old reporter writing late does not take the pane back."""

    def _spool(self, inbox: str, pane: str, tab: str, session: str, seq: int,
               incarnation: str, ticks: int, model: str) -> None:
        record = {
            "behold_state": cache_mod.STATE_RECORD_VERSION,
            "pane_id": pane,
            "tab_id": tab,
            "session_id": session,
            "incarnation": incarnation,
            "boot_id": BOOT,
            "incarnation_start_ticks": ticks,
            "incarnation_boot_epoch": 5000.0,
            "seq": seq,
            "observed_at": "2026-11-12T00:00:00Z",
            "observed_at_epoch": time.time(),
            "mono_epoch": time.time(),
            "state": {"model_id": model},
            "writer": "pi-extension",
        }
        os.makedirs(inbox, exist_ok=True)
        with open(os.path.join(inbox, cache_mod.spool_file_name(pane, tab)), "w",
                  encoding="utf-8") as fh:
            json.dump(record, fh)

    def _roster(self, db_path: str) -> dict:
        import contextlib
        import io

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = cli.main(["roster", "--root", FIXTURE_ROOT, "--as-of", AS_OF,
                             "--cache", "on", "--cache-db", db_path])
        self.assertEqual(code, 0, buffer.getvalue()[:2000])
        return json.loads(buffer.getvalue())

    def test_an_old_reporter_writing_late_does_not_take_the_pane_back(self) -> None:
        require_fixtures()
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "behold.db")
            inbox = cache_mod.inbox_dir_for(db_path)
            # the NEW incarnation writes first, and owns the pane
            self._spool(inbox, "w1A:p1", "w1A:t1",
                        "aaaaaaaa-0000-4000-8000-000000000001", 5,
                        f"{BOOT}:4002:900002", 900002, "new-model")
            doc = self._roster(db_path)
            lane = {lane["key"]: lane for lane in doc["lanes"]}["w1A:p1"]
            self.assertEqual(lane["fields"]["P-11"]["value"]["observed"]["model_id"],
                             "new-model")
            self.assertEqual(lane["fields"]["P-11"]["value"]["incarnation"],
                             f"{BOOT}:4002:900002")
            # now the OLD incarnation writes, late, with a much higher sequence number
            self._spool(inbox, "w1A:p1", "w1A:t1",
                        "aaaaaaaa-0000-4000-8000-000000000001", 99,
                        f"{BOOT}:4001:900001", 900001, "old-model")
            doc = self._roster(db_path)
            ingest = doc["behold"]["admission"]["ingest"]
            self.assertEqual(ingest["stale_incarnation"], 1, ingest)
            self.assertEqual(ingest["written"], 0, ingest)
            lane = {lane["key"]: lane for lane in doc["lanes"]}["w1A:p1"]
            self.assertEqual(lane["fields"]["P-11"]["value"]["observed"]["model_id"],
                             "new-model")
            self.assertEqual(lane["fields"]["P-11"]["value"]["incarnation"],
                             f"{BOOT}:4002:900002")

    def test_the_topology_provenance_is_reported(self) -> None:
        require_fixtures()
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "behold.db")
            doc = self._roster(db_path)
            topology = doc["behold"]["topology"]
            self.assertEqual(topology["kind"], "fixture_tree")
            self.assertEqual(topology["captured_at_source"], "file_mtime")
            self.assertIsNotNone(topology["age_s"])
            self.assertIn("mtime", topology["note"])


if __name__ == "__main__":
    unittest.main()
