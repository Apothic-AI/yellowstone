"""The cache-to-roster join: the reporter's observation, joined to the right lane.

The reporter (the pi extension) writes one sanitized record per lane; the cache stores
it; the roster joins it back to the lane whose **session** it describes. These tests are
about that join and about the ways it can go wrong:

* the wrong lane (a session that belongs to somebody else) — the value is not returned;
* an old observation — it is reported as stale, never as current;
* a lane the roster refuses (held workspace ``w2``, reserved pane/tab ``wE:t19``) — the
  record is never read, never stored and never shown;
* no observation at all — the field says so instead of being empty;
* a lane whose tab contradicts the topology the roster read — refused, not believed.

The two lanes used for the "distinct values" case carry **different** observations, so a
join that ignored the session id (or joined everything to one lane) cannot pass.
"""

from __future__ import annotations

import builtins
import json
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

from tests.helpers import AS_OF, FIXTURE_ROOT, ROOT, require_fixtures

sys.path.insert(0, ROOT)

from behold import admission as admission_mod  # noqa: E402
from behold import cache as cache_mod  # noqa: E402
from behold import cli, guard  # noqa: E402

#: The fixture lanes' validated session ids (from the pane-matched lane records).
SESSION_ALPHA_LEADER = "aaaaaaaa-0000-4000-8000-000000000001"
SESSION_ALPHA_WORKER = "aaaaaaaa-0000-4000-8000-000000000002"
SESSION_HELD = "aaaaaaaa-0000-4000-8000-000000000004"
SESSION_RESERVED_TAB = "aaaaaaaa-0000-4000-8000-000000000005"

BOOT = "11111111-2222-3333-4444-555555555555"

#: The fixture lanes' tabs, exactly as the fixture topology has them. A record that
#: claims another tab is a mismatch, and is refused.
FIXTURE_TABS = {
    "w1A:p1": "w1A:t1",
    "w1A:p2": "w1A:t2",
    "w2:p1": "w2:t1",
    "wE:t19": "w1C:t1",
    "wE:p99": "wE:t19",
}


def observation(pane_id: str, session_id: str, seq: int, model_id: str,
                age_s: float = 0.0, tab_id: str | None = None,
                incarnation: str | None = None,
                **extra: object) -> dict:
    """A reporter record, exactly as the extension writes it."""
    now = time.time()
    state = {
        "model_id": model_id,
        "model_provider": "acme",
        "thinking_level": "medium",
        "idle": True,
        "pending_messages": False,
        "context_tokens": 4321,
        "context_window": 200000,
        "context_percent": 2.16,
        "session_file": "/tmp/fixture-sessions/x.jsonl",
        "leaf_entry_id": "entry-9",
        "cwd": "/tmp/fixture-lane",
        "herdr_pane_id": pane_id,
        "herdr_workspace_id": pane_id.split(":")[0],
        "herdr_tab_id": tab_id if tab_id is not None else pane_id.split(":")[0] + ":t1",
        "system_prompt_length": 4096,
        "system_prompt_sha256": "0123456789abcdef",
    }
    state.update(extra)
    resolved_tab = tab_id if tab_id is not None else FIXTURE_TABS.get(
        pane_id, pane_id.split(":")[0] + ":t1")
    return {
        "behold_state": cache_mod.STATE_RECORD_VERSION,
        "pane_id": pane_id,
        "tab_id": resolved_tab,
        "session_id": session_id,
        "incarnation": incarnation or f"{BOOT}:4001:900001",
        "boot_id": BOOT,
        "incarnation_start_ticks": 900001,
        "incarnation_boot_epoch": 5000.0,
        "seq": seq,
        "observed_at": "2026-11-12T00:00:00Z",
        "observed_at_epoch": now - age_s,
        "mono_epoch": now - age_s,
        "state": state,
        "writer": "pi-extension",
    }


