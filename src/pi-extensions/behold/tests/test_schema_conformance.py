"""The capture path against the installed Herdr schema, and the fixture against both.

What is **schema-backed** and what is **not**:

* *Schema-backed*: the installed herdr's own bundled schema says the session snapshot is
  flat — ``version`` (string), ``protocol`` (integer), and the arrays ``workspaces``,
  ``tabs``, ``panes``, ``layouts``, ``agents`` — with the API's success envelope
  ``{"id", "result"}``. The capture accepts exactly that, and refuses anything else.
* *Not schema-backed*: **what the live binary prints**. The suite never calls the real
  ``herdr api snapshot`` (the snapshot includes held lanes), so whether the binary prints
  the bare document or the envelope is still unverified. Both are handled; the failure
  mode is typed.

``herdr api schema --json`` prints the **bundled** schema, not live state, so reading it
is a static inspection of the installed package — the same kind of read as the pi type
definitions.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

from tests import isolation
from tests.helpers import AS_OF, FIXTURE_ROOT, ROOT, flat_snapshot, fake_herdr_bin

sys.path.insert(0, ROOT)

from behold import cache as cache_mod  # noqa: E402
from behold import cli  # noqa: E402
from behold.sources import herdr_capture  # noqa: E402
from behold.sources import SUPPORTED_HERDR_PROTOCOLS  # noqa: E402

HERDR = shutil.which("herdr")
FIXTURE = os.path.join(ROOT, "fixtures", "herdr_session_snapshot.json")


def installed_schema() -> dict | None:
    """The installed herdr's bundled schema, or None when herdr is not installed.

    This is a static read: ``herdr api schema`` prints the schema the binary ships with.
    It does not read the live fleet.
    """
    if not HERDR:
        return None
    try:
        proc = subprocess.run([HERDR, "api", "schema", "--json"], capture_output=True,
                              text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    try:
        return json.loads(proc.stdout)
    except ValueError:
        return None


def snapshot_definition(schema: dict) -> dict | None:
    defs = ((schema.get("schemas") or {}).get("success_response") or {}).get("$defs") or {}
    return defs.get("SessionSnapshot")


class TestAgainstTheInstalledSchema(unittest.TestCase):
    def setUp(self) -> None:
        self.schema = installed_schema()
        if self.schema is None:
            self.skipTest("the installed herdr (or its bundled schema) is not available")

    def test_the_supported_protocol_is_the_installed_one(self) -> None:
        self.assertEqual(self.schema.get("protocol"), 22)
        self.assertIn(22, SUPPORTED_HERDR_PROTOCOLS)

    def test_the_capture_accepts_exactly_the_schemas_shape(self) -> None:
        definition = snapshot_definition(self.schema)
        self.assertIsNotNone(definition, "the installed schema has no SessionSnapshot")
        required = set(definition.get("required") or [])
        # the capture's flat branch needs these
        for key in ("version", "protocol", "workspaces", "tabs", "panes", "layouts",
                    "agents"):
            self.assertIn(key, required, f"the installed schema no longer requires {key}")
        properties = definition.get("properties") or {}
        self.assertEqual(properties["protocol"].get("type"), "integer")
        self.assertEqual(properties["version"].get("type"), "string")
        for key in ("workspaces", "tabs", "panes", "layouts", "agents"):
            self.assertEqual(properties[key].get("type"), "array")

    def test_the_checked_in_fixture_matches_the_installed_schema(self) -> None:
        with open(FIXTURE, "r", encoding="utf-8") as fh:
            document = json.load(fh)
        definition = snapshot_definition(self.schema)
        properties = definition.get("properties") or {}
        for key in (definition.get("required") or []):
            self.assertIn(key, document, f"the fixture has no {key}")
        for key, spec in properties.items():
            if key not in document:
                continue
            expected = spec.get("type")
            value = document[key]
            if expected == "integer":
                self.assertIsInstance(value, int, key)
            elif expected == "string":
                self.assertIsInstance(value, str, key)
            elif expected == "array":
                self.assertIsInstance(value, list, key)

    def test_a_synthesized_response_in_the_schemas_shape_is_accepted(self) -> None:
        # A document built to the installed schema's required keys, and nothing else:
        # no live binary, no fleet state.
        definition = snapshot_definition(self.schema)
        document = {}
        for key in (definition.get("required") or []):
            spec = (definition.get("properties") or {})[key]
            kind = spec.get("type")
            if kind == "integer":
                document[key] = 22
            elif kind == "string":
                document[key] = "1"
            else:
                document[key] = []
        normalized, notes = herdr_capture.normalize_snapshot(document)
        self.assertEqual(normalized["protocol"], 22)
        self.assertEqual(normalized["agents"], [])
        self.assertEqual(normalized["panes"], [])
        self.assertEqual(notes, [])

    def test_the_envelope_is_part_of_the_installed_schema(self) -> None:
        success = (self.schema.get("schemas") or {}).get("success_response") or {}
        self.assertIn("id", success.get("properties") or {})
        self.assertIn("result", success.get("properties") or {})


class TestFailClosedOnUnexpectedShapes(unittest.TestCase):
    def test_a_missing_protocol_is_refused(self) -> None:
        document = flat_snapshot()
        del document["protocol"]
        with self.assertRaises(herdr_capture.SnapshotShapeError):
            herdr_capture.normalize_snapshot(document)

    def test_an_unsupported_protocol_is_refused_by_the_reader(self) -> None:
        from behold import guard
        from behold.sources import herdr

        with self.assertRaises(Exception) as ctx:
            herdr.parse_document(flat_snapshot(protocol=23), "test", guard.Policy())
        self.assertIn("protocol", str(ctx.exception))

    def test_an_unexpected_shape_is_refused_rather_than_emptied(self) -> None:
        with self.assertRaises(herdr_capture.SnapshotShapeError):
            herdr_capture.normalize_snapshot({"protocol": 22, "something": "else"})

    def test_the_cli_reports_an_unreadable_snapshot(self) -> None:
        # The run is offline (a fixture tree) and the cache is off: the test never reads
        # a live store and never writes the operator's cache.
        with tempfile.TemporaryDirectory() as tmp:
            document = {"protocol": 22, "something": "else"}
            bindir = fake_herdr_bin(tmp, document=document)
            env = isolation.redirect_environment()
            env["PATH"] = bindir + os.pathsep + env.get("PATH", "")
            proc = subprocess.run(
                [sys.executable, os.path.join(ROOT, "bin", "behold"), "roster",
                 "--root", FIXTURE_ROOT, "--as-of", AS_OF, "--herdr", "--cache", "off"],
                capture_output=True, text=True, timeout=120, env=env,
                cwd=ROOT)
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("herdr-unreadable-snapshot", proc.stderr)


class TestCaptureProvenance(unittest.TestCase):
    def test_the_capture_receipt_names_its_moment(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bindir = fake_herdr_bin(tmp, document=flat_snapshot())
            env = isolation.redirect_environment()
            env["PATH"] = bindir + os.pathsep + env.get("PATH", "")
            proc = subprocess.run(
                [sys.executable, os.path.join(ROOT, "bin", "behold"), "roster",
                 "--root", FIXTURE_ROOT, "--as-of", AS_OF, "--herdr", "--cache", "off"],
                capture_output=True, text=True, timeout=120, env=env, cwd=ROOT)
            self.assertEqual(proc.returncode, 0, proc.stderr[:2000])
            document = json.loads(proc.stdout)
            capture = document["behold"]["capture"]
            self.assertTrue(capture["ok"])
            self.assertIsNotNone(capture["captured_at"])
            self.assertIsNotNone(capture["captured_at_epoch"])
            # and the topology block says where the topology came from
            topology = document["behold"]["topology"]
            self.assertEqual(topology["kind"], "live_capture")
            self.assertEqual(topology["captured_at_source"], "capture_clock")
            self.assertFalse(topology["stale"])

    def test_a_file_snapshot_reports_weak_provenance_and_staleness(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "snapshot.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(flat_snapshot(), fh)
            old = time.time() - 3600
            os.utime(path, (old, old))
            proc = subprocess.run(
                [sys.executable, os.path.join(ROOT, "bin", "behold"), "roster",
                 "--snapshot", path, "--as-of", "2026-11-11T03:00:00Z",
                 "--cache", "off"],
                capture_output=True, text=True, timeout=120, cwd=ROOT)
            self.assertEqual(proc.returncode, 0, proc.stderr[:2000])
            document = json.loads(proc.stdout)
            topology = document["behold"]["topology"]
            self.assertEqual(topology["kind"], "snapshot_file")
            self.assertEqual(topology["captured_at_source"], "file_mtime")
            self.assertTrue(topology["stale"])
            self.assertGreater(topology["age_s"], 300)


if __name__ == "__main__":
    unittest.main()
