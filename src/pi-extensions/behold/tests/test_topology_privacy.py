"""What the shared cache may hold about the topology: the admitted lanes only.

The source review of ``f19e35c`` found that ``Runner.__init__`` cached the topology
*before* it built the admission map, and that ``sanitize_topology`` kept the
workspace, tab and agent metadata without ever seeing the policy. The cached topology
could therefore hold the metadata of a held workspace or a reserved tab — metadata the
roster itself refuses to print.

These tests inspect the **SQLite file** itself, after a real roster run over a
synthetic snapshot: what is in the payload, and what is not. They use synthetic
fixtures only; no live, private or held state is read.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest

from tests.helpers import AS_OF, FIXTURE_ROOT, ROOT

sys.path.insert(0, ROOT)

from behold import admission as admission_mod  # noqa: E402
from behold import cache as cache_mod  # noqa: E402
from behold import cli, guard  # noqa: E402

HELD_WORKSPACE = "w2"
RESERVED_TAB = "wE:t19"
RESERVED_PANE = "wE:t19"
ADMITTED_PANE = "w1A:p1"


def synthetic_topology() -> dict:
    """A flat topology with one admitted lane and every refused shape planted.

    * an admitted workspace, tab, pane and agent;
    * a **held** workspace (``w2``) with its tab, pane and agent;
    * a **reserved tab** (``wE:t19``) with a pane inside it, and the reserved pane id;
    * a pane whose *own* workspace is admitted but whose tab is the reserved one — the
      attribution case: the record does not name the reserved tab as a workspace, but it
      is in that tab.
    """
    return {
        "protocol": 22,
        "workspaces": [
            {"workspace_id": "w1A", "label": "alpha-workspace", "number": 1,
             "tab_count": 1, "pane_count": 1},
            {"workspace_id": HELD_WORKSPACE, "label": "held-workspace-label", "number": 2,
             "tab_count": 1, "pane_count": 1},
            {"workspace_id": "wE", "label": "epsilon-workspace", "number": 3,
             "tab_count": 1, "pane_count": 1},
        ],
        "tabs": [
            {"tab_id": "w1A:t1", "workspace_id": "w1A", "label": "alpha-tab"},
            {"tab_id": "w2:t1", "workspace_id": HELD_WORKSPACE, "label": "held-tab-label"},
            {"tab_id": RESERVED_TAB, "workspace_id": "wE", "label": "reserved-tab-label"},
        ],
        "panes": [
            {"pane_id": ADMITTED_PANE, "workspace_id": "w1A", "tab_id": "w1A:t1",
             "label": "alpha-pane"},
            {"pane_id": "w2:p1", "workspace_id": HELD_WORKSPACE, "tab_id": "w2:t1",
             "label": "held-pane-label"},
            {"pane_id": "wE:p99", "workspace_id": "wE", "tab_id": RESERVED_TAB,
             "label": "pane-in-the-reserved-tab"},
            {"pane_id": "wE:p98", "workspace_id": "w1A", "tab_id": RESERVED_TAB,
             "label": "admitted-workspace-pane-in-the-reserved-tab"},
            {"pane_id": RESERVED_PANE, "workspace_id": "wE", "tab_id": RESERVED_TAB,
             "label": "reserved-pane-label"},
        ],
        "agents": [
            {"pane_id": ADMITTED_PANE, "workspace_id": "w1A", "tab_id": "w1A:t1",
             "agent": "pi", "cwd": "/tmp/alpha", "name": "alpha-agent"},
            {"pane_id": "w2:p1", "workspace_id": HELD_WORKSPACE, "tab_id": "w2:t1",
             "agent": "pi", "cwd": "/tmp/held", "name": "held-agent"},
            {"pane_id": "wE:p99", "workspace_id": "wE", "tab_id": RESERVED_TAB,
             "agent": "pi", "cwd": "/tmp/reserved", "name": "reserved-agent"},
            {"pane_id": "wE:p98", "workspace_id": "w1A", "tab_id": RESERVED_TAB,
             "agent": "pi", "cwd": "/tmp/reserved-tab", "name": "reserved-tab-agent"},
        ],
    }


def build_admission(document: dict) -> admission_mod.AdmissionMap:
    """The map the roster would build from this topology and the policy."""
    panes = list(document.get("panes", [])) + list(document.get("agents", []))
    return admission_mod.build_map(policy=guard.Policy(), panes=panes,
                                   topology_revision="privacy-test")


class TestTheCachedTopology(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name
        self.db_path = os.path.join(self.tmp, "cache", "behold.db")
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self.addCleanup(self._tmp.cleanup)

    def cached_payload(self) -> dict:
        """Read the topology payload straight out of the SQLite file."""
        conn = sqlite3.connect(self.db_path)
        try:
            row = conn.execute(
                "SELECT payload_json FROM herdr_snapshot_current WHERE id = 1").fetchone()
        finally:
            conn.close()
        if row is None:
            return {}
        return json.loads(row[0])

    def run_roster(self, document: dict | None) -> dict:
        """Run the roster over a synthetic topology and cache the result.

        The topology is planted in a throwaway fixture tree, so the run reads nothing
        but the synthetic file and its own temporary cache.
        """
        root = os.path.join(self.tmp, "root")
        os.makedirs(os.path.join(root, "herdr"), exist_ok=True)
        if document is not None:
            with open(os.path.join(root, "herdr", "snapshot.json"), "w",
                      encoding="utf-8") as fh:
                json.dump(document, fh)
        argv = ["roster", "--root", root, "--as-of", AS_OF,
                "--cache", "on", "--cache-db", self.db_path]
        import contextlib
        import io

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = cli.main(argv)
        self.assertEqual(code, 0, buffer.getvalue()[:2000])
        return json.loads(buffer.getvalue())

    def test_the_cached_topology_holds_no_held_or_reserved_metadata(self) -> None:
        document = synthetic_topology()
        self.run_roster(document)
        payload = self.cached_payload()
        blob = json.dumps(payload)
        self.assertTrue(payload, "nothing was cached at all: the positive control is gone")

        # the admitted lane survives: the cache is still useful
        self.assertIn(ADMITTED_PANE, blob)
        self.assertIn("alpha-workspace", blob)
        self.assertIn("alpha-tab", blob)
        self.assertIn("alpha-pane", blob)
        self.assertIn("alpha-agent", blob)

        # the held workspace, its tab, its pane and its agent do not
        for needle in (HELD_WORKSPACE, "held-workspace-label", "held-tab-label",
                       "held-pane-label", "held-agent", "/tmp/held"):
            self.assertNotIn(needle, blob, needle)

        # the reserved tab, its label, the panes in it and their agents do not
        for needle in (RESERVED_TAB, "reserved-tab-label",
                       "pane-in-the-reserved-tab", "reserved-pane-label", "reserved-agent",
                       "admitted-workspace-pane-in-the-reserved-tab",
                       "reserved-tab-agent"):
            self.assertNotIn(needle, blob, needle)

        # and the sections that survive hold only the admitted records
        self.assertEqual([p["pane_id"] for p in payload.get("panes", [])], [ADMITTED_PANE])
        self.assertEqual([t["tab_id"] for t in payload.get("tabs", [])], ["w1A:t1"])
        self.assertEqual([a["pane_id"] for a in payload.get("agents", [])], [ADMITTED_PANE])

        # The workspace that merely *hosts* the reserved tab is not itself denied: the
        # policy holds a workspace, a tab and a pane, and it names them. `wE` is not one
        # of them, so its own record stays -- and it names no tab, so it carries no
        # reserved metadata. The filter is per handle, not a neighbourhood.
        self.assertEqual([w["workspace_id"] for w in payload.get("workspaces", [])],
                         ["w1A", "wE"])
        self.assertNotIn("reserved-tab-label", blob)

    def test_the_roster_itself_refuses_the_same_lanes(self) -> None:
        # The roster's own output is the positive control: a refused lane is still
        # listed, but every one of its fields is held, so no label, status, cwd or path
        # of a held lane or a reserved tab reaches the output either.
        document = synthetic_topology()
        doc = self.run_roster(document)
        lanes = {lane["key"]: lane for lane in doc["lanes"]}
        self.assertIn(ADMITTED_PANE, lanes)

        held_pane = lanes["w2:p1"]["fields"]
        self.assertTrue(held_pane)
        self.assertTrue(all(field["state"] == "held" for field in held_pane.values()),
                        "a held lane leaked a field: " + json.dumps(held_pane)[:400])
        self.assertTrue(any("held_workspace:w2" in (field.get("reason") or "")
                            for field in held_pane.values()))

        reserved_pane = lanes["wE:p99"]["fields"]
        self.assertTrue(all(field["state"] == "held" for field in reserved_pane.values()),
                        "a reserved-tab lane leaked a field: " + json.dumps(reserved_pane)[:400])
        self.assertTrue(any("reserved_tab:wE:t19" in (field.get("reason") or "")
                            for field in reserved_pane.values()))

        # the admitted lane is not held: the filter did not simply refuse everything
        admitted = lanes[ADMITTED_PANE]["fields"]
        self.assertTrue(any(field["state"] != "held" for field in admitted.values()))

    def test_an_unidentifiable_record_is_not_persisted(self) -> None:
        # A record that cannot say what it is cannot be checked against the holds.
        # These records carry held-looking labels, and their identifiers are missing
        # or malformed: none of them may be persisted.
        document = synthetic_topology()
        document["workspaces"] += [
            {"label": "helded-workspace-label"},                      # no id at all
            {"workspace_id": "w2 ", "label": "helded-workspace-space"},
            {"workspace_id": "W2", "label": "helded-workspace-case"},
            {"workspace_id": "held workspace", "label": "helded-workspace-words"},
            {"workspace_id": 7, "label": "helded-workspace-number"},
        ]
        document["tabs"] += [
            {"workspace_id": "w1A", "label": "helded-tab-label"},     # no tab id
            {"tab_id": "w2 ", "workspace_id": "w1A", "label": "helded-tab-space"},
            {"tab_id": "w2:t1", "label": "helded-tab-noworkspace"},   # no workspace id
            {"tab_id": "w2:t1", "workspace_id": "w2 ", "label": "helded-tab-badworkspace"},
            {"tab_id": "w2:t1", "workspace_id": "w1A", "label": "helded-tab-contradiction"},
        ]
        document["panes"] += [
            {"label": "helded-pane-label"},                           # no pane id
            {"pane_id": "w2", "workspace_id": "w1A", "label": "helded-pane-shape"},
            {"pane_id": "w2:p1", "workspace_id": "w1A", "label": "helded-pane-contradiction"},
            {"pane_id": "w1A:p9", "tab_id": "w2:t1", "label": "helded-pane-badtab"},
        ]
        self.run_roster(document)
        blob = json.dumps(self.cached_payload())
        for needle in ("helded-workspace-label", "helded-workspace-space",
                       "helded-workspace-case", "helded-workspace-words",
                       "helded-workspace-number", "helded-tab-label",
                       "helded-tab-space", "helded-tab-noworkspace",
                       "helded-tab-badworkspace", "helded-tab-contradiction",
                       "helded-pane-label", "helded-pane-shape",
                       "helded-pane-contradiction", "helded-pane-badtab"):
            self.assertNotIn(needle, blob, needle)
        # and the malformed ids themselves are not persisted either
        for needle in ('"w2 "', '"W2"', '"held workspace"'):
            self.assertNotIn(needle, blob, needle)
        # the positive control: the admitted lane is untouched
        self.assertIn(ADMITTED_PANE, blob)
        self.assertIn("alpha-workspace", blob)

    def test_a_malformed_topology_stores_no_metadata(self) -> None:
        # A document with no sections at all: the protocol is kept, nothing else is.
        self.run_roster({"protocol": 22})
        payload = self.cached_payload()
        self.assertEqual(payload, {"protocol": 22})

    def test_a_missing_topology_stores_no_metadata(self) -> None:
        # No document at all: the roster has no topology, so it refuses the run and
        # nothing is written to the cache.
        root = os.path.join(self.tmp, "empty-root")
        os.makedirs(os.path.join(root, "herdr"), exist_ok=True)
        import contextlib
        import io

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = cli.main(["roster", "--root", root, "--as-of", AS_OF,
                             "--cache", "on", "--cache-db", self.db_path])
        self.assertNotEqual(code, 0)
        self.assertEqual(self.cached_payload(), {})

    def test_without_a_policy_and_a_map_the_filter_fails_closed(self) -> None:
        # The funnel itself: no policy and no map means no way to tell an admitted
        # record from a held one, so no record is kept.
        document = synthetic_topology()
        clean = cache_mod.sanitize_topology(document)
        self.assertEqual(clean, {"protocol": 22})
        # and with both, the admitted lane survives
        clean = cache_mod.sanitize_topology(document, policy=guard.Policy(),
                                            admission=build_admission(document))
        self.assertIn(ADMITTED_PANE, json.dumps(clean))
        self.assertNotIn(HELD_WORKSPACE, json.dumps(clean))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
