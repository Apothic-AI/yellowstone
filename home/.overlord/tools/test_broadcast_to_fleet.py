import contextlib
import importlib.util
import io
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

MODULE_PATH = pathlib.Path(__file__).with_name("broadcast-to-fleet.py")
spec = importlib.util.spec_from_file_location("broadcast_to_fleet", MODULE_PATH)
btf = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = btf
spec.loader.exec_module(btf)


class BroadcastToFleetTests(unittest.TestCase):
    def run_main(self, argv, agents, statuses, run_result=(True, ""), compactions=None):
        status_iter = iter(statuses)
        # Default: no lane is compacting. A test that wants a fold supplies `compactions`,
        # and running out of values reads as "clear" so an extra probe cannot hang a test
        # on a StopIteration that would look like a code defect.
        compaction_values = list(compactions or [])
        calls = []

        def fake_run(command, timeout):
            calls.append(tuple(command))
            return run_result

        def fake_compaction(pane, timeout):
            return compaction_values.pop(0) if compaction_values else ""

        output = io.StringIO()
        with patch.object(sys, "argv", [str(MODULE_PATH), *argv]), \
             patch.object(btf, "list_agents", return_value=agents), \
             patch.object(btf, "status_of", side_effect=lambda *_: next(status_iter)), \
             patch.object(btf, "compaction_of", side_effect=fake_compaction), \
             patch.object(btf, "run", side_effect=fake_run), \
             patch.object(btf, "send_slash", side_effect=lambda *a: (calls.append(("reload", a[0])) or (True, "", True))), \
             patch.object(btf.time, "sleep"), \
             contextlib.redirect_stdout(output), \
             contextlib.redirect_stderr(io.StringIO()):
            code = btf.main()
        return code, output.getvalue(), calls

    def test_interrupt_waits_for_idle_before_reload(self):
        agents = [{"pane_id": "w1:p1", "name": "busy", "agent": "pi", "agent_status": "working"}]
        code, output, calls = self.run_main(
            ["-m", "/reload", "--interrupt-working", "--verify"],
            agents, ["working", "idle", "idle"],
        )
        self.assertEqual(code, 0)
        self.assertLess(calls.index(("herdr", "agent", "send-keys", "w1:p1", "esc")),
                        calls.index(("reload", "w1:p1")))
        self.assertIn("verified 1/1", output)
        self.assertTrue(any(call[:3] == ("herdr", "agent", "prompt") for call in calls))

    def test_timeout_fails_closed_without_reload(self):
        agents = [{"pane_id": "w1:p1", "name": "busy", "agent": "pi", "agent_status": "working"}]
        code, output, calls = self.run_main(
            ["-m", "/reload", "--interrupt-working", "--idle-timeout", "0", "--verify"],
            agents, ["working", "working"],
        )
        self.assertEqual(code, 1)
        self.assertFalse(any(call[0] == "reload" for call in calls))
        self.assertIn("1 skipped", output)

    def test_include_self_schedules_deferred_reload_after_other_targets(self):
        agents = [
            {"pane_id": "w1:p1", "name": "self", "agent": "pi", "agent_status": "working"},
            {"pane_id": "w1:p2", "name": "other", "agent": "pi", "agent_status": "idle"},
        ]
        calls = []
        output = io.StringIO()
        with patch.object(sys, "argv", [str(MODULE_PATH), "-m", "/reload", "--include-self", "--interrupt-working", "--verify"]), \
             patch.dict(btf.os.environ, {"HERDR_PANE_ID": "w1:p1"}), \
             patch.object(btf, "list_agents", return_value=agents), \
             patch.object(btf, "status_of", return_value="idle"), \
             patch.object(btf, "compaction_of", return_value=""), \
             patch.object(btf, "send_slash", side_effect=lambda *a: (calls.append(("reload", a[0])) or (True, "", True))), \
             patch.object(btf, "defer_self_reload", side_effect=lambda pane, timeout: calls.append(("defer", pane))), \
             patch.object(btf.time, "sleep"), \
             contextlib.redirect_stdout(output), \
             contextlib.redirect_stderr(io.StringIO()):
            code = btf.main()
        self.assertEqual(code, 0)
        self.assertIn(("reload", "w1:p2"), calls)
        self.assertIn(("defer", "w1:p1"), calls)
        self.assertNotIn(("reload", "w1:p1"), calls)

    def test_deferred_helper_records_success_atomically(self):
        with tempfile.TemporaryDirectory() as directory:
            result_path = pathlib.Path(directory) / "result.json"
            statuses = iter(["working", "idle"])
            with patch.object(btf, "status_of", side_effect=lambda *_: next(statuses)), \
                 patch.object(btf, "compaction_of", return_value=""), \
                 patch.object(btf, "send_slash", return_value=(True, "", True)), \
                 patch.object(btf, "run", return_value=(True, "")), \
                 patch.object(btf.time, "sleep"):
                code = btf.reload_when_idle("w1:p1", timeout=2, result_path=str(result_path))
            self.assertEqual(code, 0)
            result = __import__("json").loads(result_path.read_text())
            self.assertEqual(result["state"], "woken")
            self.assertEqual(result["pane"], "w1:p1")
            self.assertEqual(list(pathlib.Path(directory).iterdir()), [result_path])

    def test_deferred_self_reload_waits_until_idle(self):
        statuses = iter(["working", "idle"])
        calls = []

        def fake_send(*args):
            calls.append(args)
            return True, "", True

        with patch.object(btf, "status_of", side_effect=lambda *_: next(statuses)), \
             patch.object(btf, "compaction_of", return_value=""), \
             patch.object(btf, "send_slash", side_effect=fake_send), \
             patch.object(btf, "run", return_value=(True, "")), \
             patch.object(btf.time, "sleep"):
            code = btf.reload_when_idle("w1:p1", timeout=2)
        self.assertEqual(code, 0)
        self.assertEqual(calls, [("w1:p1", "/reload", btf.DEFAULT_TIMEOUT, "Reloaded")])

    def test_self_deferred_and_other_working_skipped_unless_interrupt(self):
        agents = [
            {"pane_id": "w1:p1", "name": "self", "agent": "pi", "agent_status": "working"},
            {"pane_id": "w1:p2", "name": "other", "agent": "pi", "agent_status": "working"},
        ]
        with patch.dict(btf.os.environ, {"HERDR_PANE_ID": "w1:p1"}):
            for flags, expected in (([], "SKIP  w1:p2"), (["--interrupt-working"], "SEND  w1:p2")):
                code, output, calls = self.run_main(["-m", "/reload", "--include-self", "--dry-run", *flags], agents, [])
                self.assertEqual(code, 0)
                self.assertIn("DEFER w1:p1", output)
                self.assertNotIn("SEND  w1:p1", output)
                self.assertIn(expected, output)
                self.assertEqual(calls, [])

    def test_working_only_excludes_idle_lanes(self):
        agents = [
            {"pane_id": "w1:p1", "name": "busy", "agent": "pi", "agent_status": "working"},
            {"pane_id": "w1:p2", "name": "idle", "agent": "pi", "agent_status": "idle"},
        ]
        code, output, calls = self.run_main(
            ["-m", "/reload", "--working-only", "--dry-run"], agents, [],
        )
        self.assertEqual(code, 0)
        self.assertIn("w1:p1", output)
        self.assertNotIn("w1:p2", output)
        self.assertEqual(calls, [])

    # ---- FT-57: a compaction is not `working`, and must never be interrupted ----

    def test_compaction_of_reads_the_token_a_lane_publishes_while_folding(self):
        with patch.object(btf, "run", return_value=(
                True, '{"result":{"agent":{"tokens":{"compacting":"manual"}}}}')):
            self.assertEqual(btf.compaction_of("w1:p1", 1.0), "manual")

    def test_compaction_of_is_empty_when_the_lane_is_not_folding(self):
        for record in (
            '{"result":{"agent":{}}}',
            '{"result":{"agent":{"tokens":{}}}}',
            '{"result":{"agent":{"tokens":null}}}',
        ):
            with patch.object(btf, "run", return_value=(True, record)):
                self.assertEqual(btf.compaction_of("w1:p1", 1.0), "")

    def test_compaction_of_fails_closed_on_an_unreadable_record(self):
        # "" means clear; "unknown" must not, or a herdr hiccup becomes a reload fired
        # into a fold. This is the same rule as status_of's fail-closed `unknown`.
        for result in ((False, "timeout"), (True, "not json"), (True, "{}")):
            with patch.object(btf, "run", return_value=result):
                self.assertEqual(btf.compaction_of("w1:p1", 1.0), "unknown")

    def test_plan_holds_a_compacting_lane_out_of_targets_and_skipped(self):
        agents = [{"pane_id": "w1:p1", "name": "folding", "agent": "pi",
                   "agent_status": "idle", "tokens": {"compacting": "manual"}}]
        targets, skipped, other, waiting = btf.plan(agents, None, True, False, [])
        self.assertEqual(targets, [])
        self.assertEqual(skipped, [])
        self.assertEqual([w["pane"] for w in waiting], ["w1:p1"])
        self.assertEqual(waiting[0]["compacting"], "manual")

    def test_plan_does_not_classify_a_compacting_lane_as_working(self):
        # herdr reads `working` for a fold that runs inside a turn and `idle` for one that
        # runs outside it. Both must reach the barrier, or --interrupt-working esc's a fold.
        for status in ("working", "idle", "done"):
            agents = [{"pane_id": "w1:p1", "name": "folding", "agent": "pi",
                       "agent_status": status, "tokens": {"compacting": "threshold"}}]
            targets, skipped, _other, waiting = btf.plan(agents, None, True, True, [])
            self.assertEqual(targets, [], status)
            self.assertEqual(skipped, [], status)
            self.assertEqual([w["pane"] for w in waiting], ["w1:p1"], status)

    def test_dry_run_reports_a_compacting_lane_as_wait_not_send(self):
        agents = [{"pane_id": "w1:p1", "name": "folding", "agent": "pi",
                   "agent_status": "idle", "tokens": {"compacting": "manual"}}]
        code, output, calls = self.run_main(["-m", "/reload", "--dry-run"], agents, [])
        self.assertEqual(code, 0)
        self.assertIn("WAIT  w1:p1", output)
        self.assertIn("compacting=manual", output)
        self.assertNotIn("SEND  w1:p1", output)
        self.assertEqual(calls, [])

    def test_a_compacting_lane_is_waited_for_and_then_reloaded(self):
        agents = [{"pane_id": "w1:p1", "name": "folding", "agent": "pi",
                   "agent_status": "idle", "tokens": {"compacting": "manual"}}]
        code, output, calls = self.run_main(
            ["-m", "/reload", "--verify"], agents, ["idle", "idle"],
            compactions=["manual", "", ""],
        )
        self.assertEqual(code, 0)
        self.assertIn("waiting for 1 in-flight compaction", output)
        self.assertIn(("reload", "w1:p1"), calls)

    def test_a_fold_running_at_the_deadline_is_skipped_and_never_interrupted(self):
        agents = [{"pane_id": "w1:p1", "name": "folding", "agent": "pi",
                   "agent_status": "working", "tokens": {"compacting": "manual"}}]
        code, _output, calls = self.run_main(
            ["-m", "/reload", "--interrupt-working", "--verify",
             "--compaction-timeout", "0"],
            agents, [], compactions=["manual", "manual"],
        )
        self.assertEqual(code, 1)
        self.assertFalse(any(c[0] == "reload" for c in calls))
        # esc would ABORT the fold rather than interrupt a turn.
        self.assertFalse(any("esc" in c for c in calls))

    def test_a_fold_that_starts_after_planning_is_caught_before_delivery(self):
        agents = [{"pane_id": "w1:p1", "name": "lane", "agent": "pi",
                   "agent_status": "idle"}]
        code, _output, calls = self.run_main(
            ["-m", "/reload", "--verify"], agents, ["idle"],
            compactions=["manual"],
        )
        self.assertEqual(code, 1)
        self.assertFalse(any(c[0] == "reload" for c in calls))

    def test_deferred_self_reload_waits_for_compaction_even_while_idle(self):
        # Status is already `idle` at the first probe — the fold's whole life reads that
        # way. Only the token distinguishes them, so this pins the token as the gate.
        calls = []
        compactions = iter(["manual", "manual", ""])
        with patch.object(btf, "status_of", return_value="idle"), \
             patch.object(btf, "compaction_of", side_effect=lambda *_: next(compactions)), \
             patch.object(btf, "send_slash",
                          side_effect=lambda *a: (calls.append(a) or (True, "", True))), \
             patch.object(btf, "run", return_value=(True, "")), \
             patch.object(btf.time, "sleep"):
            code = btf.reload_when_idle("w1:p1", timeout=5)
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 1, "the fold must clear before /reload is sent")

    def test_space_is_typed_as_the_space_key_not_a_dropped_literal(self):
        # send-keys silently drops a literal " " argument, which glued
        # `/profile reload` into `/profilereload`, missed the palette, and submitted the
        # text as a user message (2026-11-07). The `space` token is what types a space.
        self.assertEqual(
            btf.type_keys("profile reload"),
            ["p", "r", "o", "f", "i", "l", "e", "space", "r", "e", "l", "o", "a", "d"],
        )
        self.assertNotIn(" ", btf.type_keys("profile reload"))
        self.assertEqual(btf.type_keys("/reload"), ["/", "r", "e", "l", "o", "a", "d"])

    def test_profile_reload_is_refused_before_any_keys(self):
        with patch.object(btf, "run") as run:
            sent, error, _ = btf.send_slash("w1:p1", "/profile reload", 5.0)
        self.assertFalse(sent)
        self.assertIn("refused", error)
        run.assert_not_called()

    def test_send_slash_sends_a_space_token_for_a_two_word_command(self):
        calls = []

        def fake_run(command, timeout):
            calls.append(tuple(command))
            return True, ""

        # No pane output, so the palette never highlights and the command is refused —
        # but the keystrokes are already sent, which is what this pins.
        with patch.object(btf, "run", side_effect=fake_run), \
             patch.object(btf, "read_pane", return_value=""), \
             patch.object(btf.time, "sleep"):
            sent, _err, _confirmed = btf.send_slash("w1:p1", "/some-command argument", 5.0)

        typed = next(
            c for c in calls
            if c[:3] == ("herdr", "agent", "send-keys") and len(c) > 4 and "space" in c
        )
        self.assertIn("space", typed)
        self.assertNotIn(" ", typed)
        self.assertFalse(sent)  # palette never confirmed, so nothing was submitted


if __name__ == "__main__":
    unittest.main()
