"""A session file whose header id contradicts its filename has its own identity state.

Measured 2026-11-25 (comms-leader, starla-leader, subtoken-leader): pi was handed an explicit
--session path that did not exist; it minted a fresh id and kept the path, so the lazy first
write materialised <old-name>.jsonl carrying a different header id. The reporter was truthful
and the file is internally inconsistent: it is not a "stale pin", and saying so sent readers
looking for a newer session. These tests pin the dedicated state, with and without a fallback.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest

from behold import guard, identity


def _write_session(directory: str, filename: str, header_id: str) -> str:
    path = os.path.join(directory, filename)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "type": "session",
            "version": 3,
            "id": header_id,
            "timestamp": "2026-11-25T20:17:45.044Z",
            "cwd": "/tmp",
        }) + "\n")
        fh.write(json.dumps({
            "type": "message",
            "id": "e1",
            "timestamp": "2026-11-25T20:17:46.000Z",
            "message": {"role": "user", "content": "hi"},
        }) + "\n")
    return path


class PinHeaderFilenameMismatch(unittest.TestCase):
    PIN_UUID = "01a21183-945d-7000-8000-000000000001"
    HEADER_UUID = "01a213b0-9ce4-7000-8000-000000000002"
    RECORD_UUID = "01a2145b-6a54-7000-8000-000000000003"

    def _agent(self, pin_path: str) -> dict:
        return {
            "pane_id": "w9:p9",
            "workspace_id": "w9",
            "tab_id": "p1",
            "agent_session": {"value": pin_path, "seq": 7, "reporter_pid": None},
        }

    def test_mismatch_with_a_usable_record_is_named_and_falls_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            sessions = os.path.join(tmp, "sessions")
            pil_dir = os.path.join(tmp, "pil")
            os.makedirs(sessions)
            os.makedirs(pil_dir)
            pin = _write_session(
                sessions, f"2026-11-25T07-02-45-000Z_{self.PIN_UUID}.jsonl", self.HEADER_UUID)
            record = _write_session(
                sessions, f"2026-11-25T20-17-45-044Z_{self.RECORD_UUID}.jsonl", self.RECORD_UUID)
            with open(os.path.join(pil_dir, "lane-x.json"), "w", encoding="utf-8") as fh:
                json.dump({"paneId": "w9:p9", "session": record,
                           "sessionId": self.RECORD_UUID}, fh)
            policy = guard.Policy()
            ident = identity.resolve(
                self._agent(pin),
                policy=policy,
                pil=identity.PilAccess(pil_dir, policy),
                proc_root="/proc",
                name_hint="lane-x",
            )

        self.assertEqual(ident.state, identity.PIN_HEADER_FILENAME_MISMATCH_USED_PIL)
        self.assertEqual(ident.session_id, self.RECORD_UUID)
        self.assertFalse(ident.trusted)
        note = ident.note or ""
        # Both ids are named: the filename's uuid and the id the file actually claims.
        self.assertIn(self.PIN_UUID, note)
        self.assertIn(self.HEADER_UUID, note)
        self.assertIn("filename", note)
        self.assertIn("lane record", ident.session_source)

    def test_mismatch_without_a_record_is_its_own_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            sessions = os.path.join(tmp, "sessions")
            os.makedirs(sessions)
            pin = _write_session(
                sessions, f"2026-11-25T07-02-45-000Z_{self.PIN_UUID}.jsonl", self.HEADER_UUID)
            policy = guard.Policy()
            ident = identity.resolve(
                self._agent(pin),
                policy=policy,
                pil=identity.PilAccess(None, policy),
                proc_root="/proc",
                name_hint="lane-x",
            )

        self.assertEqual(ident.state, identity.PIN_HEADER_FILENAME_MISMATCH)
        self.assertIsNone(ident.session)
        self.assertIsNone(ident.session_id)
        self.assertFalse(ident.trusted)
        note = ident.note or ""
        self.assertIn(self.PIN_UUID, note)
        self.assertIn(self.HEADER_UUID, note)
        self.assertNotIn("stale", note.lower())

    def test_a_self_consistent_pin_is_not_mismatched(self):
        # Control: the same fixture with a matching header keeps the ordinary path, so the new
        # state cannot fire on healthy lanes.
        with tempfile.TemporaryDirectory() as tmp:
            sessions = os.path.join(tmp, "sessions")
            os.makedirs(sessions)
            pin = _write_session(
                sessions, f"2026-11-25T20-17-45-044Z_{self.RECORD_UUID}.jsonl", self.RECORD_UUID)
            policy = guard.Policy()
            ident = identity.resolve(
                self._agent(pin),
                policy=policy,
                pil=identity.PilAccess(None, policy),
                proc_root="/proc",
                name_hint="lane-x",
            )
        self.assertNotIn(ident.state, (identity.PIN_HEADER_FILENAME_MISMATCH,
                                       identity.PIN_HEADER_FILENAME_MISMATCH_USED_PIL))
        self.assertEqual(ident.state, identity.PIN_ONLY_UNVERIFIED)


if __name__ == "__main__":
    unittest.main()
