"""G-1/G-2 against the live pi-goal store shape, and the shapes older stores write.

The live store is ``customType: "goal-state"``, ``data.goal`` = one object (with ``status``,
``iteration``, ``timeUsedSeconds``, ``tokensUsed``) or explicit ``null``. behold summarised only
``data.goals``/``data.queue``, so a lane with a real goal read ``present`` with
``{count: null, by_status: {}}`` — an unknown wearing presence, and the leader board could not tell
"paused" from "no goal". ``null`` also has to be ``absent``, never ``0``.
"""

from __future__ import annotations

import json
import unittest

from behold.session import _custom_summary

GOAL_TEXT = "SENTINEL_GOAL_TEXT"


def summary(data) -> dict:
    return _custom_summary("goal-state", data)["goal"]


class TestLiveSingleGoalShape(unittest.TestCase):
    def test_active_goal_carries_status_iteration_and_elapsed(self):
        out = summary({"goal": {"id": "g", "text": GOAL_TEXT, "status": "active",
                                "iteration": "27", "tokensUsed": "327759891",
                                "timeUsedSeconds": "30154.44", "baselineTokens": "818837"}})
        self.assertEqual(out["shape"], "single")
        self.assertEqual(out["count"], 1)
        self.assertEqual(out["statuses"], {"active": 1})
        self.assertEqual(out["status"], "active")
        self.assertEqual(out["goal"]["iteration"], 27.0)
        self.assertEqual(out["goal"]["tokensUsed"], 327759891.0)
        self.assertEqual(out["goal"]["timeUsedSeconds"], 30154.44)

    def test_paused_is_a_state_not_a_count(self):
        out = summary({"goal": {"status": "paused", "iteration": "28"}})
        self.assertEqual(out["status"], "paused")
        self.assertEqual(out["statuses"], {"paused": 1})

    def test_explicit_null_is_no_active_goal(self):
        out = summary({"goal": None})
        self.assertTrue(out["no_active_goal"])
        self.assertEqual(out["shape"], "absent")

    def test_goal_text_never_reaches_the_summary(self):
        out = summary({"goal": {"status": "active", "text": GOAL_TEXT}})
        self.assertNotIn(GOAL_TEXT, json.dumps(out))

    def test_absent_counters_are_omitted_not_zero(self):
        out = summary({"goal": {"status": "active"}})
        self.assertEqual(out["goal"], {})


class TestLegacyListShape(unittest.TestCase):
    def test_goals_list_still_counts_by_status(self):
        out = summary({"goals": [{"status": "active"}, {"status": "queued"}],
                       "queue": [{"status": "queued"}]})
        self.assertEqual(out["shape"], "list")
        self.assertEqual(out["count"], 2)
        self.assertEqual(out["statuses"], {"active": 1, "queued": 1})
        self.assertEqual(out["queue_depth"], 1)

    def test_text_only_store_stays_unknown(self):
        out = summary({"goals": "just some prose about a goal"})
        self.assertTrue(out["text_only"])
        self.assertEqual(out["statuses"], {})


class TestRenderedAbsence(unittest.TestCase):
    """A null goal renders as absent, and the roster says so per lane."""

    def test_fixture_null_goal_is_absent_not_zero(self):
        from tests.helpers import field, lanes, require_fixtures, roster_json
        require_fixtures()
        doc = roster_json()
        absent = [(k, lane) for k, lane in lanes(doc).items()
                  if field(lane, "G-1")["state"] == "absent"]
        self.assertTrue(absent, "expected at least one lane with no goal store entry")
        key, lane = absent[0]
        g1 = field(lane, "G-1")
        self.assertIsNone(g1["value"])
        self.assertTrue(g1.get("reason"), f"{key} must explain its absence")


if __name__ == "__main__":
    unittest.main()
