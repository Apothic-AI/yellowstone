"""The version is stated in two code constants and many prose places. Keep them equal.

A version bump that misses the docs leaves an operator with a `--version` that contradicts
the README they just read — and, worse, a documented ping condition ("tell me when the
version string changes") that can never fire because the string was hardcoded in prose and
never bumped. This test is the guard: every literal `behold X.Y.Z[...]` in the shipped
markdown must equal the code's version, and the two code constants must agree.
"""

from __future__ import annotations

import os
import re
import sys
import unittest

from tests.helpers import ROOT

sys.path.insert(0, ROOT)

from behold import __version__ as code_version  # noqa: E402
from behold import render  # noqa: E402

#: `behold 0.2.0-ft67`, `behold 1.0.0`, ... — the shipped prose spelling.
VERSION_LITERAL = re.compile(r"behold (\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?)")

DOCS = ("README.md", "FIELD-LEDGER.md")


class TestVersionTruth(unittest.TestCase):
    def test_code_constants_agree(self) -> None:
        self.assertEqual(render.VERSION, code_version)
        self.assertRegex(code_version, r"^\d+\.\d+\.\d+")

    def test_documented_versions_match_the_code(self) -> None:
        found = 0
        for name in DOCS:
            path = os.path.join(ROOT, name)
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
            for line_no, line in enumerate(text.splitlines(), 1):
                for match in VERSION_LITERAL.finditer(line):
                    found += 1
                    self.assertEqual(
                        match.group(1), code_version,
                        f"{name}:{line_no} documents behold {match.group(1)} but the code "
                        f"is {code_version}; a stale version string is a false claim")
        self.assertGreater(found, 0, "no documented version literals were found; the guard "
                                    "would pass vacuously")


class TestPublishedIngest(unittest.TestCase):
    """The document's ingest report is bounded, and says how much it omitted."""

    def test_long_refusal_list_is_capped_and_counted(self) -> None:
        from behold.cli import _published_ingest
        ingest = {"files": 980, "written": 7, "refused": [{"pane": f"w:{i}", "reason": "r"} for i in range(953)]}
        published = _published_ingest(ingest)
        self.assertEqual(len(published["refused"]), 5)
        self.assertEqual(published["refused_total"], 953)
        self.assertEqual(published["refused_omitted"], 948)
        # The counts the caller reasons about are untouched.
        self.assertEqual(published["files"], 980)
        self.assertEqual(published["written"], 7)

    def test_short_list_is_published_verbatim(self) -> None:
        from behold.cli import _published_ingest
        ingest = {"refused": [{"pane": "w1:p1", "reason": "reserved_tab:wE:t19"}]}
        self.assertIs(_published_ingest(ingest), ingest)

    def test_absent_ingest_is_passed_through(self) -> None:
        from behold.cli import _published_ingest
        self.assertIsNone(_published_ingest(None))
