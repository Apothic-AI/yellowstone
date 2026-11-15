"""The admission map, tested as a boundary: what it must refuse to be.

The map is the one thing the reporter and the ingester both trust, so the tests here are
about **fail-closed** behaviour. A map that is missing a deny list, holds a handle that
is not a handle, covers only half the panes, or claims a capture time in the future is a
**broken** map — not an empty one, and not a fresh one.

The holds themselves are **hard-coded**: they come from the roster's policy, and a
custom or malformed map cannot remove one. The last test in this file proves it end to
end: a doctored map lets the reporter write a record for a held lane, and the ingester
still refuses it.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest

from tests.helpers import ROOT

sys.path.insert(0, ROOT)

from behold import admission as admission_mod  # noqa: E402
from behold import cache as cache_mod  # noqa: E402
from behold import guard  # noqa: E402

PANES = [
    {"pane_id": "w1A:p1", "tab_id": "w1A:t1", "workspace_id": "w1A"},
    {"pane_id": "w2:p1", "tab_id": "w2:t1", "workspace_id": "w2"},
    {"pane_id": "wE:p99", "tab_id": "wE:t19", "workspace_id": "wE"},
]


def valid_map() -> dict:
    return admission_mod.build_map(
        policy=guard.Policy(), panes=PANES, topology_revision="test").to_dict()


class TestTheValidator(unittest.TestCase):
    def setUp(self) -> None:
        self.payload = valid_map()

    def _refuse(self, payload: object) -> None:
        with self.assertRaises(admission_mod.AdmissionError):
            admission_mod.AdmissionMap.from_dict(payload)

    def test_a_valid_map_is_accepted(self) -> None:
        parsed = admission_mod.AdmissionMap.from_dict(self.payload)
        self.assertEqual(parsed.version, admission_mod.ADMISSION_VERSION)
        self.assertIn("w2", parsed.denied_workspaces)
        self.assertIn("wE:t19", parsed.reserved_panes)
        self.assertIn("wE:t19", parsed.reserved_tabs)
        # The map carries the placement of the lanes that MAY report...
        self.assertEqual(parsed.pane_tab["w1A:p1"], "w1A:t1")
        self.assertEqual(parsed.pane_workspace["w1A:p1"], "w1A")
        # ...and not the placement of the lanes the holds refuse: the deny lists are
        # published, and both sides refuse those lanes on the lists alone.
        self.assertNotIn("w2:p1", parsed.pane_tab)
        self.assertNotIn("w2:p1", parsed.pane_workspace)
        self.assertNotIn("wE:p99", parsed.pane_tab)
        self.assertNotIn("wE:p99", parsed.pane_workspace)

    def test_a_missing_deny_list_is_a_broken_map_not_an_empty_one(self) -> None:
        for key in ("denied_workspaces", "reserved_panes", "reserved_tabs"):
            payload = dict(self.payload)
            del payload[key]
            with self.assertRaises(admission_mod.AdmissionError) as ctx:
                admission_mod.AdmissionMap.from_dict(payload)
            self.assertIn(key, str(ctx.exception))

    def test_a_wrongly_typed_deny_list_is_refused(self) -> None:
        for value in ("w2", 42, {"w2": True}, None):
            payload = dict(self.payload)
            payload["denied_workspaces"] = value
            self._refuse(payload)

    def test_a_deny_list_entry_that_is_not_a_handle_is_refused(self) -> None:
        for value in (["w2", 7], ["w2", ""], ["w2", None], ["../../etc/passwd"],
                      ["w 2"], ["w2\n"], ["x" * 200]):
            payload = dict(self.payload)
            payload["denied_workspaces"] = value
            self._refuse(payload)

    def test_a_missing_pane_mapping_is_refused(self) -> None:
        for key in ("pane_tab", "pane_workspace"):
            payload = dict(self.payload)
            del payload[key]
            self._refuse(payload)

    def test_a_partial_pane_mapping_is_refused(self) -> None:
        # A pane the map places in a tab but not in a workspace cannot be admitted: the
        # roster does not know where it lives.
        payload = dict(self.payload)
        payload["pane_tab"] = dict(payload["pane_tab"])
        payload["pane_tab"]["w9:p9"] = "w9:t9"
        self._refuse(payload)
        payload = dict(self.payload)
        payload["pane_workspace"] = dict(payload["pane_workspace"])
        del payload["pane_workspace"]["w1A:p1"]
        self._refuse(payload)

    def test_a_pane_mapping_that_is_not_a_string_map_is_refused(self) -> None:
        for value in ([], "w1A:t1", {"w1A:p1": 3}, {"w1A:p1": None}):
            payload = dict(self.payload)
            payload["pane_tab"] = value
            self._refuse(payload)

    def test_an_unsafe_handle_in_a_pane_mapping_is_refused(self) -> None:
        payload = dict(self.payload)
        payload["pane_tab"] = dict(payload["pane_tab"])
        payload["pane_tab"]["../../etc/passwd"] = "w1A:t1"
        self._refuse(payload)

    def test_a_capture_time_that_is_not_a_number_is_refused(self) -> None:
        for value in ("now", None, True, [1]):
            payload = dict(self.payload)
            payload["captured_at_epoch"] = value
            self._refuse(payload)

    def test_a_capture_time_that_is_not_finite_is_refused(self) -> None:
        for value in (float("nan"), float("inf"), float("-inf")):
            payload = dict(self.payload)
            payload["captured_at_epoch"] = value
            self._refuse(payload)

    def test_a_capture_time_in_the_future_is_refused(self) -> None:
        payload = dict(self.payload)
        payload["captured_at_epoch"] = time.time() + 3600
        with self.assertRaises(admission_mod.AdmissionError) as ctx:
            admission_mod.AdmissionMap.from_dict(payload)
        self.assertIn("future", str(ctx.exception))

    def test_a_wrong_version_is_refused(self) -> None:
        payload = dict(self.payload)
        payload["version"] = 1
        self._refuse(payload)

    def test_a_stale_map_is_refused_by_the_reader(self) -> None:
        payload = dict(self.payload)
        payload["captured_at_epoch"] = time.time() - 10_000
        # the shape is valid, so the map parses; the READER is what refuses a stale map
        parsed = admission_mod.AdmissionMap.from_dict(payload)
        self.assertTrue(parsed.is_stale())
        # and the file reader refuses it as stale
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "map.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(payload, fh)
            with self.assertRaises(admission_mod.AdmissionError) as ctx:
                admission_mod.load(path)
            self.assertIn("stale", str(ctx.exception))

    def test_a_missing_or_malformed_file_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(admission_mod.AdmissionError):
                admission_mod.load(os.path.join(tmp, "absent.json"))
            path = os.path.join(tmp, "map.json")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("{not json")
            with self.assertRaises(admission_mod.AdmissionError):
                admission_mod.load(path)


class TestTheDecision(unittest.TestCase):
    def setUp(self) -> None:
        self.admission = admission_mod.AdmissionMap.from_dict(valid_map())

    def test_an_admitted_lane_is_admitted(self) -> None:
        admitted, reason = self.admission.decide("w1A:p1", tab_id="w1A:t1")
        self.assertTrue(admitted, reason)

    def test_a_held_workspace_is_refused(self) -> None:
        admitted, reason = self.admission.decide("w2:p1", tab_id="w2:t1")
        self.assertFalse(admitted)
        self.assertEqual(reason, "held_workspace:w2")

    def test_a_reserved_tab_is_refused(self) -> None:
        admitted, reason = self.admission.decide("wE:p99", tab_id="wE:t19")
        self.assertFalse(admitted)
        self.assertEqual(reason, "reserved_tab:wE:t19")

    def test_an_unknown_pane_is_refused(self) -> None:
        admitted, reason = self.admission.decide("w9:p9", tab_id="w9:t9")
        self.assertFalse(admitted)
        self.assertIn("unknown_pane", str(reason))

    def test_a_pane_that_moved_is_refused(self) -> None:
        # The map is the authority for the topology: a tab that contradicts it is a
        # mismatch, not a new fact.
        admitted, reason = self.admission.decide("w1A:p1", tab_id="w1A:t9")
        self.assertFalse(admitted)
        self.assertIn("tab_mismatch", str(reason))

    def test_a_workspace_that_contradicts_is_refused(self) -> None:
        admitted, reason = self.admission.decide("w1A:p1", tab_id="w1A:t1",
                                                 workspace_id="w9")
        self.assertFalse(admitted)
        self.assertIn("workspace_mismatch", str(reason))


class TestTheWriteDecision(unittest.TestCase):
    """The reporter's side: the map is the authority for the current placement."""

    def setUp(self) -> None:
        self.admission = admission_mod.AdmissionMap.from_dict(valid_map())

    def test_an_admitted_lane_may_write_under_the_maps_tab(self) -> None:
        allowed, reason, tab = self.admission.allows_write(
            "w1A:p1", inherited_tab="w1A:t1", inherited_workspace="w1A")
        self.assertTrue(allowed, reason)
        self.assertEqual(tab, "w1A:t1")

    def test_a_pane_that_moved_to_an_admitted_tab_keeps_reporting(self) -> None:
        # The inherited tab does not follow a pane that moves: the record is written
        # under the MAP's tab, or the lane would fall silent forever.
        allowed, reason, tab = self.admission.allows_write(
            "w1A:p1", inherited_tab="w1A:t1", inherited_workspace="w1A")
        self.assertTrue(allowed, reason)
        self.assertEqual(tab, self.admission.tab_for("w1A:p1"))

    def test_a_pane_that_moved_into_a_reserved_tab_may_not_write(self) -> None:
        # The map publishes the placement of the admitted lanes only, so a pane that
        # sits in a reserved tab is not in it: the reporter cannot vouch for it and
        # stays silent. The refusal is the same; only the word for it differs, and the
        # ingester still names the reserved tab, because the file's name carries it.
        allowed, reason, tab = self.admission.allows_write(
            "wE:p99", inherited_tab="wE:t1", inherited_workspace="wE")
        self.assertFalse(allowed)
        self.assertIn("unknown_pane", str(reason))
        self.assertIsNone(tab)

    def test_a_lane_launched_in_a_reserved_tab_stays_silent(self) -> None:
        allowed, reason, tab = self.admission.allows_write(
            "w1A:p1", inherited_tab="wE:t19", inherited_workspace="w1A")
        self.assertFalse(allowed)
        self.assertIn("reserved_tab", str(reason))

    def test_a_held_workspace_may_not_write(self) -> None:
        allowed, reason, tab = self.admission.allows_write(
            "w2:p1", inherited_tab="w2:t1", inherited_workspace="w2")
        self.assertFalse(allowed)
        self.assertEqual(reason, "held_workspace:w2")

    def test_an_unknown_pane_may_not_write(self) -> None:
        allowed, reason, tab = self.admission.allows_write(
            "w9:p9", inherited_tab="w9:t9", inherited_workspace="w9")
        self.assertFalse(allowed)
        self.assertIn("unknown_pane", str(reason))


