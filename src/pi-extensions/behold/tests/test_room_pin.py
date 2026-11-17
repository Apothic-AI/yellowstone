"""M-5: a pane pin first, then a registry record *verified against the process identity*.

Measured before this: 1 pane pin across 34 live lanes, so M-5 read ``absent`` on 32 lanes whose
own footer said ``rooms: <name>`` — a false absence. The registry holds ``name``/``pid``/``bootId``
per lane, so it can answer, but only on a proven identity: the path is composed from the lane name
(never a directory listing), and pid, boot id and name must all match.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest

from behold import guard
from behold.sources import fleet_state


def _write(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)


class TestRegistryFallback(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="rooms-")
        self.agent = os.path.join(self.tmp, "agent")
        _write(os.path.join(self.agent, "rooms", "names.json"), {"pins": {}})
        self.policy = guard.Policy()

    def _record(self, name: str, pid: int, boot: str) -> None:
        _write(os.path.join(self.agent, "rooms", "registry", f"{name}.json"),
               {"name": name, "pid": pid, "bootId": boot,
                "cwd": "/home/example/project"})

    def test_no_pin_falls_back_to_the_verified_registry_record(self):
        self._record("overlord", 4242, "boot-1")
        pin = fleet_state.room_pin(self.agent, "wE:p1", self.policy, name_hint="overlord",
                                   boot_id="boot-1", pane_proc=4242)
        self.assertEqual(pin["name"], "overlord")
        self.assertEqual(pin["source_kind"], "rooms_registry")
        self.assertIsNone(pin["error"])

    def test_pane_pin_wins_and_says_so(self):
        _write(os.path.join(self.agent, "rooms", "names.json"),
               {"pins": {"pane:wE:p1": {"name": "pinned-name", "procId": "1:R"}}})
        self._record("registry-name", 4242, "boot-1")
        pin = fleet_state.room_pin(self.agent, "wE:p1", self.policy,
                                   name_hint="registry-name", boot_id="boot-1", pane_proc=4242)
        self.assertEqual(pin["name"], "pinned-name")
        self.assertEqual(pin["source_kind"], "pane_pin")

    def test_pid_mismatch_is_refused_and_named(self):
        self._record("overlord", 9999, "boot-1")
        pin = fleet_state.room_pin(self.agent, "wE:p1", self.policy, name_hint="overlord",
                                   boot_id="boot-1", pane_proc=4242)
        self.assertIsNone(pin["name"])
        self.assertEqual(pin["error"], "no_pin_for_pane")
        self.assertEqual(pin["registry_check"], "pid_mismatch")

    def test_boot_mismatch_is_refused(self):
        self._record("overlord", 4242, "another-boot")
        pin = fleet_state.room_pin(self.agent, "wE:p1", self.policy, name_hint="overlord",
                                   boot_id="boot-1", pane_proc=4242)
        self.assertIsNone(pin["name"])
        self.assertEqual(pin["registry_check"], "boot_mismatch")

    def test_no_verified_process_never_accepts_a_registry_name(self):
        self._record("overlord", 4242, "boot-1")
        pin = fleet_state.room_pin(self.agent, "wE:p1", self.policy, name_hint="overlord",
                                   boot_id="boot-1", pane_proc=None)
        self.assertIsNone(pin["name"])
        self.assertEqual(pin["registry_check"], "no_verified_process")

    def test_a_room_file_is_not_a_lane_record(self):
        _write(os.path.join(self.agent, "rooms", "registry", "leaders.json"),
               {"room": "leaders", "members": ["alpha-leader"]})
        pin = fleet_state.room_pin(self.agent, "wE:p1", self.policy, name_hint="leaders",
                                   boot_id="boot-1", pane_proc=4242)
        self.assertIsNone(pin["name"])
        self.assertEqual(pin["registry_check"], "not_a_lane_record")

    def test_an_unsafe_name_is_never_composed_into_a_path(self):
        for name in ("../etc/passwd", ".hidden", "", None):
            pin = fleet_state.room_pin(self.agent, "wE:p1", self.policy, name_hint=name,
                                       boot_id="boot-1", pane_proc=4242)
            self.assertIsNone(pin["name"], name)
            self.assertIn(pin["registry_check"], {"no_lane_name", "unsafe_lane_name"})

    def test_missing_registry_record_is_reported_not_guessed(self):
        pin = fleet_state.room_pin(self.agent, "wE:p1", self.policy, name_hint="nobody",
                                   boot_id="boot-1", pane_proc=4242)
        self.assertIsNone(pin["name"])
        self.assertEqual(pin["registry_check"], "no_registry_record")


if __name__ == "__main__":
    unittest.main()
