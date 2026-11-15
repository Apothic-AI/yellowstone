"""``L-1`` — the lane's fleet role, read from its role record and never inferred.

The role is the one lane fact with no independent corroboration in Behold's other sources:
a lane name ending in ``-leader``, the selected profile and the model all correlate with
the role and none of them prove it. So these tests are mostly about the ways the field must
**refuse** to produce a value:

* a lane whose record exists → ``present`` with the record path as its source;
* a lane with no record → ``absent`` (a real fact, not an error);
* a record with no ``PI_MODE``, or one whose value is not a safe handle → ``unknown`` with
  the reason, never a guess and never an empty string;
* a lane whose *name* says ``-leader`` but has no record → still ``absent``;
* a refused lane (held workspace, reserved tab/pane) → the record path is never even
  composed, proved by the attempted-open list with a positive control next to it.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest

from tests.helpers import ROOT, roster

sys.path.insert(0, ROOT)

from behold import guard  # noqa: E402
from behold.sources import pil_roles  # noqa: E402

ROLE_LINE = "PI_MODE=leader PI_PROFILE=leader PI_MODE_CONFIRM_PROJECT=1\n"


class TestRoleAccess(unittest.TestCase):
    """The reader itself, against a directory this test owns."""

    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp(prefix="roles-", dir=os.environ.get("TMPDIR"))
        self.policy = guard.Policy()

    def write(self, lane: str, text: str) -> str:
        path = os.path.join(self.dir, f"{lane}.env")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        return path

    def access(self) -> pil_roles.RoleAccess:
        return pil_roles.RoleAccess(self.dir, self.policy)

    def test_present_carries_the_value_and_the_record_path(self) -> None:
        path = self.write("alpha-leader", ROLE_LINE)
        result = self.access().role_for(name_hint="alpha-leader", pane_id="w1A:p1",
                                        workspace_id="w1A", tab_id="w1A:t1")
        self.assertEqual(result["state"], "present")
        self.assertEqual(result["role"], "leader")
        self.assertEqual(result["source"], path)

    def test_worker_role_is_reported_as_worker(self) -> None:
        self.write("alpha-worker", "PI_MODE=worker PI_PROFILE=worker\n")
        result = self.access().role_for(name_hint="alpha-worker", pane_id="w1A:p2",
                                        workspace_id="w1A", tab_id="w1A:t2")
        self.assertEqual((result["state"], result["role"]), ("present", "worker"))

    def test_no_record_is_absent_not_inferred_from_the_name(self) -> None:
        # The name says "leader". The record does not exist. The answer is absent.
        result = self.access().role_for(name_hint="x-leader", pane_id="w1A:p3",
                                        workspace_id="w1A", tab_id="w1A:t3")
        self.assertEqual(result["state"], "absent")
        self.assertIsNone(result["role"])
        self.assertIn("no role record", result["reason"])
        self.assertEqual(self.access().opened, [])

    def test_record_without_pi_mode_is_unknown(self) -> None:
        self.write("alpha-leader", "PI_PROFILE=leader\n")
        result = self.access().role_for(name_hint="alpha-leader", pane_id="w1A:p1",
                                        workspace_id="w1A", tab_id="w1A:t1")
        self.assertEqual(result["state"], "unknown")
        self.assertIsNone(result["role"])
        self.assertIn("PI_MODE", result["reason"])

    def test_empty_record_is_unknown_nor_absent(self) -> None:
        self.write("alpha-leader", "")
        result = self.access().role_for(name_hint="alpha-leader", pane_id="w1A:p1",
                                        workspace_id="w1A", tab_id="w1A:t1")
        self.assertEqual(result["state"], "unknown")
        self.assertIsNone(result["role"])

    def test_unsafe_role_value_is_unknown(self) -> None:
        self.write("alpha-leader", "PI_MODE=../../etc/passwd\n")
        result = self.access().role_for(name_hint="alpha-leader", pane_id="w1A:p1",
                                        workspace_id="w1A", tab_id="w1A:t1")
        self.assertEqual(result["state"], "unknown")
        self.assertIsNone(result["role"])

    def test_unsafe_lane_name_is_refused_before_any_path(self) -> None:
        result = self.access().role_for(name_hint="../escape", pane_id="w1A:p1",
                                        workspace_id="w1A", tab_id="w1A:t1")
        self.assertEqual(result["state"], "absent")
        self.assertEqual(self.access().opened, [])

    def test_refused_lane_never_reaches_the_open_with_a_positive_control(self) -> None:
        """A held workspace is refused *before* the path is composed; the control proves
        the reader would otherwise have opened a file, so "nothing opened" cannot mean
        "the reader never ran"."""
        self.write("alpha-leader", ROLE_LINE)
        reader = self.access()
        held = reader.role_for(name_hint="alpha-leader", pane_id="w2:p1",
                               workspace_id="w2", tab_id="w2:t1")
        self.assertEqual(held["state"], "refused")
        self.assertEqual(reader.opened, [])

        # Positive control: the same record, an admitted lane, is opened.
        admitted = reader.role_for(name_hint="alpha-leader", pane_id="w1A:p1",
                                   workspace_id="w1A", tab_id="w1A:t1")
        self.assertEqual(admitted["state"], "present")
        self.assertEqual(len(reader.opened), 1)

    def test_reserved_tab_and_pane_are_refused_too(self) -> None:
        self.write("reserved-lane", ROLE_LINE)
        reader = self.access()
        for pane, tab in (("w1C:p2", "wE:t19"), ("wE:p99", "wE:t19")):
            result = reader.role_for(name_hint="reserved-lane", pane_id=pane,
                                     workspace_id="w1C", tab_id=tab)
            self.assertEqual(result["state"], "refused", (pane, tab))
        self.assertEqual(reader.opened, [])


class TestRoleFieldInRoster(unittest.TestCase):
    """``L-1`` in the emitted document (the fixture fleet ships no role records)."""

    def test_every_lane_carries_l1_and_it_is_absent_without_records(self) -> None:
        import json
        code, out, err = roster()
        self.assertEqual(code, 0, err[-2000:])
        doc = json.loads(out)
        self.assertTrue(doc["lanes"])
        for lane in doc["lanes"]:
            field = lane["fields"].get("L-1")
            self.assertIsNotNone(field, lane["key"])
            if not lane["admission"]["admitted"]:
                # A refused lane's every field is held; L-1 must not be an exception that
                # leaks a read attempt for it.
                self.assertEqual(field["state"], "held", lane["key"])
                continue
            self.assertEqual(field["state"], "absent",
                             (lane["key"], field.get("reason")))
            self.assertIsNone(field["value"])

    def test_projection_of_l1_does_not_parse_sessions(self) -> None:
        import json
        code, out, err = roster("--fields", "key,L-1")
        self.assertEqual(code, 0, err[-2000:])
        doc = json.loads(out)
        self.assertFalse(doc["behold"]["projection"]["session_derived"])
        self.assertEqual(doc["behold"]["session_reads"]["files_parsed"], 0)
        for lane in doc["lanes"]:
            self.assertIn("L-1", lane["fields"])
            self.assertNotIn("H-5", lane["fields"])

    def test_projection_skip_reason_is_not_noaccess(self) -> None:
        import json
        code, out, err = roster("--fields", "key,L-1")
        self.assertEqual(code, 0, err[-2000:])
        m4 = json.loads(out)["global"]["M-4"]
        self.assertEqual(m4["state"], "unknown")
        self.assertIn("skipped_by_projection", m4["value"]["reason"])
        self.assertNotIn("noaccess", m4["value"]["reason"])


class TestLaneSelector(unittest.TestCase):
    """``--lane`` names a lane or a pane, and a miss is loud rather than empty."""

    def test_lane_by_name_returns_exactly_that_lane(self) -> None:
        import json
        code, out, err = roster("--lane", "alpha-leader", "--fields", "key,H-4")
        self.assertEqual(code, 0, err[-2000:])
        doc = json.loads(out)
        self.assertEqual(len(doc["lanes"]), 1)
        self.assertEqual(doc["lanes"][0]["key"], "w1A:p1")
        self.assertEqual(doc["behold"]["lane_selector"]["matched_by"],
                         {"w1A:p1": "name_layer:tab_label"})

    def test_lane_by_pane_id_still_works(self) -> None:
        import json
        code, out, err = roster("--lane", "w1A:p1", "--fields", "key")
        self.assertEqual(code, 0, err[-2000:])
        doc = json.loads(out)
        self.assertEqual([lane["key"] for lane in doc["lanes"]], ["w1A:p1"])
        self.assertEqual(doc["behold"]["lane_selector"]["matched_by"], {"w1A:p1": "pane_id"})

    def test_unknown_lane_is_a_usage_error_with_a_vocabulary_hint(self) -> None:
        code, out, err = roster("--lane", "NoSuchLane")
        self.assertNotEqual(code, 0)
        self.assertEqual(out.strip(), "")
        self.assertIn("NoSuchLane", err)
        self.assertIn("pane id", err)
        self.assertIn("name", err)


if __name__ == "__main__":
    unittest.main()