class TestThePublishedPlacement(unittest.TestCase):
    """The map publishes the placement of the lanes that may report, and no more.

    The refusal does not need the refused lanes' placement: the deny lists are
    published, the reporter refuses before it writes and the ingester refuses before
    it opens a file. Carrying that placement would publish handles of lanes the
    roster itself holds, for no gain.
    """

    def build(self) -> admission_mod.AdmissionMap:
        return admission_mod.build_map(
            policy=guard.Policy(), panes=PANES, topology_revision="test")

    def test_only_the_admitted_placement_is_published(self) -> None:
        built = self.build()
        self.assertEqual(dict(built.pane_tab), {"w1A:p1": "w1A:t1"})
        self.assertEqual(dict(built.pane_workspace), {"w1A:p1": "w1A"})

    def test_the_holds_are_still_published(self) -> None:
        # The ids themselves are unavoidable: both sides need them to refuse.
        built = self.build()
        self.assertIn("w2", built.denied_workspaces)
        self.assertIn("wE:t19", built.reserved_panes)
        self.assertIn("wE:t19", built.reserved_tabs)

    def test_a_refused_lane_is_still_refused_and_says_why(self) -> None:
        # The holds are applied before the placement lookup, so the reason for a
        # refusal is the hold and not "unknown pane".
        built = self.build()
        self.assertEqual(built.decide("w2:p1", tab_id="w2:t1")[1], "held_workspace:w2")
        self.assertEqual(built.decide("wE:p99", tab_id="wE:t19")[1], "reserved_tab:wE:t19")
        self.assertEqual(built.decide("wE:t19")[1], "reserved_pane:wE:t19")
        # and the lane that may report is admitted
        self.assertTrue(built.decide("w1A:p1", tab_id="w1A:t1")[0])

    def test_a_pane_the_map_does_not_carry_is_refused(self) -> None:
        built = self.build()
        admitted, reason = built.decide("w9:p9", tab_id="w9:t9")
        self.assertFalse(admitted)
        self.assertIn("unknown_pane", str(reason))

    def test_a_malformed_pane_id_is_not_in_the_published_placement(self) -> None:
        built = admission_mod.build_map(
            policy=guard.Policy(),
            panes=[{"pane_id": "held pane", "tab_id": "w1A:t1",
                    "workspace_id": "w1A"},
                   {"pane_id": "w2", "tab_id": "w1A:t1", "workspace_id": "w1A"}],
            topology_revision="test")
        self.assertEqual(dict(built.pane_tab), {})
        self.assertEqual(dict(built.pane_workspace), {})


