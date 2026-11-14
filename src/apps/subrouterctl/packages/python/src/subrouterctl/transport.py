"""Transports that carry the SubRouter protocol to the Go library.

Two are available:

``ffi``
    The Go library is loaded into the process with :mod:`ctypes`. The call
    never leaves the process and never touches a pipe. This is the default
    when the shared library is installed.

``ipc``
    The Go library runs as a child process that speaks the protocol over its
    standard streams. This works without a C toolchain and is the fallback
    when the shared library is missing.

Both speak the same protocol: one JSON request in, one JSON response out.
"""

from __future__ import annotations

import ctypes
import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Dict, Optional

from .errors import LibraryNotFound, TransportError

#: The name of the shared library on this platform.
LIBRARY_NAMES = {
    "linux": "libsubrouter.so",
    "darwin": "libsubrouter.dylib",
    "win32": "subrouter.dll",
}

#: The name of the helper binary.
BINARY_NAME = "subrouterctl"


def _package_dir() -> Path:
    return Path(__file__).resolve().parent


def library_candidates() -> list:
    """The places the shared library is looked for, in order."""
    names = [LIBRARY_NAMES.get(sys.platform, "libsubrouter.so")]
    candidates = []
    env = os.environ.get("SUBROUTERCTL_LIB")
    if env:
        candidates.append(Path(env))
    for name in names:
        candidates.append(_package_dir() / "_lib" / name)
        # The repository build directory, for a checkout of the source.
        candidates.append(_package_dir().parents[3] / "build" / name)
    return candidates


def find_library() -> Path:
    """Locate the Go shared library.

    Raises :class:`LibraryNotFound` when it is nowhere to be found.
    """
    searched = []
    for candidate in library_candidates():
        searched.append(str(candidate))
        if candidate.is_file():
            return candidate
    raise LibraryNotFound(
        "the Go library of subrouterctl was not found. Build it with "
        "'make bindings' in the repository, or point SUBROUTERCTL_LIB at it.",
        searched,
    )


def binary_candidates() -> list:
    """The places the helper binary is looked for, in order."""
    candidates = []
    env = os.environ.get("SUBROUTERCTL_BIN")
    if env:
        candidates.append(Path(env))
    # The repository build, for a checkout of the source.
    candidates.append(_package_dir().parents[3] / BINARY_NAME)
    found = shutil.which(BINARY_NAME)
    if found:
        candidates.append(Path(found))
    return candidates


def find_binary() -> Path:
    """Locate the helper binary."""
    searched = []
    for candidate in binary_candidates():
        searched.append(str(candidate))
        if candidate.is_file():
            return candidate
    raise TransportError(
        "the subrouterctl binary was not found. Build it with 'make build' in "
        "the repository, or point SUBROUTERCTL_BIN at it. Searched: "
        + ", ".join(searched)
    )


class Transport:
    """The interface every transport implements."""

    name = "none"

    def call(self, request: Dict[str, Any]) -> Dict[str, Any]:
        raise NotImplementedError

    def close(self) -> None:
        """Release whatever the transport holds."""


class FFITransport(Transport):
    """Calls the Go library in process over its C ABI."""

    name = "ffi"

    def __init__(self, path: Optional[Path] = None) -> None:
        self.path = Path(path) if path else find_library()
        self._lib = ctypes.CDLL(str(self.path))
        self._lib.subrouterctl_call.argtypes = [ctypes.c_char_p]
        self._lib.subrouterctl_call.restype = ctypes.c_void_p
        self._lib.subrouterctl_free.argtypes = [ctypes.c_void_p]
        self._lib.subrouterctl_free.restype = None
        self._lib.subrouterctl_version.argtypes = []
        self._lib.subrouterctl_version.restype = ctypes.c_char_p

    @property
    def version(self) -> str:
        """The version of the Go library."""
        raw = self._lib.subrouterctl_version()
        return raw.decode("utf-8") if raw else ""

    def call(self, request: Dict[str, Any]) -> Dict[str, Any]:
        payload = json.dumps(request).encode("utf-8")
        pointer = self._lib.subrouterctl_call(payload)
        if not pointer:
            raise TransportError("the Go library returned nothing")
        try:
            raw = ctypes.string_at(pointer)
        finally:
            self._lib.subrouterctl_free(pointer)
        return json.loads(raw.decode("utf-8"))


class IPCTransport(Transport):
    """Calls the Go library in a child process over its standard streams."""

    name = "ipc"

    def __init__(self, binary: Optional[Path] = None, env: Optional[Dict[str, str]] = None) -> None:
        self.path = Path(binary) if binary else find_binary()
        self._lock = threading.Lock()
        self._counter = 0
        try:
            self._process = subprocess.Popen(
                [str(self.path), "bridge"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                bufsize=1,
                universal_newlines=True,
            )
        except OSError as exc:
            raise TransportError("cannot start %s: %s" % (self.path, exc)) from exc

    def call(self, request: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            self._counter += 1
            payload = dict(request)
            payload["id"] = str(self._counter)
            line = json.dumps(payload)
            assert self._process.stdin is not None
            assert self._process.stdout is not None
            try:
                self._process.stdin.write(line + "\n")
                self._process.stdin.flush()
                answer = self._process.stdout.readline()
            except (BrokenPipeError, OSError) as exc:
                raise TransportError("the bridge process stopped: %s" % exc) from exc
            if not answer:
                raise TransportError("the bridge process closed its output")
            return json.loads(answer)

    def close(self) -> None:
        process = getattr(self, "_process", None)
        if process is None:
            return
        try:
            if process.stdin:
                process.stdin.close()
            process.wait(timeout=5)
        except Exception:
            process.kill()


def open_transport(kind: str = "auto") -> Transport:
    """Open a transport.

    ``auto`` prefers the in-process library and falls back to the child
    process when the shared library is not installed.
    """
    if kind == "ffi":
        return FFITransport()
    if kind == "ipc":
        return IPCTransport()
    if kind != "auto":
        raise ValueError("unknown transport %r: use auto, ffi or ipc" % kind)
    try:
        return FFITransport()
    except LibraryNotFound:
        return IPCTransport()
