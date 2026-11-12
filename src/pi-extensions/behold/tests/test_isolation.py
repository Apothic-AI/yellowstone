"""Planted negative tests for the suite's isolation.

The last tranche's live-mode tests created a real cache database and read the machine's
derived stores. Environment variables alone would not have caught that, so the isolation
is a **mechanism** that refuses, and this file proves it by trying to break it:

* a path under the **real** home cannot be opened, created, renamed or removed;
* the **real** herdr cannot be spawned for a capture;
* a roster run that is not synthetic and explicit is refused;
* a Python **child** inherits the same refusals, through its ``sitecustomize``;
* and the suite's own default cache path resolves **into the sandbox**.

Every test here is negative on purpose: they assert that an attempt fails.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest

from tests import isolation
from tests.helpers import ROOT

from behold import cache as cache_mod  # noqa: E402
from behold import cli  # noqa: E402


class TestTheGuardRefusesTheRealHome(unittest.TestCase):
    def test_the_real_home_is_not_the_sandbox(self) -> None:
        self.assertNotEqual(isolation.REAL_HOME, isolation.SANDBOX)
        self.assertTrue(isolation.REAL_HOME.startswith("/"))

    def test_opening_a_path_under_the_real_home_is_refused(self) -> None:
        target = os.path.join(isolation.REAL_HOME, ".local", "state", "behold", "behold.db")
        with self.assertRaises(isolation.IsolationError) as ctx:
            open(target, "rb")  # noqa: SIM115 - the refusal is the assertion
        self.assertIn("real home", str(ctx.exception))

    def test_creating_a_directory_under_the_real_home_is_refused(self) -> None:
        target = os.path.join(isolation.REAL_HOME, ".local", "state",
                               "behold-isolation-should-not-exist")
        with self.assertRaises(isolation.IsolationError):
            os.makedirs(target, exist_ok=True)

    def test_removing_or_renaming_under_the_real_home_is_refused(self) -> None:
        target = os.path.join(isolation.REAL_HOME, ".local", "state")
        with self.assertRaises(isolation.IsolationError):
            os.remove(target)
        with self.assertRaises(isolation.IsolationError):
            os.rename(target, target + ".moved")

    def test_the_repository_and_the_sandbox_are_still_writable(self) -> None:
        # The guard must not be a blanket refusal: the suite's own scratch space works.
        with tempfile.TemporaryDirectory(dir=isolation.SANDBOX) as tmp:
            path = os.path.join(tmp, "ok.txt")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("fine")
            with open(path, "r", encoding="utf-8") as fh:
                self.assertEqual(fh.read(), "fine")


class TestTheGuardRefusesALiveCapture(unittest.TestCase):
    def test_the_real_herdr_cannot_be_spawned_for_a_capture(self) -> None:
        real = isolation.which_real_herdr()
        if real is None:
            self.skipTest("herdr is not installed on this machine")
        with self.assertRaises(isolation.IsolationError) as ctx:
            subprocess.run([real, "api", "snapshot"], capture_output=True, timeout=60)
        self.assertIn("herdr", str(ctx.exception))

    def test_a_herdr_spawn_outside_the_sandbox_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fake = os.path.join(tmp, "herdr")
            with open(fake, "w", encoding="utf-8") as fh:
                fh.write("#!/bin/sh\nexit 0\n")
            os.chmod(fake, 0o755)
            with self.assertRaises(isolation.IsolationError):
                subprocess.run([fake, "api", "snapshot"], capture_output=True, timeout=60)

    def test_a_spawn_naming_a_real_home_path_is_refused(self) -> None:
        with self.assertRaises(isolation.IsolationError) as ctx:
            subprocess.run(["/bin/echo", os.path.join(isolation.REAL_HOME, ".pi")],
                           capture_output=True, timeout=60)
        self.assertIn("real home", str(ctx.exception))

    def test_the_bundled_schema_read_is_allowed(self) -> None:
        # `herdr api schema` prints the schema the binary ships with: a static read, not
        # the fleet. It is the one real-binary call the suite may make.
        real = isolation.which_real_herdr()
        if real is None:
            self.skipTest("herdr is not installed on this machine")
        isolation.check_argv([real, "api", "schema", "--json"])


class TestTheGuardRefusesALiveRosterRun(unittest.TestCase):
    def test_a_roster_run_without_a_root_is_refused(self) -> None:
        with self.assertRaises(isolation.IsolationError) as ctx:
            cli.main(["roster"])
        self.assertIn("--root", str(ctx.exception))

    def test_a_roster_run_without_a_cache_decision_is_refused(self) -> None:
        with self.assertRaises(isolation.IsolationError) as ctx:
            cli.main(["roster", "--root", "/tmp/whatever"])
        self.assertIn("--cache", str(ctx.exception))

    def test_a_synthetic_roster_run_is_allowed(self) -> None:
        # The rule is narrow: a synthetic root with an explicit cache decision passes.
        isolation.check_roster_argv(["roster", "--root", "/tmp/fixture", "--cache", "off"])


class TestTheChildInheritsTheGuard(unittest.TestCase):
    def test_a_python_child_cannot_open_the_real_home(self) -> None:
        script = (
            "import sys\n"
            "try:\n"
            f"    open({os.path.join(isolation.REAL_HOME, '.local', 'state', 'behold', 'behold.db')!r}, 'rb')\n"
            "except Exception as exc:\n"
            "    print(type(exc).__name__)\n"
            "    sys.exit(3)\n"
            "print('NOT REFUSED')\n"
        )
        proc = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True,
                              timeout=120, env=isolation.redirect_environment())
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertIn("IsolationError", proc.stdout)
        self.assertNotIn("NOT REFUSED", proc.stdout)

    def test_a_child_roster_run_without_a_root_is_refused(self) -> None:
        # The parent refuses the spawn outright ...
        with self.assertRaises(isolation.IsolationError):
            subprocess.run(
                [sys.executable, os.path.join(ROOT, "bin", "behold"), "roster"],
                capture_output=True, text=True, timeout=120,
                env=isolation.redirect_environment())
        # ... and the child refuses it too, through its own sitecustomize.
        script = (
            "import sys\n"
            f"sys.path.insert(0, {ROOT!r})\n"
            "from behold import cli\n"
            "try:\n"
            "    cli.main(['roster'])\n"
            "except Exception as exc:\n"
            "    print(type(exc).__name__)\n"
            "    sys.exit(3)\n"
            "print('NOT REFUSED')\n"
        )
        proc = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True,
                              timeout=120, env=isolation.redirect_environment())
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertIn("IsolationError", proc.stdout)
        self.assertNotIn("NOT REFUSED", proc.stdout)


class TestTheSuiteRunsInsideTheSandbox(unittest.TestCase):
    def test_the_home_is_the_sandbox(self) -> None:
        self.assertEqual(os.path.expanduser("~"), isolation.SANDBOX_HOME)

    def test_the_default_cache_path_is_inside_the_sandbox(self) -> None:
        path = cache_mod.default_db_path()
        self.assertTrue(isolation.is_sandbox(path), path)

    def test_the_xdg_directories_are_inside_the_sandbox(self) -> None:
        for key in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"):
            self.assertTrue(isolation.is_sandbox(os.environ.get(key, "")), key)

    def test_the_shared_helper_builds_a_synthetic_roster_invocation(self) -> None:
        # The runtime rule is the mechanism: any roster invocation in the suite that
        # lacks a fixture root or a cache decision raises. This checks the one place
        # that *builds* the shared invocation, and proves the rule accepts it.
        from tests.helpers import AS_OF, FIXTURE_ROOT
        argv = ["roster", "--root", FIXTURE_ROOT, "--as-of", AS_OF,
                "--cache", "off", "--cache-db", "/tmp/scratch/behold.db"]
        isolation.check_roster_argv(argv)
        with self.assertRaises(isolation.IsolationError):
            isolation.check_roster_argv(["roster", "--root", FIXTURE_ROOT])
        with self.assertRaises(isolation.IsolationError):
            isolation.check_roster_argv(["roster", "--cache", "off"])

    def test_the_shared_helper_runs_only_synthetic_rosters(self) -> None:
        with open(os.path.join(ROOT, "tests", "helpers.py"), "r", encoding="utf-8") as fh:
            text = fh.read()
        self.assertTrue('"--root"' in text, "the helper must pass a fixture root")
        self.assertTrue('"--cache"' in text, "the helper must pass a cache decision")

    def test_the_fixture_root_is_inside_the_sandbox(self) -> None:
        from tests.helpers import FIXTURE_ROOT
        if not os.environ.get("BEHOLD_FIXTURE_ROOT"):
            self.skipTest("the suite was not started by tests/run-tests.sh: the fixture "
                          "root is the default path, not the sandbox's")
        self.assertTrue(isolation.is_sandbox(FIXTURE_ROOT), FIXTURE_ROOT)


if __name__ == "__main__":
    unittest.main()
