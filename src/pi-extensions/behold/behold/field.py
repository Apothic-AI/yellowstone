"""Typed field values with provenance.

Every value behold emits is a ``Field``. The point of the type is that a wrong number is
traceable to a source instead of being argued about, and that "no value" is never written
as ``0`` or ``-``:

    state    present | unknown | absent | error | conflict | stale | expired |
             held | withheld | divergent | inferred
    class    authoritative (read verbatim) | derived (computed, reproducible) |
             inferred (a heuristic that may be wrong) | last_observed (a past
             observation that cannot be confirmed current)
    source   the file, command or adapter the value came from (paths only, never content)
    method   for derived values: the exact expression, so anyone can recompute it
    observed_at / age_s
    reason   for every non-present state, why there is no value
    privacy  0 public fleet metadata | 1 operator-sensitive (aggregate/count/path only)
             2 must never appear in output

``derived`` fields must carry a ``method``; that is enforced in ``__post_init__`` because
a derived number without a stated expression is exactly the fabricated formula the plan
forbids.
"""

from __future__ import annotations

from dataclasses import dataclass, field as dc_field
from typing import Any, Iterable

PRESENT = "present"
UNKNOWN = "unknown"
ABSENT = "absent"
ERROR = "error"
CONFLICT = "conflict"
STALE = "stale"
EXPIRED = "expired"
HELD = "held"
WITHHELD = "withheld"
DIVERGENT = "divergent"
INFERRED = "inferred"

STATES = frozenset(
    {PRESENT, UNKNOWN, ABSENT, ERROR, CONFLICT, STALE, EXPIRED, HELD, WITHHELD, DIVERGENT, INFERRED}
)

AUTHORITATIVE = "authoritative"
DERIVED = "derived"
INFERRED_CLASS = "inferred"
LAST_OBSERVED = "last_observed"

CLASSES = frozenset({AUTHORITATIVE, DERIVED, INFERRED_CLASS, LAST_OBSERVED})

# States that mean "there is a value" (INFERRED carries a value but is labelled).
VALUE_STATES = frozenset({PRESENT, STALE, EXPIRED, DIVERGENT, INFERRED})


@dataclass(frozen=True)
class Field:
    key: str
    state: str
    value: Any = None
    klass: str = AUTHORITATIVE
    source: str | None = None
    observed_at: str | None = None
    age_s: float | None = None
    method: str | None = None
    reason: str | None = None
    note: str | None = None
    unit: str | None = None
    privacy: int = 0

    def __post_init__(self) -> None:
        if self.state not in STATES:
            raise ValueError(f"{self.key}: unknown field state {self.state!r}")
        if self.klass not in CLASSES:
            raise ValueError(f"{self.key}: unknown field class {self.klass!r}")
        if self.privacy not in (0, 1, 2):
            raise ValueError(f"{self.key}: privacy must be 0, 1 or 2")
        if self.klass == DERIVED and self.state in VALUE_STATES and not self.method:
            raise ValueError(f"{self.key}: derived value requires a method expression")
        if self.state not in VALUE_STATES and self.state not in (INFERRED,) and self.reason is None:
            raise ValueError(f"{self.key}: state {self.state} requires a reason")

    def to_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "class": self.klass,
            "value": self.value,
            "source": self.source,
            "observed_at": self.observed_at,
            "age_s": None if self.age_s is None else round(self.age_s, 3),
            "method": self.method,
            "reason": self.reason,
            "note": self.note,
            "unit": self.unit,
            "privacy": self.privacy,
        }


def present(key: str, value: Any, **kw: Any) -> Field:
    return Field(key=key, state=PRESENT, value=value, **kw)


def unknown(key: str, reason: str, **kw: Any) -> Field:
    return Field(key=key, state=UNKNOWN, reason=reason, **kw)


def absent(key: str, reason: str, **kw: Any) -> Field:
    return Field(key=key, state=ABSENT, reason=reason, **kw)


def error(key: str, reason: str, **kw: Any) -> Field:
    return Field(key=key, state=ERROR, reason=reason, **kw)


def conflict(key: str, value: Any, reason: str, **kw: Any) -> Field:
    return Field(key=key, state=CONFLICT, value=value, reason=reason, **kw)


def stale(key: str, value: Any, reason: str, **kw: Any) -> Field:
    return Field(key=key, state=STALE, value=value, reason=reason, **kw)


def expired(key: str, reason: str, **kw: Any) -> Field:
    return Field(key=key, state=EXPIRED, reason=reason, **kw)


def held(key: str, reason: str, **kw: Any) -> Field:
    return Field(key=key, state=HELD, reason=reason, **kw)


def withheld(key: str, reason: str, **kw: Any) -> Field:
    return Field(key=key, state=WITHHELD, reason=reason, privacy=2, **kw)


def divergent(key: str, value: Any, reason: str, **kw: Any) -> Field:
    return Field(key=key, state=DIVERGENT, value=value, reason=reason, **kw)


def inferred(key: str, value: Any, reason: str, **kw: Any) -> Field:
    kw.setdefault("klass", INFERRED_CLASS)
    return Field(key=key, state=INFERRED, value=value, reason=reason, **kw)


def derived(key: str, value: Any, method: str, **kw: Any) -> Field:
    kw.setdefault("klass", DERIVED)
    return Field(key=key, state=PRESENT, value=value, method=method, **kw)


def last_observed(key: str, value: Any, reason: str, **kw: Any) -> Field:
    kw.setdefault("klass", LAST_OBSERVED)
    return Field(key=key, state=STALE, value=value, reason=reason, **kw)


def observed(key: str, value: Any, **kw: Any) -> Field:
    """A fresh but last-observed value.

    The observation is recent, so the state is ``present``; it is still a *last
    observation* rather than a read of the authoritative store, so the class says so.
    """
    kw.setdefault("klass", LAST_OBSERVED)
    return Field(key=key, state=PRESENT, value=value, **kw)


def rollup(key: str, fields: Iterable[Field], *, privacy: int = 0) -> dict[str, Any]:
    """A non-Field structural node: counts of child states, no values of its own."""
    states: dict[str, int] = {}
    for f in fields:
        states[f.state] = states.get(f.state, 0) + 1
    return {"key": key, "children": states, "privacy": privacy}


def value_of(fields: dict[str, Field], key: str, default: Any = None) -> Any:
    f = fields.get(key)
    if f is None or f.state not in VALUE_STATES:
        return default
    return f.value
