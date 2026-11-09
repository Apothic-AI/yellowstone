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
    def run_main(self, argv, agents, statuses, run_result=(True, "")):
        status_iter = iter(statuses)
        calls = []

        def fake_run(command, timeout):
            calls.append(tuple(command))
            return run_result

        output = io.StringIO()
        with patch.object(sys, "argv", [str(MODULE_PATH), *argv]), \
             patch.object(btf, "list_agents", return_value=agents), \
             patch.object(btf, "status_of", side_effect=lambda *_: next(status_iter)), \
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
            ["-m", "/reload", "--interrupt-working", "--idle-timeout", "0"],
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
        with patch.object(sys, "argv", [str(MODULE_PATH), "-m", "/reload", "--include-self", "--interrupt-working"]), \
             patch.dict(btf.os.environ, {"HERDR_PANE_ID": "w1:p1"}), \
             patch.object(btf, "list_agents", return_value=agents), \
             patch.object(btf, "status_of", return_value="idle"), \
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
             patch.object(btf, "send_slash", side_effect=fake_send), \
             patch.object(btf, "run", return_value=(True, "")), \
             patch.object(btf.time, "sleep"):
            code = btf.reload_when_idle("w1:p1", timeout=2)
        self.assertEqual(code, 0)
        self.assertEqual(calls, [("w1:p1", "/reload", btf.DEFAULT_TIMEOUT, "Reloaded")])

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
            sent, _err, _confirmed = btf.send_slash("w1:p1", "/profile reload", 5.0)

        typed = next(
            c for c in calls
            if c[:3] == ("herdr", "agent", "send-keys") and len(c) > 4 and "p" in c[4:] and "space" in c
        )
        self.assertIn("space", typed)
        self.assertNotIn(" ", typed)
        self.assertFalse(sent)  # palette never confirmed, so nothing was submitted


if __name__ == "__main__":
    unittest.main()
