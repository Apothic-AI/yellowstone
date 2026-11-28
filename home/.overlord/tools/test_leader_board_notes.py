"""Tests for the leader board's occupancy notes: `occ-Nd` and `live-N%`.

Two things are being pinned here, and they are different claims:

  * the ANNOTATION fires where a decision could change and stays silent everywhere else
    (a stale reading far from the reset line is true and irrelevant, and flagging it would
    turn a third of the board into wallpaper);
  * the FOOTER READ is bounded by that same predicate -- a read gated on the value the
    read produces is not a bound at all, it is "always read every pane". The call count is
    asserted against the flagged count, not the lane count.

Style follows `test_broadcast_to_fleet.py`: import the hyphenated module through
`importlib`, drive `render()` in-process, patch the tool's own seams (`pane_footer`,
`herdr_binary_health`), never touch a real pane.
"""

import contextlib
import importlib.util
import io
import pathlib
import sys
import unittest
from unittest.mock import patch

MODULE_PATH = pathlib.Path(__file__).with_name("leader-board.py")
spec = importlib.util.spec_from_file_location("leader_board", MODULE_PATH)
lb = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = lb
spec.loader.exec_module(lb)

DAY = 86400


def board_row(
    label="demo-leader",
    ctx=None,
    ctx_age=None,
    pane_id="w1:p1",
    status="idle",
    **extra,
):
    """One row shaped like a `collect()` row, with only the fields `render()` reads."""
    row = {
        "workspace": "w1",
        "workspace_label": "demo",
        "tab_id": "w1:t1",
        "label": label,
        "pane_id": pane_id,
        "cwd": "/tmp",
        "status": status,
        "goal": None,
        "goal_elapsed": None,
        "ctx": ctx,
        "session_bytes": 4096,
        "session_age": 5,
        "mode": "leader",
        "profile": "leader",
        "rooms": label,
        "model": "deepseek-v4.1-flash-1017",
        "thinking": "high",
        "why": [],
        "field_states": {},
        "secs": 12,
        "secs_source": "observed",
        "changed": True,
        "resumed_at": None,
        "ctx_age": ctx_age,
    }
    row.update(extra)
    return row


