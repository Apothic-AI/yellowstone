"""Render surface: JSON and Markdown, arbitrary-property filter and order.

The operator asked for JSON *and* Markdown output with filtering and ordering over any
property. These tests pin that surface, and pin the honesty rules in its text form:
unknown/absent/held are words, never ``0`` or ``-``, and no status value is read as
progress.
"""

from __future__ import annotations

import json
import sys
import unittest

from tests.helpers import FIXTURE_ROOT, ROOT, field, lanes, require_fixtures, roster, roster_json

sys.path.insert(0, ROOT)


class TestJsonSurface(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        require_fixtures()
        cls.doc = roster_json()
        cls.by = lanes(cls.doc)

    def test_envelope(self):
        behold = self.doc["behold"]
        for key in ("version", "generated_at", "as_of", "mode", "snapshot", "paths", "guard",
                    "privacy", "runtime_only_pending", "budget_targets", "lanes", "timings_ms",
                    "wall_ms"):
            self.assertIn(key, behold)
        self.assertEqual(behold["mode"], "derive-on-demand-read-only")
        self.assertTrue(behold["budget_targets"]["note"].startswith("targets"))

    def test_runtime_only_pending_is_explicit(self):
        pending = " ".join(self.doc["behold"]["runtime_only_pending"])
        for needle in ("ttft", "monitor", "bizzy", "extension"):
            self.assertIn(needle, pending.lower())

    def test_global_block_is_separate(self):
        self.assertIn("M-4", self.doc["global"])
        self.assertEqual(self.doc["global"]["M-4"]["scope"], "global_file")

    def test_diagnostics_are_structured(self):
        for item in self.doc["diagnostics"]:
            self.assertIn("lane", item)
            self.assertIn("code", item)


class TestFilterAndSort(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        require_fixtures()

    def test_filter_by_field_value(self):
        doc = roster_json("--filter", "H-5.value.status=working")
        self.assertGreater(len(doc["lanes"]), 0)
        for lane in doc["lanes"]:
            self.assertEqual(field(lane, "H-5")["value"]["status"], "working")
        self.assertLess(len(doc["lanes"]), 61)

    def test_filter_by_state(self):
        doc = roster_json("--filter", "identity.state=no_session_source")
        self.assertEqual([lane["key"] for lane in doc["lanes"]], ["w1C:p2"])

    def test_filter_negation_and_glob(self):
        doc = roster_json("--filter", "H-1.value!=filler-workspace",
                          "--filter", "H-3.value~w1A:*")
        self.assertEqual({lane["key"] for lane in doc["lanes"]}, {"w1A:p1", "w1A:p2"})

    def test_sort_ascending_and_descending(self):
        asc = roster_json("--sort", "P-5.value.path")
        paths = [field(lane, "P-5")["value"]["path"] for lane in asc["lanes"]
                 if field(lane, "P-5")["state"] == "present"]
        self.assertEqual(paths, sorted(paths))
        desc = roster_json("--sort", "T-1.value:desc")
        values = [field(lane, "T-1")["value"] for lane in desc["lanes"]
                  if field(lane, "T-1")["state"] == "present"]
        self.assertEqual(values, sorted(values, reverse=True))

    def test_unknown_values_sort_last(self):
        doc = roster_json("--sort", "T-3.value")
        states = [field(lane, "T-3")["state"] for lane in doc["lanes"]]
        first_unknown = states.index("unknown") if "unknown" in states else len(states)
        self.assertTrue(all(state == "unknown" for state in states[first_unknown:]))

    def test_lane_filter(self):
        doc = roster_json("--lane", "w1A:p1")
        self.assertEqual([lane["key"] for lane in doc["lanes"]], ["w1A:p1"])

    def test_bad_filter_is_a_usage_error(self):
        code, out, err = roster("--filter", "no-operator-here")
        self.assertEqual(code, 2, (out, err))


class TestMarkdownSurface(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        require_fixtures()

    def test_markdown_table_and_pending_sections(self):
        code, out, err = roster("--markdown")
        self.assertEqual(code, 0, err[:2000])
        self.assertIn("# behold roster", out)
        self.assertIn("derived on demand · read-only", out)
        self.assertIn("| lane | workspace | pane | status |", out)
        self.assertIn("## pending runtime-only metrics", out)
        self.assertIn("## budget targets (not measured whole-fleet proof)", out)

    def test_markdown_says_unknown_and_withheld(self):
        code, out, _err = roster("--markdown", "--full")
        self.assertEqual(code, 0)
        self.assertIn("unknown:", out)
        self.assertIn("withheld (class 2)", out)
        # A lane with no session shows unknown fields, never a fabricated zero.
        self.assertIn("## w1C:p2", out)
        self.assertIn("held (", out)

    def test_markdown_details_carry_source_and_method(self):
        code, out, _err = roster("--markdown", "--lane", "w1A:p1")
        self.assertEqual(code, 0)
        self.assertIn("source `", out)
        self.assertIn("method `", out)
        self.assertIn("active branch", out)

    def test_markdown_renders_done_status_verbatim(self):
        # herdr's native `done` is a legitimate observed status; the roster must not sanitize
        # it away, and the forbidden-word rule is about *claims*, not the raw token.
        from behold.sources import herdr
        value, source = herdr.status_value({"agent_status": "done"}, {})
        self.assertEqual(value, "done")

    def test_no_progress_or_completion_claims_in_output(self):
        doc = roster_json()
        # Scan emitted *values* only: behold's own notes legitimately say things like "not a
        # live 'still running' duration", which is a disclaimer, not a claim.
        values = []
        for lane in doc["lanes"]:
            for value in lane["fields"].values():
                if value["value"] is not None:
                    values.append(json.dumps(value["value"], ensure_ascii=False))
        text = " ".join(values).lower()
        banned_phrases = (
            "in progress", "finished", "still running", "healthy", "appears complete",
            "completed successfully", "safe to merge", "idle so", "looks done",
        )
        for phrase in banned_phrases:
            self.assertNotIn(phrase, text, f"roster makes a claim it cannot support: {phrase!r}")
        # ... and the raw observed values that look like progress words are still present,
        # because they are observations, not verdicts.
        self.assertIn('"done"', text)
        self.assertIn('"in_progress"', text)

    def test_markdown_is_stable_between_runs(self):
        first = roster("--markdown")[1]
        second = roster("--markdown")[1]
        strip = lambda text: [line for line in text.splitlines()  # noqa: E731
                              if "generated" not in line and "age" not in line]
        self.assertEqual(strip(first), strip(second))


if __name__ == "__main__":
    unittest.main()
