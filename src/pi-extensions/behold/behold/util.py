"""Small time / JSONL / path helpers shared by the adapters."""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field as dc_field
from datetime import datetime, timezone
from typing import Any, Iterator

UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)


def parse_iso(value: str | None) -> float | None:
    """Parse an ISO-8601 timestamp to epoch seconds, offsets and fractions included.

    V2's hand-rolled regex was wrong: it kept the fractional part as a *separate* addend but
    silently dropped it whenever an offset was present, and it could not compare
    ``2026-11-11T03:00:00Z`` with ``2026-11-10T22:00:00-05:00`` (the same instant). Wrong
    offsets fabricate ages and staleness, so this delegates to ``datetime`` instead of
    re-deriving the calendar.
    """
    if not value or not isinstance(value, str):
        return None
    text = value.strip()
    if text.endswith("Z") or text.endswith("z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def iso(epoch: float | None) -> str | None:
    if epoch is None:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def now_epoch() -> float:
    return time.time()


def age_s(observed: float | None, as_of: float | None) -> float | None:
    if observed is None or as_of is None:
        return None
    return max(0.0, as_of - observed)


def realpath(path: str) -> str:
    """Normalize a path; the same session file has two spellings on this fleet."""
    try:
        return os.path.realpath(path)
    except OSError:
        return os.path.abspath(path)


def session_uuid_from_filename(path: str) -> str | None:
    m = UUID_RE.search(os.path.basename(path))
    return m.group(0) if m else None


@dataclass
class JsonlResult:
    entries: list[dict[str, Any]] = dc_field(default_factory=list)
    malformed: int = 0
    partial_tail: bool = False
    bytes_read: int = 0
    lines: int = 0
    duplicate_ids: int = 0


def read_jsonl(path: str, policy: Any, purpose: str = "session") -> JsonlResult:
    """Parse JSONL line by line, tolerating a partially-written final line.

    A live session file is appended to while it is read; the last line may be a
    half-written object. That is a *documented* state, not an error: the partial line is
    counted and dropped, and every complete line before it is used.
    """
    from . import guard

    policy.check_path(path, purpose)
    result = JsonlResult()
    seen: set[str] = set()
    with open(path, "rb") as fh:
        data = fh.read()
    result.bytes_read = len(data)
    text = data.decode("utf-8", "replace")
    lines = text.split("\n")
    trailing_newline = text.endswith("\n")
    if lines and lines[-1] == "" and trailing_newline:
        lines.pop()
    elif lines and lines[-1] == "":
        lines.pop()
    for index, raw in enumerate(lines):
        line = raw.strip()
        if not line:
            continue
        result.lines += 1
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            is_last = index == len(lines) - 1
            if is_last and (not trailing_newline or result.lines > 1):
                result.partial_tail = True
                continue
            result.malformed += 1
            continue
        if not isinstance(obj, dict):
            result.malformed += 1
            continue
        entry_id = obj.get("id")
        if isinstance(entry_id, str):
            if entry_id in seen:
                result.duplicate_ids += 1
            seen.add(entry_id)
        result.entries.append(obj)
    return result


def iter_jsonl_stream(path: str, policy: Any, chunk: int = 1 << 20) -> Iterator[dict[str, Any]]:
    """Stream JSONL for very large files without holding the whole text in memory."""
    from . import guard

    policy.check_path(path, "session")
    with open(path, "rb") as fh:
        buffer = b""
        while True:
            block = fh.read(chunk)
            if not block:
                break
            buffer += block
            while b"\n" in buffer:
                line, _, buffer = buffer.partition(b"\n")
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line.decode("utf-8", "replace"))
                except json.JSONDecodeError:
                    continue
                if isinstance(obj, dict):
                    yield obj
        tail = buffer.strip()
        if tail:
            try:
                obj = json.loads(tail.decode("utf-8", "replace"))
            except json.JSONDecodeError:
                obj = None
            if isinstance(obj, dict):
                yield obj