class JoinTestCase(unittest.TestCase):
    def setUp(self) -> None:
        require_fixtures()
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name
        self.addCleanup(self._tmp.cleanup)
        self.db_path = os.path.join(self.tmp, "state", "behold.db")
        self.inbox = cache_mod.inbox_dir_for(self.db_path)
        os.makedirs(self.inbox, exist_ok=True)

    def spool(self, record: dict, name: str | None = None) -> str:
        path = os.path.join(self.inbox, name or cache_mod.spool_file_name(
            record["pane_id"], record.get("tab_id")))
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(record, fh)
        return path

    def admission_map(self) -> admission_mod.AdmissionMap:
        """The admission map the roster would publish for the fixture topology."""
        return admission_mod.build_map(
            policy=guard.Policy(),
            panes=[
                {"pane_id": "w1A:p1", "tab_id": "w1A:t1", "workspace_id": "w1A"},
                {"pane_id": "w1A:p2", "tab_id": "w1A:t2", "workspace_id": "w1A"},
                {"pane_id": "w2:p1", "tab_id": "w2:t1", "workspace_id": "w2"},
                {"pane_id": "wE:t19", "tab_id": "w1C:t1", "workspace_id": "w1C"},
                {"pane_id": "wE:p99", "tab_id": "wE:t19", "workspace_id": "wE"},
            ],
            topology_revision="fixture")

    def roster(self, *extra: str) -> dict:
        """Run the CLI in-process against the fixture tree and the temp cache."""
        argv = ["roster", "--root", FIXTURE_ROOT, "--as-of", AS_OF,
                "--cache", "on", "--cache-db", self.db_path, *extra]

        import io
        import contextlib

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = cli.main(argv)
        self.assertEqual(code, 0, buffer.getvalue()[:2000])
        return json.loads(buffer.getvalue())