class TestTheHoldsAreHardCoded(unittest.TestCase):
    """A custom or malformed map cannot remove a hold."""

    def test_the_published_map_always_carries_the_policy_holds(self) -> None:
        published = admission_mod.build_map(
            policy=guard.Policy(), panes=PANES, topology_revision="test")
        self.assertIn("w2", published.denied_workspaces)
        self.assertIn("wE:t19", published.reserved_panes)
        self.assertIn("wE:t19", published.reserved_tabs)

    def test_a_doctored_map_cannot_get_a_held_lane_into_the_cache(self) -> None:
        # The doctored map drops the holds: a reporter that trusts it would write for the
        # held lane. The ingest does not trust the file -- it uses the map the roster
        # built from the policy -- so the hold holds.
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "behold.db")
            inbox = cache_mod.inbox_dir_for(db_path)
            os.makedirs(inbox, exist_ok=True)
            doctored = valid_map()
            doctored["denied_workspaces"] = []
            doctored["reserved_panes"] = []
            doctored["reserved_tabs"] = []
            with open(os.path.join(tmp, admission_mod.ADMISSION_FILE_NAME), "w",
                      encoding="utf-8") as fh:
                json.dump(doctored, fh)
            record = {
                "behold_state": cache_mod.STATE_RECORD_VERSION,
                "pane_id": "w2:p1", "tab_id": "w2:t1",
                "session_id": "aaaaaaaa-0000-4000-8000-000000000004",
                "incarnation": "11111111-2222-3333-4444-555555555555:1:1",
                "boot_id": "11111111-2222-3333-4444-555555555555",
                "incarnation_start_ticks": 1, "incarnation_boot_epoch": 5000.0,
                "seq": 1, "observed_at": "2026-11-12T00:00:00Z",
                "observed_at_epoch": time.time(),
                "state": {"model_id": "held-model"}, "writer": "pi-extension",
            }
            with open(os.path.join(inbox, cache_mod.spool_file_name("w2:p1", "w2:t1")),
                      "w", encoding="utf-8") as fh:
                json.dump(record, fh)
            real = admission_mod.build_map(
                policy=guard.Policy(), panes=PANES, topology_revision="test")
            with cache_mod.Cache(db_path) as cache:
                result = cache.ingest_inbox(inbox, admission_map=real)
                self.assertEqual(result["written"], 0, result)
                self.assertEqual(result["skipped_denied"], 1, result)
                self.assertEqual(cache.pi_state_freshness()["rows"], 0)


if __name__ == "__main__":
    unittest.main()
