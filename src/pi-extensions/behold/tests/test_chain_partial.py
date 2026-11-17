"""`chain_partial`: a compaction artifact must not cost a whole session's fields.

The overlord's session carries 2 dangling `parentId` references — children of entries removed
during a compaction/context-edit window. behold used to call that `broken_parent` and reject the
session, which made T-1..T-4, M-1, G-1 and P-4/P-5 permanently unreadable for a lane that is very
much alive. The reachable branch is now kept and marked partial.

Two rules, and the second one is the hazard:

* terminal reads (the last entry, the latest state record) may use a partial chain;
* aggregates may not — a partial sum is a smaller number that no reader can tell from a real one.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest

from behold import lane as lane_mod
from tests import isolation
from tests.helpers import FIXTURE_ROOT, field, lanes, require_fixtures, roster, roster_json


def _copy_fixtures() -> str:
    """A private copy of the fixture tree, with its absolute paths re-pointed.

    The fixture's pil records and herdr pins carry absolute session paths. A naive copy leaves
    them pointing at the shared tree, so editing "the copy" would edit the fixture every other
    test reads. Rewriting the prefix is what makes the copy self-contained.
    """
    root = tempfile.mkdtemp(prefix="partial-", dir=isolation.SANDBOX)
    target = os.path.join(root, "fixtures")
    shutil.copytree(FIXTURE_ROOT, target, dirs_exist_ok=True)
    for base, _dirs, files in os.walk(target):
        for name in files:
            if not name.endswith(".json"):
                continue
            path = os.path.join(base, name)
            try:
                with open(path, encoding="utf-8") as handle:
                    text = handle.read()
            except OSError:
                continue
            if FIXTURE_ROOT not in text:
                continue
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(text.replace(FIXTURE_ROOT, target))
    return target


def _drop_a_parent(session_path: str) -> bool:
    """Remove one entry near the ROOT of the leaf's branch.

    Compaction residue is a removed *old* entry: the recent branch survives and only its far end
    dangles. Dropping the leaf's own parent (the first version of this test) left a one-entry
    chain, which proves nothing about terminal reads.
    """
    with open(session_path, encoding="utf-8") as handle:
        lines = handle.read().splitlines()
    by_id = {}
    for index, line in enumerate(lines):
        try:
            raw = json.loads(line)
        except ValueError:
            continue
        if isinstance(raw.get("id"), str):
            by_id[raw["id"]] = index
    if not by_id:
        return False
    leaf = list(by_id)[-1]
    # Walk leaf -> root.
    parent_of = {}
    for index, line in enumerate(lines):
        try:
            raw = json.loads(line)
        except ValueError:
            continue
        if isinstance(raw.get("id"), str) and isinstance(raw.get("parentId"), str):
            parent_of[raw["id"]] = raw["parentId"]
    path = [leaf]
    while path[-1] in parent_of and parent_of[path[-1]] in by_id:
        path.append(parent_of[path[-1]])
    if len(path) < 3:
        return False
    victim = path[-2]              # the root's child: removing it orphans everything above it
    index = by_id[victim]
    kept = [ln for i, ln in enumerate(lines) if i != index]
    with open(session_path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(kept) + "\n")
    return True


def _line_id(line: str) -> str | None:
    try:
        raw = json.loads(line)
    except ValueError:
        return None
    return raw.get("id") if isinstance(raw.get("id"), str) else None


def _lane_with_removable_parent(root: str) -> tuple[str, str]:
    """(pane, session path) for a lane whose session has at least one resolvable parent."""
    # Deliberately NOT roster_json: that helper caches per root, and a cached pre-edit document
    # would be handed to the test that is supposed to observe the edit. (That is how the first
    # version of this test "passed" a chain it had already broken.)
    code, out, err = roster(root=root)
    if code != 0:
        raise AssertionError(f"roster failed rc={code}: {err[:400]}")
    doc = json.loads(out)
    for pane, lane in lanes(doc).items():
        path = (field(lane, "P-5").get("value") or {}).get("path")
        if path and os.path.exists(path) and _has_resolvable_parent(path):
            return pane, path
    raise AssertionError("no fixture lane has a session with a resolvable parent")


def _has_resolvable_parent(session_path: str) -> bool:
    with open(session_path, encoding="utf-8") as handle:
        lines = handle.read().splitlines()
    ids = set()
    parents = []
    for line in lines:
        try:
            raw = json.loads(line)
        except ValueError:
            continue
        if isinstance(raw.get("id"), str):
            ids.add(raw["id"])
        if isinstance(raw.get("parentId"), str):
            parents.append(raw["parentId"])
    return any(parent in ids for parent in parents)

class TestPartialChain(unittest.TestCase):
    """(i) a dangling parent yields chain_partial, keeps terminal fields, refuses aggregates."""

    def setUp(self):
        require_fixtures()
        self.root = _copy_fixtures()
        # Pick the lane by finding a session file that actually has a resolvable parent, then
        # mapping it back through the roster's own P-5. Assuming a particular lane was the first
        # version of this test, and it broke when the fixture regeneration changed the payload.
        self.pane, path = _lane_with_removable_parent(self.root)
        self.assertTrue(_drop_a_parent(path), f"no removable parent in {path}")

    def test_chain_is_partial_not_broken(self):
        lane = lanes(roster_json(root=self.root))[self.pane]
        p4 = field(lane, "P-4")
        self.assertEqual(p4["state"], "present", p4)
        self.assertEqual(p4["value"]["chain_state"], "chain_partial")
        self.assertGreaterEqual(p4["value"]["orphans"], 1)
        self.assertTrue(p4["value"]["orphan_parents"])
        self.assertNotEqual(p4["value"]["chain_state"], "broken_parent")

    def test_terminal_records_still_answer(self):
        """Terminal reads are not refused because the branch is partial.

        A specific field may still be unknown for its own reason (a lane with no model has no
        T-2), so the assertion is scoped: no terminal field is refused by the *partial-chain*
        rule, and at least one of them answers.
        """
        lane = lanes(roster_json(root=self.root))[self.pane]
        terminal = ("T-1", "T-2", "T-3", "P-1", "P-2", "P-3", "M-1", "G-1", "D-1", "P-8")
        for code in terminal:
            self.assertNotEqual(field(lane, code).get("reason"),
                                lane_mod.PARTIAL_AGGREGATE_REFUSAL, code)
        answered = [code for code in terminal
                    if field(lane, code)["state"] in ("present", "derived")]
        self.assertTrue(answered, [field(lane, c) for c in terminal])

    def test_partial_marker_travels_with_every_session_field(self):
        """Every branch-derived field that carries a value also carries the marker."""
        lane = lanes(roster_json(root=self.root))[self.pane]
        present = {code for code in lane_mod.SESSION_CHAIN_FIELDS
                   if field(lane, code)["state"] in ("present", "derived")}
        self.assertTrue(present, "no branch-derived field was emitted")
        for code in ("P-4", "T-1", "M-1", "G-1", "D-1"):
            self.assertIn(code, lane_mod.SESSION_CHAIN_FIELDS)
        missing = sorted(code for code in present
                         if "chain_partial" not in (field(lane, code).get("note") or ""))
        self.assertEqual(missing, [], f"fields without the partial marker: {missing}")

    def test_aggregates_refuse_a_partial_chain(self):
        lane = lanes(roster_json(root=self.root))[self.pane]
        for code in ("T-4", "T-5", "T-6", "T-7"):
            value = field(lane, code)
            self.assertEqual(value["state"], "absent", f"{code}: {value}")
            self.assertEqual(value["reason"], lane_mod.PARTIAL_AGGREGATE_REFUSAL)


class TestNoAggregateLeaksAcrossAPartialChain(unittest.TestCase):
    """(ii) the negative test: nothing may quietly sum a partial branch.

    This is the case that would otherwise "pass": the surviving entries sum to a perfectly
    plausible, smaller number, and a reader has no way to tell it from a complete one.
    """

    def setUp(self):
        require_fixtures()
        self.root = _copy_fixtures()
        self.pane, path = _lane_with_removable_parent(self.root)
        self.assertTrue(_drop_a_parent(path), f"no removable parent in {path}")

    def test_no_present_field_sums_a_partial_branch(self):
        lane = lanes(roster_json(root=self.root))[self.pane]
        self.assertEqual(field(lane, "P-4")["value"]["chain_state"], "chain_partial")
        for code, value in lane["fields"].items():
            if value["state"] not in ("present", "derived", "last_observed"):
                continue
            source = (value.get("source") or "").lower()
            self.assertNotIn("sum over", source,
                             f"{code} aggregates a partial chain: {value}")
            self.assertNotIn("aggregate over the active branch", source, code)

    def test_the_smaller_total_is_not_offered_at_all(self):
        lane = lanes(roster_json(root=self.root))[self.pane]
        t4 = field(lane, "T-4")
        self.assertIsNone(t4["value"], t4)          # no plausible smaller number
        self.assertNotIn("tokens", json.dumps(t4.get("value")))
        self.assertIn("complete chain", t4["reason"])


if __name__ == "__main__":
    unittest.main()
