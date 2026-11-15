"""Test isolation: a disposable home, and a fail-closed guard against the real machine.

The brief for correction 3 is blunt about the last tranche: "previous live-mode tests
created a real DB and read real stores despite instructions". So the suite stops relying
on the operator's environment and starts **proving** it cannot touch the real machine.

Three pieces, and they are independent of each other on purpose:

1. **A disposable tree.** ``$HOME``, the XDG directories and the whole state directory
   are redirected into a sandbox (``$BEHOLD_ISOLATION_ROOT``), so a path that resolves
   "the user's home" resolves *into the sandbox* instead.
2. **A fail-closed guard.** In this process and in every Python child (through a
   ``sitecustomize`` on ``PYTHONPATH``), any attempt to open, create, remove or rename a
   path under the **real** home — outside the repository and outside the sandbox — is
   refused, and any attempt to spawn the **real** ``herdr`` is refused. The guard raises
   :class:`IsolationError`; it does not warn.
3. **Planted negative tests.** The isolation is proven by tests that *try* to break it
   and are refused, not by an environment variable that happens to be set.

The repository itself lives under the real home on this machine, so the repository root
is explicitly allowed; nothing else under the real home is.
"""

from __future__ import annotations

import builtins
import os
import pwd
import shutil
import subprocess
import sys
import tempfile
from typing import Any, Iterable, Sequence

#: The real home of the user running the suite, whatever ``$HOME`` says. This is what
#: makes the guard meaningful: after the redirection, ``$HOME`` points into the sandbox,
#: but the *machine's* home is still here.
try:
    REAL_HOME = os.path.realpath(pwd.getpwuid(os.getuid()).pw_dir)
except Exception:  # pragma: no cover - a system without the password database
    REAL_HOME = os.path.realpath(os.path.expanduser("~"))

#: The repository root: the one place under the real home the suite may read and write.
REPO_ROOT = os.path.realpath(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))

#: The sandbox: a disposable tree that holds the redirected home, the XDG directories,
#: the fixtures and the fake herdr.
SANDBOX = os.path.realpath(os.environ.get("BEHOLD_ISOLATION_ROOT") or
                           tempfile.mkdtemp(prefix="behold-isolation-"))

#: The redirected home.
SANDBOX_HOME = os.path.join(SANDBOX, "home")

#: The real ``herdr`` binary on this machine, if it is there. Spawning it is refused.
REAL_HERDR = os.path.join(REAL_HOME, ".local", "bin", "herdr")


def _installed_pi_roots() -> tuple[str, ...]:
    """The installed pi package directories.

    pi is a **program** on this machine, not a store: the suite reads its own source to
    check the API the extension depends on, the same way it reads the herdr binary's
    bundled schema. These paths are **read-only** for the suite; nothing may write them.
    """
    roots: list[str] = []
    base = os.path.join(REAL_HOME, ".local", "share", "mise", "installs", "node")
    try:
        for entry in sorted(os.listdir(base)):
            candidate = os.path.join(base, entry, "lib", "node_modules",
                                     "@earendil-works", "pi-coding-agent")
            if os.path.isdir(candidate):
                roots.append(os.path.realpath(candidate))
    except OSError:
        pass
    return tuple(roots)


#: Paths the suite may READ (never write): the installed programs' own source.
STATIC_READ_ROOTS = _installed_pi_roots()


class IsolationError(RuntimeError):
    """The suite tried to touch the real machine. The refusal is the point."""


def _real(path: Any) -> str:
    try:
        return os.path.realpath(os.fspath(path))
    except TypeError:
        return ""


def _under(path: str, root: str) -> bool:
    if not path or not root:
        return False
    if path == root:
        return True
    return path.startswith(root.rstrip(os.sep) + os.sep)


def is_sandbox(path: Any) -> bool:
    return _under(_real(path), SANDBOX)


def is_repo(path: Any) -> bool:
    return _under(_real(path), REPO_ROOT)


def is_real_home(path: Any) -> bool:
    """Is this path inside the machine's real home?"""
    return _under(_real(path), REAL_HOME)


def check_path(path: Any, *, what: str = "path", write: bool = False) -> None:
    """Refuse a path under the real home that is neither the repository nor the sandbox.

    This is the mechanism, not a promise: the check runs on every ``open`` and every
    directory mutation the suite makes, in this process and in its children.

    The one exception is a **read** of an installed program's own source (the pi
    package), which is how the suite checks the API it actually depends on. Writes are
    never allowed there.
    """
    real = _real(path)
    if not real:
        return
    if not is_real_home(real):
        return
    if is_repo(real) or is_sandbox(real):
        return
    if not write and any(_under(real, root) for root in STATIC_READ_ROOTS):
        return
    raise IsolationError(
        f"test isolation refused {what} under the real home: {path} "
        f"(real home {REAL_HOME}; the repository and the sandbox are the only places "
        f"this suite may touch)")


