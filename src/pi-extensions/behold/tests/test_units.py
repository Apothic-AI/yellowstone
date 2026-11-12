"""Parser unit tests: leaf semantics, damaged files, rotation, and the mode digest.

These run against temporary files, so they can construct the exact broken shapes a live
file produces (a half-written final line, a missing parent, a duplicate id, a leaf hint that
does not exist) without depending on the fixture fleet.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

from tests.helpers import ROOT

sys.path.insert(0, ROOT)

from behold import guard, identity, session, util  # noqa: E402
from behold.sources import pi_state  # noqa: E402

HEADER = {"type": "session", "version": 3, "id": "11111111-1111-4111-8111-111111111111",
          "timestamp": "2026-11-11T02:00:00Z", "cwd": "/tmp/project"}


def _write(tmp: str, lines: list[dict | str], name: str | None = None) -> str:
    path = os.path.join(tmp, name or "2026-11-11T02-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl")
    with open(path, "w", encoding="utf-8") as fh:
        for line in lines:
            fh.write(line if isinstance(line, str) else json.dumps(line))
            fh.write("\n")
    return path


def _msg(eid: str, parent: str | None, role: str = "assistant", **extra) -> dict:
    message = {"role": role, "content": [], "timestamp": 1793000000000, **extra}
    return {"type": "message", "id": eid, "parentId": parent,
            "timestamp": "2026-11-11T02:01:00Z", "message": message}


class TestLeafSemantics(unittest.TestCase):
    def test_leaf_is_last_file_entry_and_chain_follows_parents(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = _write(tmp, [
                HEADER,
                _msg("a", None, role="user"),
                _msg("b", "a"),
                _msg("c", "b", role="user"),
            ])
            view = session.load(root, guard.Policy())
            self.assertEqual(view.leaf_id, "c")
            self.assertEqual(view.leaf_source, "last_file_entry")
            self.assertEqual([e.id for e in view.chain], ["a", "b", "c"])
            self.assertEqual(view.chain_state, session.CHAIN_OK)

    def test_last_line_on_an_abandoned_branch_does_not_become_the_chain(self):
        # b -> c1 (abandoned) and b -> c2 (active). File order puts c1 last, but after a
        # branch the *leaf* is the last entry, so c1's line is the leaf only if it really is
        # last. Here d hangs off c1, so the chain is a,b,c1,d and c2 is not included.
        with tempfile.TemporaryDirectory() as tmp:
            root = _write(tmp, [
                HEADER,
                _msg("a", None, role="user"),
                _msg("b", "a"),
                _msg("c1", "b"),
                _msg("c2", "b"),
                _msg("d", "c1"),
            ])
            view = session.load(root, guard.Policy())
            self.assertEqual([e.id for e in view.chain], ["a", "b", "c1", "d"])
            self.assertEqual(len(view.entries), 5)

    def test_explicit_leaf_hint_moves_the_chain(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = _write(tmp, [
                HEADER,
                _msg("a", None, role="user"),
                _msg("b", "a"),
                _msg("c", "b"),
            ])
            view = session.load(root, guard.Policy(), leaf_hint="b")
            self.assertEqual(view.leaf_source, "leaf_hint")
            self.assertEqual([e.id for e in view.chain], ["a", "b"])

    def test_unknown_leaf_hint_is_reported_not_used(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = _write(tmp, [HEADER, _msg("a", None, role="user")])
            view = session.load(root, guard.Policy(), leaf_hint="does-not-exist")
            self.assertIn(session.LEAF_HINT_INVALID, view.diagnostics)
            self.assertEqual(view.leaf_source, "last_file_entry")

    def test_missing_parent_marks_chain_broken(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = _write(tmp, [HEADER, _msg("a", "ghost", role="user")])
            view = session.load(root, guard.Policy())
            self.assertEqual(view.chain_state, session.CHAIN_BROKEN)
            self.assertTrue(any("missing_parent" in d for d in view.diagnostics))

    def test_cycle_is_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = _write(tmp, [
                HEADER,
                _msg("a", "b", role="user"),
                _msg("b", "a"),
            ])
            view = session.load(root, guard.Policy())
            self.assertEqual(view.chain_state, session.CHAIN_CYCLE)

    def test_partial_final_line_is_dropped_and_flagged(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "s.jsonl")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(json.dumps(HEADER) + "\n")
                fh.write(json.dumps(_msg("a", None, role="user")) + "\n")
                fh.write('{"type":"message","id":"b","parentId":"a","timest')
            view = session.load(path, guard.Policy())
            self.assertTrue(view.partial_tail)
            self.assertIn("partial_final_line_ignored", view.diagnostics)
            self.assertEqual([e.id for e in view.chain], ["a"])

    def test_malformed_middle_line_is_counted_and_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "s.jsonl")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(json.dumps(HEADER) + "\n")
                fh.write("not json\n")
                fh.write(json.dumps(_msg("a", None, role="user")) + "\n")
            view = session.load(path, guard.Policy())
            self.assertEqual(view.malformed, 1)
            self.assertEqual([e.id for e in view.chain], ["a"])

    def test_duplicate_ids_are_counted(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write(tmp, [HEADER, _msg("a", None, role="user"), _msg("a", None)])
            view = session.load(path, guard.Policy())
            self.assertEqual(view.duplicate_ids, 1)

    def test_version_one_session_without_tree_still_parses(self):
        with tempfile.TemporaryDirectory() as tmp:
            header = dict(HEADER, version=1)
            path = _write(tmp, [header,
                                {"type": "message", "timestamp": "2026-11-11T02:01:00Z",
                                 "message": {"role": "user", "content": "x",
                                             "timestamp": 1793000000000}}])
            view = session.load(path, guard.Policy())
            self.assertEqual(view.version, 1)
            self.assertEqual(len(view.chain), 1)


class TestRotation(unittest.TestCase):
    def test_growth_is_not_rotation(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "s.jsonl")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("{}\n")
            rotated, current = session.probe_rotation(path, None)
            self.assertFalse(rotated)
            with open(path, "a", encoding="utf-8") as fh:
                fh.write("{}\n")
            rotated, _ = session.probe_rotation(path, current)
            self.assertFalse(rotated)

    def test_inode_change_is_rotation(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "s.jsonl")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("a\n" * 100)
            _r, current = session.probe_rotation(path, None)
            replacement = path + ".new"
            with open(replacement, "w", encoding="utf-8") as fh:
                fh.write("a\n" * 100)
            os.replace(replacement, path)
            rotated, _ = session.probe_rotation(path, current)
            self.assertTrue(rotated)

    def test_disappearance_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "s.jsonl")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("a\n")
            _r, current = session.probe_rotation(path, None)
            os.unlink(path)
            rotated, state = session.probe_rotation(path, current)
            self.assertTrue(rotated)
            self.assertFalse(state["exists"])


class TestModeDigest(unittest.TestCase):
    MODE = {
        "schemaVersion": 1,
        "key": "leader",
        "label": "Leader",
        "description": "d",
        "promptStrategy": "append",
        "systemPrompt": "body",
        "requires": ["b", "a"],
        "conflictsWith": [],
        "before": [],
        "after": ["z"],
        "scope": "global",
        "path": "/tmp/modes/leader.json",
    }

    def test_digest_is_order_insensitive_for_lists(self):
        first = pi_state.mode_definition_fingerprint(dict(self.MODE))
        second = pi_state.mode_definition_fingerprint(
            dict(self.MODE, requires=["a", "b"], after=["z"]))
        self.assertEqual(first, second)
        self.assertEqual(len(first), 64)

    def test_digest_changes_with_scope_and_path(self):
        base = pi_state.mode_definition_fingerprint(dict(self.MODE))
        other_scope = pi_state.mode_definition_fingerprint(dict(self.MODE, scope="project"))
        other_path = pi_state.mode_definition_fingerprint(dict(self.MODE, path="/tmp/other.json"))
        self.assertNotEqual(base, other_scope)
        self.assertNotEqual(base, other_path)

    def test_drift_is_unverifiable_when_the_definition_is_gone(self):
        drift = pi_state.mode_drift(
            {"leader": {"digest": "deadbeef", "scope": "global", "path": "/nonexistent/x.json"}},
            policy=guard.Policy(), global_mode_dir="/tmp/modes", cwd=None)
        self.assertEqual(drift["state"], "unverifiable")
        self.assertIn("missing", drift["details"][0]["reason"])

    def test_drift_detects_a_changed_definition(self):
        mode = {"schemaVersion": 1, "key": "leader", "label": "Leader",
                "description": "d", "promptStrategy": "append", "systemPrompt": "body",
                "requires": [], "conflictsWith": [], "before": [], "after": []}
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "leader.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(dict(mode, systemPrompt="one"), fh)
            recorded = pi_state.mode_definition_fingerprint(dict(mode, scope="global", path=path))
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(dict(mode, systemPrompt="two"), fh)
            drift = pi_state.mode_drift(
                {"leader": {"digest": recorded, "scope": "global", "path": path}},
                policy=guard.Policy(), global_mode_dir=tmp, cwd=None)
            self.assertEqual(drift["state"], "drift")


class TestUtil(unittest.TestCase):
    def test_iso_round_trip(self):
        for value in ("2026-11-11T03:00:00Z", "2026-11-11T03:00:00.123Z",
                      "2026-11-11T03:00:00+00:00"):
            epoch = util.parse_iso(value)
            self.assertIsNotNone(epoch, value)
            self.assertTrue(util.iso(epoch).startswith("2026-11-11T03:00:00"))

    def test_uuid_from_filename(self):
        self.assertEqual(util.session_uuid_from_filename("/x/2026-11-11T02-00-00-000Z_abc.jsonl"), None)
        self.assertEqual(
            util.session_uuid_from_filename("/x/2026-11-11T02-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl"),
            "11111111-1111-4111-8111-111111111111")

    def test_realpath_makes_two_spellings_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            real = os.path.join(tmp, "real.jsonl")
            with open(real, "w", encoding="utf-8") as fh:
                fh.write("{}\n")
            link = os.path.join(tmp, "link.jsonl")
            os.symlink(real, link)
            self.assertEqual(util.realpath(link), util.realpath(real))


class TestPilAccess(unittest.TestCase):
    """V3: no directory walk. One candidate file, only for an admitted pane."""

    def _write(self, tmp, name, pane):
        import json as _json

        path = os.path.join(tmp, f"{name}.json")
        with open(path, "w", encoding="utf-8") as fh:
            _json.dump({"lane": name, "paneId": pane, "sessionId": "x", "pid": 1}, fh)
        return path

    def test_opens_only_the_named_candidate(self):
        with tempfile.TemporaryDirectory() as tmp:
            wanted = self._write(tmp, "alpha", "w1A:p1")
            self._write(tmp, "held", "w2:p1")
            policy = guard.Policy()
            access = identity.PilAccess(tmp, policy)
            record, problem = access.record_for("w1A:p1", "alpha", "w1A", "w1A:t1")
            self.assertIsNone(problem)
            self.assertEqual(record["paneId"], "w1A:p1")
            self.assertEqual(access.opened, [wanted])

    def test_denied_pane_never_opens_anything(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._write(tmp, "held", "w2:p1")
            policy = guard.Policy()
            access = identity.PilAccess(tmp, policy)
            record, problem = access.record_for("w2:p1", "held", "w2", "w2:t1")
            self.assertIsNone(record)
            self.assertIn("denied", problem)
            self.assertEqual(access.opened, [])

    def test_reserved_tab_denies_even_an_innocent_pane(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._write(tmp, "tabbed", "wE:p99")
            access = identity.PilAccess(tmp, guard.Policy())
            record, problem = access.record_for("wE:p99", "tabbed", "wE", "wE:t19")
            self.assertIsNone(record)
            self.assertEqual(problem, "denied:reserved_tab:wE:t19")
            self.assertEqual(access.opened, [])

    def test_name_hint_resolving_to_another_pane_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._write(tmp, "someone-else", "w1A:p9")
            access = identity.PilAccess(tmp, guard.Policy())
            record, problem = access.record_for("w1A:p1", "someone-else", "w1A", "w1A:t1")
            self.assertIsNone(record)
            self.assertEqual(problem, "pil_record_pane_mismatch")

    def test_no_hint_or_bad_hint_does_not_scan(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._write(tmp, "alpha", "w1A:p1")
            access = identity.PilAccess(tmp, guard.Policy())
            for hint in (None, "", "../escape", ".hidden"):
                record, problem = access.record_for("w1A:p1", hint, "w1A", "w1A:t1")
                self.assertIsNone(record, hint)
            self.assertEqual(access.opened, [])


if __name__ == "__main__":
    unittest.main()