class OccupancyNoteTests(unittest.TestCase):
    def board(self, rows):
        """Run the gate and the renderer; return (stdout, the flagged predicate's reads)."""
        with patch.object(lb, "pane_footer", return_value=(None, "", None, None)) as footer:
            lb.annotate_occupancy(rows, lb.CTX_RESET)
        out = io.StringIO()
        with patch.object(lb, "herdr_binary_health", return_value={"state": "ok", "detail": ""}), \
             contextlib.redirect_stdout(out):
            lb.render(rows, 2700, lb.CTX_RESET)
        return out.getvalue(), footer

    def line_of(self, output, label):
        """The rendered row line carrying `label` (rows are one line each)."""
        for line in output.splitlines():
            if f"w1 " in line + " " and f" {label} " in f"{line} ":
                return line
        raise AssertionError(f"no rendered row for {label} in:\n{output}")

    # (a) stale AND near the decision line -> `occ-Nd`
    def test_stale_reading_near_the_line_is_annotated_with_its_age(self):
        rows = [board_row(ctx=45.44, ctx_age=15 * DAY + 3600)]
        output, footer = self.board(rows)
        line = self.line_of(output, "demo-leader")
        self.assertIn("occ-15d", line, f"expected an age note, got: {line!r}")
        # Nothing was named as a live disagreement: the patched footer yields no reading,
        # and `live-` must never be invented from a missing value.
        self.assertNotIn("live-", line)
        footer.assert_called_once_with("w1:p1")

    # (b) stale but FAR from the line -> nothing at all, and no read
    def test_stale_reading_far_from_the_line_renders_clean(self):
        rows = [board_row(ctx=21.11, ctx_age=47 * DAY + 20 * 3600)]
        output, footer = self.board(rows)
        line = self.line_of(output, "demo-leader")
        self.assertNotIn("occ-", line, f"wallpaper: a 21% lane was annotated ({line!r})")
        self.assertNotIn("live-", line)
        footer.assert_not_called()

    # a fresh reading is never annotated, whatever its distance from the line
    def test_fresh_reading_is_never_annotated(self):
        rows = [board_row(ctx=45.44, ctx_age=270)]
        output, footer = self.board(rows)
        line = self.line_of(output, "demo-leader")
        self.assertNotIn("occ-", line)
        self.assertNotIn("live-", line)
        footer.assert_not_called()

    # the read is attempted once per FLAGGED row, not once per row
    def test_footer_reads_are_bounded_by_the_flagged_count(self):
        rows = [
            board_row(label="near-leader", ctx=45.0, ctx_age=20 * DAY, pane_id="w1:pA"),
            board_row(label="far-leader", ctx=21.0, ctx_age=47 * DAY, pane_id="w1:pB"),
            board_row(label="fresh-leader", ctx=13.7, ctx_age=120, pane_id="w1:pC"),
            board_row(label="line-leader", ctx=52.0, ctx_age=30 * DAY, pane_id="w1:pD"),
        ]
        _output, footer = self.board(rows)
        flagged = sorted(call.args[0] for call in footer.call_args_list)
        self.assertEqual(flagged, ["w1:pA", "w1:pD"], "reads must be the flagged subset only")

    # a reading that DOES differ materially is named beside the age
    def test_live_value_is_named_when_the_footer_disagrees(self):
        rows = [board_row(ctx=41.0, ctx_age=10 * DAY)]
        with patch.object(lb, "pane_footer", return_value=(None, "", None, 47.3)):
            lb.annotate_occupancy(rows, lb.CTX_RESET)
        out = io.StringIO()
        with patch.object(lb, "herdr_binary_health", return_value={"state": "ok", "detail": ""}), \
             contextlib.redirect_stdout(out):
            lb.render(rows, 2700, lb.CTX_RESET)
        line = self.line_of(out.getvalue(), "demo-leader")
        self.assertIn("occ-10d", line)
        self.assertIn("live-47.3%", line)

    # agreement is not a disagreement: the footer's rounding must not produce a note
    def test_live_value_inside_the_agreement_band_is_not_named(self):
        rows = [board_row(ctx=45.44, ctx_age=15 * DAY)]
        with patch.object(lb, "pane_footer", return_value=(None, "", None, 45.4)):
            lb.annotate_occupancy(rows, lb.CTX_RESET)
        out = io.StringIO()
        with patch.object(lb, "herdr_binary_health", return_value={"state": "ok", "detail": ""}), \
             contextlib.redirect_stdout(out):
            lb.render(rows, 2700, lb.CTX_RESET)
        line = self.line_of(out.getvalue(), "demo-leader")
        self.assertIn("occ-15d", line)
        self.assertNotIn("live-", line)

    # --arm lists pane ids and has no notes, so it must not pay for the cross-check either
    def test_arm_mode_reads_no_footers(self):
        rows = [board_row(ctx=45.0, ctx_age=20 * DAY, pane_id="w1:pA")]
        out = io.StringIO()
        with patch.object(sys, "argv", [str(MODULE_PATH), "--arm"]), \
             patch.object(lb, "collect", return_value=rows), \
             patch.object(lb, "load_snapshot", return_value={}), \
             patch.object(lb, "save_snapshot"), \
             patch.object(lb, "pane_footer") as footer, \
             contextlib.redirect_stdout(out):
            self.assertEqual(lb.main(), 0)
        footer.assert_not_called()
        self.assertEqual(out.getvalue().strip(), "w1:pA")

    # the gate's edges are pinned to the documented values, not to whatever the code does
    def test_gate_boundaries(self):
        # age: strictly greater than a day, so exactly one day is still "current"
        self.assertFalse(lb.occupancy_flag(45.0, DAY, "demo-leader", lb.CTX_RESET))
        self.assertTrue(lb.occupancy_flag(45.0, DAY + 1, "demo-leader", lb.CTX_RESET))
        # distance: 10 points below the reset line counts as near it
        self.assertTrue(lb.occupancy_flag(lb.CTX_RESET - 10, 2 * DAY, "demo-leader", lb.CTX_RESET))
        self.assertFalse(
            lb.occupancy_flag(lb.CTX_RESET - 10.01, 2 * DAY, "demo-leader", lb.CTX_RESET)
        )
        # a lane with no reading is never flagged: there is nothing to annotate
        self.assertFalse(lb.occupancy_flag(None, 40 * DAY, "demo-leader", lb.CTX_RESET))

    # a pane that cannot be read costs the note, never the row
    def test_unreadable_footer_keeps_the_age_note_and_does_not_raise(self):
        rows = [board_row(ctx=45.0, ctx_age=9 * DAY)]
        with patch.object(lb, "pane_footer", return_value=(None, "", None, None)) as footer:
            lb.annotate_occupancy(rows, lb.CTX_RESET)
        footer.assert_called_once()
        self.assertIsNone(rows[0].get("ctx_live"))
        out = io.StringIO()
        with patch.object(lb, "herdr_binary_health", return_value={"state": "ok", "detail": ""}), \
             contextlib.redirect_stdout(out):
            lb.render(rows, 2700, lb.CTX_RESET)
        line = self.line_of(out.getvalue(), "demo-leader")
        self.assertIn("occ-9d", line)
        self.assertNotIn("live-", line)


if __name__ == "__main__":
    unittest.main()
