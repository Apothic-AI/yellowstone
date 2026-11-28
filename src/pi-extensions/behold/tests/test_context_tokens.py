"""T-1 measures the newest assistant record that *actually* carries usage.

A ``context_edit`` turn writes an assistant message whose ``usage`` object is present but
all-zero. The reading used to test the truthiness of that dict, so the synthetic record
became "the last measurement" and T-1 (hence T-3 and the board's ``occ%``) reported 0.0%
for a lane that was at 37-40%. A zero total is not a measurement: the reading is the
newest assistant record with a non-zero total, and when every record on the branch is zero
the field stays absent (``None, None, None``) exactly as before.

These four cases pin the skip predicate and its timestamp, the absent fallback, the
unchanged ordinary path, and the ``totalTokens``-missing sum fallback *inside* the
predicate -- a predicate that looked only at ``totalTokens`` would discard a real record.

The defect is intermittent by construction (the reading is wrong only while a zero record
is newest), so every case here CONSTRUCTS the zero-newest state deliberately instead of
relying on incidental ordering in a fixture. The session files are written in pi's own
format (``type: session`` header, then entries linked by ``id``/``parentId``) and read
through ``session.load``, so the parser's own handling of an all-zero usage object is part
of what is tested.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

from tests.helpers import ROOT

sys.path.insert(0, ROOT)

from behold import guard, session  # noqa: E402

UUID = "bbbbbbbb-0000-4000-8000-000000000002"

#: What a synthetic ``context_edit`` turn records: the shape, with nothing measured.
ZERO = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0}


def _assistant(ts: str, usage: dict[str, float]) -> dict:
    return {
        "type": "message",
        "timestamp": ts,
        "message": {"role": "assistant", "content": [], "usage": usage, "stopReason": "stop"},
    }


def _context_edit(ts: str) -> dict:
    return {"type": "context_edit", "timestamp": ts}


def read(*records: dict) -> session.SessionView:
    """Write the records as one linear session branch and read the view back."""
    with tempfile.TemporaryDirectory(prefix="context-tokens-") as tmp:
        path = os.path.join(tmp, f"2026-11-12T00-00-00-000Z_{UUID}.jsonl")
        lines = [{"type": "session", "version": 3, "id": UUID,
                  "timestamp": "2026-11-12T00:00:00Z", "cwd": "/tmp/lane"}]
        parent = None
        for index, record in enumerate(records):
            entry = {"id": f"e{index:04d}", "parentId": parent, **record}
            lines.append(entry)
            parent = entry["id"]
        with open(path, "w", encoding="utf-8") as handle:
            for line in lines:
                handle.write(json.dumps(line) + "\n")
        return session.load(path, guard.Policy())


class TestContextTokens(unittest.TestCase):
    def test_a_zero_usage_record_does_not_replace_the_last_real_reading(self) -> None:
        # The reported situation: a real reading, then a context_edit turn's all-zero record.
        view = read(
            _assistant("2026-11-12T00:01:00Z",
                       {"input": 30000, "output": 800, "cacheRead": 9000,
                        "cacheWrite": 0, "totalTokens": 39800}),
            _assistant("2026-11-12T00:02:00Z",
                       {"input": 31000, "output": 700, "cacheRead": 10000,
                        "cacheWrite": 0, "totalTokens": 41700}),
            _context_edit("2026-11-12T00:03:00Z"),
            _assistant("2026-11-12T00:04:00Z", dict(ZERO)),
        )
        # The OLDER record's value and the OLDER record's timestamp.
        self.assertEqual(view.context_tokens(),
                         (41700.0, "2026-11-12T00:02:00Z", 1794441720.0))

    def test_a_branch_with_only_zero_usage_stays_absent(self) -> None:
        view = read(
            _context_edit("2026-11-12T00:01:00Z"),
            _assistant("2026-11-12T00:02:00Z", dict(ZERO)),
        )
        self.assertEqual(view.context_tokens(), (None, None, None))

    def test_an_ordinary_branch_is_unchanged(self) -> None:
        view = read(
            _assistant("2026-11-12T00:01:00Z",
                       {"input": 100, "output": 10, "cacheRead": 0,
                        "cacheWrite": 0, "totalTokens": 110}),
            _assistant("2026-11-12T00:02:00Z",
                       {"input": 30000, "output": 900, "cacheRead": 11000,
                        "cacheWrite": 100, "totalTokens": 42000}),
        )
        self.assertEqual(view.context_tokens(),
                         (42000.0, "2026-11-12T00:02:00Z", 1794441720.0))

    def test_the_sum_fallback_also_decides_whether_a_record_is_a_measurement(self) -> None:
        # No totalTokens key at all: 5000 + 0 + 20000 + 0 is a real reading, so it must
        # survive both the skip predicate and the returned value.
        view = read(
            _assistant("2026-11-12T00:01:00Z",
                       {"input": 5000, "output": 0, "cacheRead": 20000, "cacheWrite": 0}),
            _assistant("2026-11-12T00:02:00Z", dict(ZERO)),
        )
        self.assertEqual(view.context_tokens(),
                         (25000.0, "2026-11-12T00:01:00Z", 1794441660.0))


if __name__ == "__main__":
    unittest.main()