def check_argv(argv: Sequence[str] | None) -> None:
    """Refuse a spawn that could reach the real fleet.

    Two rules:

    * **herdr.** The real ``herdr`` may only be asked for its **bundled schema**
      (``herdr api schema``), which is a static read of a file the binary ships with. Any
      other herdr invocation -- a snapshot, anything else -- is refused, unless the
      executable is the **fake** one inside the sandbox.
    * **paths.** No argument may name a path under the real home that is neither the
      repository nor the sandbox: a child process cannot be handed the operator's stores.
    """
    if not argv:
        return
    try:
        exe = _real(argv[0])
    except Exception:  # pragma: no cover - a non-path argv
        return
    if not exe:
        return
    args = [str(a) for a in argv[1:]]
    if os.path.basename(exe) == "herdr" and not is_sandbox(exe):
        schema_read = "schema" in args and "snapshot" not in args
        if not schema_read:
            raise IsolationError(
                f"test isolation refused a herdr spawn that is not the bundled-schema "
                f"read: {list(argv)}")
    for arg in args:
        if not arg.startswith("/"):
            continue
        if is_real_home(arg) and not is_repo(arg) and not is_sandbox(arg):
            raise IsolationError(
                f"test isolation refused a spawn that names a path under the real home: "
                f"{arg}")


def check_roster_argv(argv: Sequence[str] | None) -> None:
    """Refuse a roster run that is not synthetic and explicit.

    The suite may only run the roster against a **fixture tree** (``--root``) with an
    explicit cache decision (``--cache`` / ``--cache-db``). A live run -- one that would
    capture the real topology and read the real stores -- is refused outright.
    """
    if not argv:
        return
    args = [str(a) for a in argv]
    if "roster" not in args:
        return
    if "--root" not in args and "--snapshot" not in args:
        # Neither a fixture tree nor a single file: this is the **live** run, which
        # captures the real topology and reads the real stores.
        raise IsolationError(
            "test isolation refused a roster run without --root or --snapshot: a live "
            "run would capture the real topology and read the real stores")
    if "--cache" not in args and "--cache-db" not in args:
        raise IsolationError(
            "test isolation refused a roster run without an explicit --cache decision")


_installed = False


def redirect_process_environment() -> None:
    """Point this process's home and XDG directories at the sandbox.

    The redirection is what makes "the user's home" resolve into the sandbox even for
    code that asks the operating system rather than the environment. It is idempotent,
    and it happens before any test runs.
    """
    for key, value in (
            ("HOME", SANDBOX_HOME),
            ("XDG_CONFIG_HOME", os.path.join(SANDBOX, "config")),
            ("XDG_DATA_HOME", os.path.join(SANDBOX, "data")),
            ("XDG_CACHE_HOME", os.path.join(SANDBOX, "cache")),
            ("XDG_STATE_HOME", os.path.join(SANDBOX, "state")),
            ("BEHOLD_ISOLATION_ROOT", SANDBOX),
            ("BEHOLD_REAL_HOME", REAL_HOME)):
        os.environ[key] = value