class TestJoin(JoinTestCase):
    def test_two_lanes_carry_their_own_distinct_observation(self) -> None:
        self.spool(observation("w1A:p1", SESSION_ALPHA_LEADER, 10, "reporter-large-1"))
        self.spool(observation("w1A:p2", SESSION_ALPHA_WORKER, 11, "reporter-fast-1"))
        doc = self.roster()
        lanes = {lane["key"]: lane for lane in doc["lanes"]}
        leader = lanes["w1A:p1"]["fields"]["P-11"]
        worker = lanes["w1A:p2"]["fields"]["P-11"]
        self.assertEqual(leader["state"], "present")
        self.assertEqual(worker["state"], "present")
        self.assertEqual(leader["value"]["observed"]["model_id"], "reporter-large-1")
        self.assertEqual(worker["value"]["observed"]["model_id"], "reporter-fast-1")
        self.assertNotEqual(leader["value"]["observed"]["model_id"],
                            worker["value"]["observed"]["model_id"])
        # the freshness travels with the value
        self.assertEqual(leader["value"]["freshness"], "fresh")
        self.assertEqual(leader["value"]["session_match"], "matched")

    def test_the_observation_names_the_incarnation_that_wrote_it(self) -> None:
        self.spool(observation("w1A:p1", SESSION_ALPHA_LEADER, 10, "reporter-large-1",
                               incarnation=f"{BOOT}:4321:999001"))
        doc = self.roster()
        field = {lane["key"]: lane for lane in doc["lanes"]}["w1A:p1"]["fields"]["P-11"]
        self.assertEqual(field["value"]["incarnation"], f"{BOOT}:4321:999001")
        # and it says plainly that this is not a liveness proof
        self.assertIn("not proof that the lane is alive", field["note"])

    def test_the_observation_does_not_replace_the_disk_fields(self) -> None:
        self.spool(observation("w1A:p1", SESSION_ALPHA_LEADER, 10, "reporter-large-1"))
        doc = self.roster()
        lane = {lane["key"]: lane for lane in doc["lanes"]}["w1A:p1"]
        # P-2 is still the disk's model, with the disk's method
        self.assertNotEqual(lane["fields"]["P-2"]["value"]["physical"], "reporter-large-1")
        # and the observation says it is a last observation
        self.assertEqual(lane["fields"]["P-11"]["class"], "last_observed")
        self.assertIn("last observation", lane["fields"]["P-11"]["note"])

    def test_a_stale_observation_is_never_current(self) -> None:
        self.spool(observation("w1A:p1", SESSION_ALPHA_LEADER, 10, "reporter-old",
                               age_s=cache_mod.DEFAULT_FRESHNESS_S * 10))
        doc = self.roster()
        lane = {lane["key"]: lane for lane in doc["lanes"]}["w1A:p1"]
        field = lane["fields"]["P-11"]
        self.assertEqual(field["state"], "stale")
        self.assertNotEqual(field["state"], "present")
        self.assertEqual(field["value"]["freshness"], "stale")
        self.assertGreater(field["value"]["age_s"], cache_mod.DEFAULT_FRESHNESS_S)
        self.assertIn("freshness window", field["reason"])

    def test_an_observation_for_another_session_is_not_returned(self) -> None:
        # The record says it is about a different session of the same pane.
        self.spool(observation("w1A:p1", "ffffffff-0000-4000-8000-0000000000ff", 10,
                               "reporter-wrong-session"))
        doc = self.roster()
        lane = {lane["key"]: lane for lane in doc["lanes"]}["w1A:p1"]
        field = lane["fields"]["P-11"]
        self.assertEqual(field["state"], "unknown")
        self.assertIsNone(field["value"])
        self.assertIn("identity_mismatch", field["reason"])
        self.assertNotIn("reporter-wrong-session", json.dumps(field))

    def test_no_observation_is_absent(self) -> None:
        doc = self.roster()
        lane = {lane["key"]: lane for lane in doc["lanes"]}["w1A:p1"]
        field = lane["fields"]["P-11"]
        self.assertEqual(field["state"], "absent")
        self.assertIsNone(field["value"])
        self.assertIn("no reporter observation", field["reason"])

    def test_the_gaps_are_reported_not_hidden(self) -> None:
        record = observation("w1A:p1", SESSION_ALPHA_LEADER, 10, "reporter-large-1")
        # this record did not carry the leaf id
        del record["state"]["leaf_entry_id"]
        self.spool(record)
        doc = self.roster()
        lane = {lane["key"]: lane for lane in doc["lanes"]}["w1A:p1"]
        gaps = lane["fields"]["P-11"]["value"]["unavailable"]
        by_field = {gap["field"]: gap for gap in gaps}
        # fields pi cannot expose at all
        self.assertIn("agent_status", by_field)
        self.assertEqual(by_field["agent_status"]["kind"], "not_available")
        self.assertIn("ttft_ms", by_field)
        self.assertIn("herdr_socket_path", by_field)
        self.assertIn("room_presence", by_field)
        # and the ones this record did not carry
        self.assertIn("leaf_entry_id", by_field)
        self.assertEqual(by_field["leaf_entry_id"]["kind"], "not_observed")
        # nothing in the gaps is a value
        for gap in gaps:
            self.assertIn("reason", gap)
            self.assertIn("field", gap)

    def test_the_cache_block_reports_the_freshness_tally(self) -> None:
        self.spool(observation("w1A:p1", SESSION_ALPHA_LEADER, 10, "reporter-large-1"))
        self.spool(observation("w1A:p2", SESSION_ALPHA_WORKER, 11, "reporter-fast-1",
                               age_s=cache_mod.DEFAULT_FRESHNESS_S * 10))
        doc = self.roster()
        tally = doc["behold"]["cache"]["pi_state"]["by_state"]
        self.assertEqual(tally["fresh"], 1)
        self.assertEqual(tally["stale"], 1)
        # the summary counts current rows, and says how many retired rows there are
        self.assertEqual(doc["behold"]["cache"]["pi_state"]["rows"], 2)
        self.assertIn("history_rows", doc["behold"]["cache"]["pi_state"])


class TestHeldAndReservedAreExcluded(JoinTestCase):
    def test_the_refused_lanes_never_reach_the_cache(self) -> None:
        # The held workspace, the reserved pane and a lane inside the reserved tab.
        self.spool(observation("w2:p1", SESSION_HELD, 10, "held-model"))
        self.spool(observation("wE:t19", "eeeeeeee-0000-4000-8000-000000000006", 11,
                               "reserved-model"))
        self.spool(observation("wE:p99", SESSION_RESERVED_TAB, 12, "reserved-tab-model",
                               tab_id="wE:t19"))
        self.spool(observation("w1A:p1", SESSION_ALPHA_LEADER, 13, "admitted-model"))
        doc = self.roster()
        lanes = {lane["key"]: lane for lane in doc["lanes"]}
        for key, reason in (("w2:p1", "held_workspace:w2"),
                            ("wE:t19", "reserved_pane:wE:t19"),
                            ("wE:p99", "reserved_tab:wE:t19")):
            field = lanes[key]["fields"]["P-11"]
            self.assertEqual(field["state"], "held", key)
            self.assertIsNone(field["value"], key)
            self.assertIn(reason, field["reason"], key)
            self.assertNotIn("model", json.dumps(lanes[key]["fields"]["P-11"]), key)
        # the admitted lane still has its observation
        self.assertEqual(lanes["w1A:p1"]["fields"]["P-11"]["state"], "present")
        # and the cache holds only the admitted lane's row
        with cache_mod.Cache(self.db_path) as cache:
            self.assertEqual(cache.pi_state_freshness()["rows"], 1)

    def test_a_refused_record_is_never_even_opened(self) -> None:
        # The admission map is applied to the FILE NAME, before the file is read. The
        # files below are written with content that would fail to parse if they were
        # read and parsed -- so "skipped_malformed == 0" proves they were never opened.
        for pane, tab in (("w2:p1", "w2:t1"), ("wE:t19", "w1C:t1"), ("wE:p99", "wE:t19")):
            path = os.path.join(self.inbox, cache_mod.spool_file_name(pane, tab))
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("{ this is not json")
        result = cache_mod.Cache(self.db_path).ingest_inbox(
            self.inbox, admission_map=self.admission_map())
        self.assertEqual(result["skipped_denied"], 3)
        self.assertEqual(result["skipped_malformed"], 0)
        self.assertEqual(result["written"], 0)

    def test_the_reserved_tabs_record_is_never_opened_at_all(self) -> None:
        # The strongest form of the rule: the ingester does not open the file of a lane
        # inside a reserved tab. The file is spied on through builtins.open.
        self.spool(observation("wE:p99", SESSION_RESERVED_TAB, 12, "reserved-tab-model",
                               tab_id="wE:t19"))
        target = cache_mod.spool_file_name("wE:p99")
        opened: list[str] = []
        real_open = builtins.open

        def spy(file, *args, **kwargs):
            try:
                opened.append(str(file))
            except Exception:  # noqa: BLE001 - a spy must not break the run
                pass
            return real_open(file, *args, **kwargs)

        with mock.patch.object(builtins, "open", spy):
            result = cache_mod.Cache(self.db_path).ingest_inbox(
                self.inbox, admission_map=self.admission_map())
        self.assertEqual(result["written"], 0)
        self.assertEqual(result["skipped_denied"], 1)
        self.assertNotIn(target, [os.path.basename(p) for p in opened])
        self.assertIn("reserved_tab:wE:t19", json.dumps(result["refused"]))

    def test_a_pane_that_moved_is_refused_before_the_file_is_opened(self) -> None:
        # The map says the pane is in w1A:t1; the file's name says w1A:t9. The map is the
        # authority for the topology, so the file is refused -- and refused BEFORE it is
        # opened, which the spy proves.
        self.spool(observation("w1A:p1", SESSION_ALPHA_LEADER, 10, "moved-model",
                               tab_id="w1A:t9"),
                   name=cache_mod.spool_file_name("w1A:p1", "w1A:t9"))
        target = cache_mod.spool_file_name("w1A:p1", "w1A:t9")
        opened: list[str] = []
        real_open = builtins.open

        def spy(file, *args, **kwargs):
            opened.append(os.path.basename(str(file)))
            return real_open(file, *args, **kwargs)

        with mock.patch.object(builtins, "open", spy):
            result = cache_mod.Cache(self.db_path).ingest_inbox(
                self.inbox, admission_map=self.admission_map())
        self.assertEqual(result["written"], 0, result)
        self.assertEqual(result["skipped_moved"], 1, result)
        self.assertNotIn(target, opened)

    def test_a_file_without_a_tab_in_its_name_is_never_opened(self) -> None:
        # The current tab cannot be established before the file is opened, and the
        # reserved-tab refusal depends on it: such a file is refused, not opened.
        path = os.path.join(self.inbox, cache_mod.spool_file_name("w1A:p1"))
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("{ this is not json")
        target = cache_mod.spool_file_name("w1A:p1")
        opened: list[str] = []
        real_open = builtins.open

        def spy(file, *args, **kwargs):
            opened.append(os.path.basename(str(file)))
            return real_open(file, *args, **kwargs)

        with mock.patch.object(builtins, "open", spy):
            result = cache_mod.Cache(self.db_path).ingest_inbox(
                self.inbox, admission_map=self.admission_map())
        self.assertEqual(result["written"], 0, result)
        self.assertEqual(result["skipped_no_tab_identity"], 1, result)
        self.assertNotIn(target, opened)

    def test_a_record_whose_tab_contradicts_the_topology_is_refused(self) -> None:
        # The map is the authority: a record claiming another tab is a mismatch, not a
        # new fact. (The file's name agrees with the record, so the refusal happens on
        # the opened file -- the defence in depth, not the pre-read check.)
        self.spool(observation("w1A:p1", SESSION_ALPHA_LEADER, 10, "moved-model",
                               tab_id="w1Z:t9"),
                   name=cache_mod.spool_file_name("w1A:p1", "w1Z:t9"))
        result = cache_mod.Cache(self.db_path).ingest_inbox(
            self.inbox, admission_map=self.admission_map())
        self.assertEqual(result["written"], 0)
        self.assertEqual(result["skipped_moved"], 1)

    def test_the_cache_is_not_read_for_a_refused_lane(self) -> None:
        self.spool(observation("w1A:p1", SESSION_ALPHA_LEADER, 10, "admitted-model"))
        asked: list[str] = []
        original = cache_mod.Cache.read_pi_state

        def spy(self_cache, pane_id, **kwargs):
            asked.append(pane_id)
            return original(self_cache, pane_id, **kwargs)

        with mock.patch.object(cache_mod.Cache, "read_pi_state", spy):
            doc = self.roster()
        self.assertIn("w1A:p1", asked)
        for refused in ("w2:p1", "wE:t19", "wE:p99"):
            self.assertNotIn(refused, asked, f"the cache was read for the refused lane {refused}")
        lanes = {lane["key"]: lane for lane in doc["lanes"]}
        self.assertEqual(lanes["w2:p1"]["fields"]["P-11"]["state"], "held")

    def test_the_admission_map_is_published_for_the_reporter(self) -> None:
        doc = self.roster()
        deny_path = cache_mod.deny_file_path(self.db_path)
        self.assertTrue(os.path.exists(deny_path), deny_path)
        published = cache_mod.read_deny_file(deny_path)
        self.assertIn("w2", published.denied_workspaces)
        self.assertIn("wE:t19", published.reserved_panes)
        self.assertIn("wE:t19", published.reserved_tabs)
        # The topology's mapping is published for the lanes that MAY report, so the
        # reporter and the ingester decide the same way...
        self.assertEqual(published.pane_tab["w1A:p1"], "w1A:t1")
        self.assertEqual(published.pane_workspace["w1A:p1"], "w1A")
        # ...and the placement of the refused lanes is not published: the deny lists
        # are enough for both sides to refuse them, and nothing needs those handles.
        for refused in ("w2:p1", "wE:p99"):
            self.assertNotIn(refused, published.pane_tab, refused)
            self.assertNotIn(refused, published.pane_workspace, refused)
        # the roster says what it published
        self.assertEqual(doc["behold"]["admission"]["version"], admission_mod.ADMISSION_VERSION)
        self.assertIn("w2", doc["behold"]["admission"]["denied_workspaces"])


class TestCacheDisabled(JoinTestCase):
    def test_without_the_cache_the_field_says_so(self) -> None:
        import io
        import contextlib

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = cli.main(["roster", "--root", FIXTURE_ROOT, "--as-of", AS_OF,
                             "--cache", "off", "--cache-db", self.db_path])
        self.assertEqual(code, 0, buffer.getvalue()[:2000])
        doc = json.loads(buffer.getvalue())
        lane = {lane["key"]: lane for lane in doc["lanes"]}["w1A:p1"]
        field = lane["fields"]["P-11"]
        self.assertEqual(field["state"], "absent")
        self.assertIn("cache is not enabled", field["reason"])
        self.assertFalse(doc["behold"]["cache"]["enabled"])


if __name__ == "__main__":
    unittest.main()