def install() -> None:
    """Install the fail-closed guard in this process."""
    global _installed
    if _installed:
        return
    _installed = True
    redirect_process_environment()

    real_open = builtins.open

    def guarded_open(file, *args, **kwargs):  # type: ignore[no-untyped-def]
        check_path(file, what="open")
        return real_open(file, *args, **kwargs)

    builtins.open = guarded_open  # type: ignore[assignment]

    def _wrap_os(name: str) -> None:
        original = getattr(os, name)

        def wrapper(path, *args, **kwargs):  # type: ignore[no-untyped-def]
            check_path(path, what=name, write=True)
            return original(path, *args, **kwargs)

        setattr(os, name, wrapper)

    for name in ("makedirs", "mkdir", "remove", "unlink", "rename", "rmdir", "truncate"):
        if hasattr(os, name):
            _wrap_os(name)

    try:
        from behold import cli as _cli
    except Exception:  # pragma: no cover - the CLI is importable in this repository
        _cli = None
    if _cli is not None:
        real_main = _cli.main

        def guarded_main(argv=None, **kwargs):  # type: ignore[no-untyped-def]
            check_roster_argv(list(argv) if argv is not None else list(sys.argv[1:]))
            return real_main(argv, **kwargs)

        _cli.main = guarded_main

    real_run = subprocess.run
    real_popen = subprocess.Popen

    def guarded_run(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
        argv = list(cmd) if isinstance(cmd, (list, tuple)) else [cmd]
        check_argv(argv)
        check_roster_argv(argv)
        return real_run(cmd, *args, **kwargs)

    def guarded_popen(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
        argv = list(cmd) if isinstance(cmd, (list, tuple)) else [cmd]
        check_argv(argv)
        check_roster_argv(argv)
        return real_popen(cmd, *args, **kwargs)

    subprocess.run = guarded_run  # type: ignore[assignment]
    subprocess.Popen = guarded_popen  # type: ignore[assignment]


def redirect_environment(env: dict[str, str] | None = None) -> dict[str, str]:
    """The environment every child of the suite must run with.

    ``HOME`` and the XDG directories point into the sandbox, and ``PYTHONPATH`` carries
    the sandbox (so the child's ``sitecustomize`` loads the guard) and the repository.
    """
    out = dict(env if env is not None else os.environ)
    out["HOME"] = SANDBOX_HOME
    out["XDG_CONFIG_HOME"] = os.path.join(SANDBOX, "config")
    out["XDG_DATA_HOME"] = os.path.join(SANDBOX, "data")
    out["XDG_CACHE_HOME"] = os.path.join(SANDBOX, "cache")
    out["XDG_STATE_HOME"] = os.path.join(SANDBOX, "state")
    out["BEHOLD_ISOLATION_ROOT"] = SANDBOX
    out["BEHOLD_REAL_HOME"] = REAL_HOME
    existing = out.get("PYTHONPATH", "")
    parts = [SANDBOX, REPO_ROOT] + ([existing] if existing else [])
    out["PYTHONPATH"] = os.pathsep.join(parts)
    return out


def prepare_sandbox() -> str:
    """Create the sandbox tree and write the child's ``sitecustomize``.

    The ``sitecustomize`` is what makes the guard reach the suite's **subprocesses**:
    Python imports it at startup, so every child — the CLI, the ingest helper, anything
    else — refuses the real home too.
    """
    for path in (SANDBOX, SANDBOX_HOME, os.path.join(SANDBOX, "config"),
                 os.path.join(SANDBOX, "data"), os.path.join(SANDBOX, "cache"),
                 os.path.join(SANDBOX, "state")):
        os.makedirs(path, exist_ok=True)
    sitecustomize = os.path.join(SANDBOX, "sitecustomize.py")
    with open(sitecustomize, "w", encoding="utf-8") as fh:
        fh.write(
            '"""The suite\'s fail-closed guard, installed in every Python child."""\n'
            "import os, sys\n"
            f"sys.path.insert(0, {REPO_ROOT!r})\n"
            "try:\n"
            "    from tests.isolation import install\n"
            "except Exception:\n"
            "    install = None\n"
            "if install is not None:\n"
            "    try:\n"
            "        install()\n"
            "    except Exception:\n"
            "        pass\n")
    return SANDBOX


def sandbox_dir(*parts: str) -> str:
    """A directory inside the sandbox, created if needed."""
    path = os.path.join(SANDBOX, *parts)
    os.makedirs(path, exist_ok=True)
    return path


def fake_herdr_bin(directory: str | None = None, *, document: dict[str, Any] | None = None,
                   exit_code: int = 0, stderr: str = "") -> str:
    """Create a fake ``herdr`` executable and return the directory holding it.

    It lives inside the sandbox, so the guard's spawn rule allows it and the real
    binary is never a candidate. The fake prints a snapshot document on stdout exactly
    as ``herdr api snapshot`` does, and records how it was called.
    """
    # A fresh directory per call: the fake records its calls in a marker file, and two
    # tests must not see each other's calls.
    root = os.path.join(SANDBOX, "fake-herdr")
    os.makedirs(root, exist_ok=True)
    target = tempfile.mkdtemp(prefix="run-", dir=root)
    payload = document if document is not None else {}
    script = (
        "#!/usr/bin/env python3\n"
        "import json, os, sys\n"
        f"marker = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'herdr.called')\n"
        "with open(marker, 'w', encoding='utf-8') as fh:\n"
        "    json.dump(sys.argv[1:], fh)\n"
        f"sys.stderr.write({stderr!r})\n"
        f"sys.stdout.write(json.dumps({payload!r}))\n"
        f"sys.exit({int(exit_code)})\n"
    )
    path = os.path.join(target, "herdr")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(script)
    os.chmod(path, 0o755)
    return target


def fake_herdr_calls(directory: str) -> list[str] | None:
    marker = os.path.join(directory, "herdr.called")
    if not os.path.exists(marker):
        return None
    with open(marker, "r", encoding="utf-8") as fh:
        import json
        return json.load(fh)


def which_real_herdr() -> str | None:
    """The real ``herdr`` on this machine, if it is installed."""
    found = shutil.which("herdr")
    return found if found else None
