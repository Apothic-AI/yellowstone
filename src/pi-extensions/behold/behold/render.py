"""Renderers: stable-order JSON, and Markdown that says "unknown" instead of guessing.

Filtering and ordering operate on *flattened field paths* (``H-5.value.status``,
``T-3.value``), so any property the JSON exposes is filterable and sortable without a
second schema. A filter that matches nothing is not an error; it is an empty lane list,
which is visible in ``behold.lanes``.
"""

from __future__ import annotations

import fnmatch
import json
from dataclasses import dataclass
from typing import Any, Iterable

from . import field as F

VERSION = "0.1.0-p1p2"

BUDGET_TARGETS = {
    "note": "targets, not measured whole-fleet proof",
    "snapshot_ms": 40,
    "process_info_per_lane_ms": 10,
    "session_scan_ms": 30,
    "session_parse_398kib_ms": 10,
    "session_parse_multi_mb_ms": 120,
    "git_status_per_lane_ms": 60,
    "beads_export_ms": 150,
    "warm_metadata_roster_61_lanes_ms": 250,
    "cold_full_roster_git_ms": 1500,
    "single_lane_ms": 80,
}

RUNTIME_ONLY_PENDING = (
    "T-8 ttft_ms: pi does not persist time-to-first-token",
    "J-1 background job live exit state: only log files and last tool calls exist",
    "J-2 monitor exit state: runtime-only",
    "J-3 bizzy monitor registry: no persistable state",
    "E-1 exact loaded extension list: tools alone cannot prove it (inert extensions register "
    "nothing); needs loader/registration evidence, not the tool list",
    "M-7 rooms presence/inbox depth: deferred to P3",
)


#: Every field id the roster can emit, in display order. A projection is validated
#: against this list: a mistyped id is a usage error, never a silently missing field.
FIELD_IDS = (
    "H-1", "H-2", "H-3", "H-4", "H-5", "H-6",
    "P-1", "P-2", "P-3", "P-4", "P-5", "P-6", "P-7", "P-8", "P-9", "P-10", "P-11",
    "T-1", "T-2", "T-3", "T-4", "T-5", "T-6", "T-7", "T-8",
    "R-1", "R-2", "R-3", "R-4", "R-5", "R-6", "R-7",
    "M-1", "M-2", "M-3", "M-5", "M-6", "M-7",
    "G-1", "G-2", "G-3", "G-4", "D-1", "D-2", "C-1", "C-2",
    "E-1", "E-2", "S-1", "S-2", "S-3", "S-4",
    "J-1", "J-2", "J-3", "B-1", "B-2",
)

#: Lane-level keys a projection may name. ``identity`` is session-derived (it is the
#: agreement state of the session witnesses); ``handles`` and ``admission`` are not.
LANE_KEYS = ("key", "handles", "admission", "identity")

#: Field ids that need **no** session file. Any other id is session-derived, and a
#: projection that names none of them skips session parsing entirely. The set is
#: deliberately conservative: when it is unclear whether a field needs the session (for
#: example ``M-7``, whose value comes from the state-only path), the field is left out of
#: this set so the session is read. Reading a session costs time; guessing at a field's
#: provenance costs the report its honesty.
SESSION_FREE_FIELDS = frozenset({
    "H-1", "H-2", "H-3", "H-4", "H-5", "H-6",
    "R-1", "R-2", "R-3", "R-4", "R-5", "R-6", "R-7",
    "C-1", "C-2",
    "M-5", "M-6",
    "G-3", "G-4",
    "B-1", "B-2", "D-2",
})

#: The documented ``--summary`` preset. Each entry is a field id or lane key; the preset
#: is a **selection**, never a claim of completeness: everything else is omitted, and the
#: document says so in ``behold.projection``.
SUMMARY_TOKENS = (
    "key", "handles", "admission",
    "H-4", "H-5",
    "P-2", "P-4", "P-7", "P-11",
    "T-1", "T-2", "T-3",
    "D-1",
)

#: What each ``--summary`` entry means, field by field. Published in the document and in
#: ``README.md`` so the preset is a documented contract rather than a convenience.
SUMMARY_MEANING = {
    "key": "the lane's pane id (the row identity)",
    "handles": "snapshot handles: pane/workspace/tab ids, workspace label, resolved name + winning layer, herdr agent_status",
    "admission": "whether the lane was admitted and, when not, the deny reason",
    "H-4": "resolved lane name and the layer that produced it",
    "H-5": "herdr's own agent status, verbatim (idle/working/blocked/done), with its observed seq numbers",
    "P-2": "selected vs physical model, and whether they differ",
    "P-4": "which session the lane's validated pin points at: leaf, chain state, entry counts (DISK_RECONSTRUCTED)",
    "P-7": "session duration in seconds, stating whether it is live or frozen at the last write",
    "P-11": "the reporter's last observation: fresh/stale/absent, its age and incarnation (not a liveness proof)",
    "T-1": "context tokens from the last assistant usage on the active branch",
    "T-2": "the model's contextWindow from the models store",
    "T-3": "context used as a percentage of the window; unknown when T-1 or T-2 is unknown",
    "D-1": "todo counts (open/completed/total); subjects are never exported",
}

SUMMARY_NOTE = (
    "--summary is a documented selection, not a complete roster: every field it does not "
    "name is omitted, not nulled, and no field state is altered. For completeness use no "
    "projection, or name the fields explicitly with --fields"
)


def field_order() -> list[str]:
    return list(FIELD_IDS)


@dataclass(frozen=True)
class Projection:
    """A validated ``--fields`` / ``--summary`` selection.

    The projection is applied to the *emitted* document only: a field that is not named is
    **omitted**. It is never rewritten to ``null``, ``0``, ``-`` or ``""``, and no state is
    reported differently than it would be in a full run.
    """

    mode: str                       # "fields" | "summary"
    tokens: tuple[str, ...]         # as written by the caller (normalized)
    field_ids: tuple[str, ...]      # resolved field ids
    lane_keys: tuple[str, ...]      # resolve lane keys, dotted ("identity.state") or whole

    @property
    def needs_session(self) -> bool:
        if any(key.split(".", 1)[0] == "identity" for key in self.lane_keys):
            # identity is the *agreement state* of the session witnesses: without a parse
            # there is nothing to agree about, so asking for it needs the session.
            return True
        return any(field_id not in SESSION_FREE_FIELDS for field_id in self.field_ids)

    def wants(self, key: str) -> bool:
        return any(token == key or token.startswith(key + ".") for token in self.lane_keys)

    def subkeys(self, key: str) -> tuple[str, ...]:
        """The requested sub-keys of a lane key; empty means the whole object."""
        if key in self.lane_keys:
            return ()
        prefix = key + "."
        return tuple(token[len(prefix):] for token in self.lane_keys if token.startswith(prefix))

    def to_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "tokens": list(self.tokens),
            "fields": list(self.field_ids),
            "lane_keys": list(self.lane_keys),
            "session_derived": self.needs_session,
            "note": (SUMMARY_NOTE if self.mode == "summary" else
                     "projection: every key and field not listed is omitted, never nulled, "
                     "and no field state is altered by being projected"),
            "by_field_state_scope": "projected fields only",
        }


def _resolve_field_token(token: str) -> tuple[str, ...]:
    if token.endswith("*"):
        prefix = token[:-1]
        if not prefix:
            raise ValueError("field projection '*' needs a field prefix such as 'H-*'")
        matches = tuple(field_id for field_id in FIELD_IDS if field_id.startswith(prefix))
        if not matches:
            raise ValueError(
                f"field projection {token!r} matches no field id; try 'H-*', 'T-*' or a "
                f"single id such as 'H-5'")
        return matches
    if token in FIELD_IDS:
        return (token,)
    raise ValueError(
        f"unknown field id {token!r} in the projection; known ids are "
        f"{', '.join(FIELD_IDS)}")


def parse_projection(*, fields: str | None = None, summary: bool = False) -> Projection | None:
    """Validate ``--fields``/``--summary`` into a :class:`Projection`, or ``None``.

    A malformed spec is a usage error (``ValueError``), never a silently empty projection:
    a mistyped field id that were dropped would be indistinguishable from a field behold
    chose not to emit.
    """
    if fields and summary:
        raise ValueError("--fields and --summary are two ways to name one projection; "
                         "pass one of them")
    if summary:
        tokens = tuple(SUMMARY_TOKENS)
        mode = "summary"
    elif fields:
        tokens = tuple(part.strip() for part in fields.split(","))
        if not any(tokens):
            raise ValueError("--fields needs at least one lane key or field id, e.g. "
                             "'key,H-5'")
        tokens = tuple(token for token in tokens if token)
        mode = "fields"
    else:
        return None

    field_ids: list[str] = []
    lane_keys: list[str] = []
    for token in tokens:
        if token in LANE_KEYS:
            if token not in lane_keys:
                lane_keys.append(token)
            continue
        head, _, sub = token.partition(".")
        if head in LANE_KEYS and sub:
            if not sub or not all(part.isidentifier() for part in sub.split(".")):
                raise ValueError(f"projection {token!r} is not a lane key path")
            if token not in lane_keys:
                lane_keys.append(token)
            continue
        for field_id in _resolve_field_token(token):
            if field_id not in field_ids:
                field_ids.append(field_id)
    return Projection(mode=mode, tokens=tokens, field_ids=tuple(field_ids),
                      lane_keys=tuple(lane_keys))


def project_lane(lane: dict[str, Any], projection: Projection) -> dict[str, Any]:
    """One lane, projected by omission. The input lane is never mutated."""
    out: dict[str, Any] = {}
    for key in LANE_KEYS:
        if not projection.wants(key):
            continue
        value = lane.get(key)
        subkeys = projection.subkeys(key)
        if subkeys and isinstance(value, dict):
            # Keep only the requested sub-keys; a parent that is not an object (a held
            # lane's ``identity: null``) is carried through verbatim, never invented.
            out[key] = {name: value[name] for name in value if name in subkeys}
        else:
            out[key] = value
    fields = lane.get("fields") or {}
    out["fields"] = {field_id: value for field_id, value in fields.items()
                     if field_id in projection.field_ids}
    return out


def project_lanes(lanes: list[dict[str, Any]], projection: Projection | None) -> list[dict[str, Any]]:
    if projection is None:
        return lanes
    return [project_lane(lane, projection) for lane in lanes]


def flatten(prefix: str, value: Any, out: dict[str, Any]) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            flatten(f"{prefix}.{key}" if prefix else str(key), item, out)
    elif isinstance(value, list):
        out[prefix] = value
        for index, item in enumerate(value):
            flatten(f"{prefix}[{index}]", item, out)
    else:
        out[prefix] = value


def lane_flat(lane: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "key": lane.get("key"),
        "admitted": lane["admission"]["admitted"],
        "handles": lane["handles"],
    }
    for key, field in lane["fields"].items():
        out[key] = field
        out[f"{key}.state"] = field["state"]
        flatten(f"{key}.value", field["value"], out)
    if lane.get("identity"):
        out["identity.state"] = lane["identity"]["state"]
        out["identity.session_id"] = lane["identity"]["session_id"]
    return out


def _as_text(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "null"
    if isinstance(value, (dict, list)):
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return str(value)


def parse_filter(expression: str) -> tuple[str, str, str]:
    for op in ("!~", "~", "!=", "="):
        if op in expression:
            key, _, value = expression.partition(op)
            return key.strip(), op, value.strip()
    raise ValueError(f"filter {expression!r} needs one of = != ~ !~")


def matches(flat: dict[str, Any], expression: str) -> bool:
    key, op, expected = parse_filter(expression)
    if key not in flat:
        return False
    actual = _as_text(flat[key])
    if op == "=":
        return actual == expected
    if op == "!=":
        return actual != expected
    if op == "~":
        return fnmatch.fnmatchcase(actual, expected)
    return not fnmatch.fnmatchcase(actual, expected)


def apply_filters(lanes: list[dict[str, Any]], filters: Iterable[str]) -> list[dict[str, Any]]:
    expressions = list(filters)
    if not expressions:
        return lanes
    kept = []
    for lane in lanes:
        flat = lane_flat(lane)
        if all(matches(flat, expression) for expression in expressions):
            kept.append(lane)
    return kept


def sort_key(spec: str) -> tuple[str, bool]:
    if ":" in spec:
        key, direction = spec.rsplit(":", 1)
        return key, direction.lower() == "desc"
    return spec, False


def apply_sort(lanes: list[dict[str, Any]], sorts: Iterable[str]) -> list[dict[str, Any]]:
    """Stable multi-key sort where a missing/unknown value is always last.

    Two passes per key: the first partitions known before unknown (never inverted, because
    it is always ascending), the second orders the known values in the requested direction.
    Python's sort is stable, so the partition survives the value sort.
    """
    specs = [sort_key(s) for s in sorts] or [("key", False)]
    ordered = list(lanes)
    for key, descending in reversed(specs):
        def flat_value(lane: dict[str, Any], key: str = key) -> Any:
            return lane_flat(lane).get(key)

        numbers, texts, missing = [], [], []
        for lane in ordered:
            value = flat_value(lane, key)
            if value is None:
                missing.append(lane)
            elif isinstance(value, bool):
                texts.append((_as_text(value), lane))
            elif isinstance(value, (int, float)):
                numbers.append((float(value), lane))
            else:
                texts.append((_as_text(value).lower(), lane))
        # Numbers sort numerically, text sorts case-insensitively, and missing values are
        # always last — in both directions, because the partition is not reversed.
        numbers.sort(key=lambda item: item[0], reverse=descending)
        texts.sort(key=lambda item: item[0], reverse=descending)
        ordered = [lane for _v, lane in numbers] + [lane for _v, lane in texts] + missing
    return ordered


def document(
    *,
    lanes: list[dict[str, Any]],
    ctx: Any,
    guard_receipt: dict[str, Any],
    diagnostics: list[dict[str, Any]],
    generated_at: str,
    filters: list[str],
    sorts: list[str],
    global_block: dict[str, Any],
    wall_ms: float,
    watch: dict[str, Any] | None = None,
    cache: dict[str, Any] | None = None,
    projection: Projection | None = None,
) -> dict[str, Any]:
    # The projection is applied to the **emitted** lanes only, after every caller-supplied
    # derivation (the global block, in cli.py) has seen the complete lane records. A
    # projected field is omitted; its state is never rewritten.
    emitted = project_lanes(lanes, projection)
    by_state: dict[str, int] = {}
    for lane in emitted:
        for key, field in (lane.get("fields") or {}).items():
            by_state[field["state"]] = by_state.get(field["state"], 0) + 1
    timings = {}
    for name, samples in ctx.timings.items():
        if samples:
            ordered = sorted(samples)
            timings[name] = {
                "count": len(ordered),
                "p50": round(ordered[len(ordered) // 2], 3),
                "max": round(ordered[-1], 3),
            }
    doc = {
        "behold": {
            "version": VERSION,
            "generated_at": generated_at,
            "as_of": ctx.as_of_iso,
            "mode": "derive-on-demand-read-only",
            "snapshot": ctx.snapshot.to_dict(),
            "paths": ctx.paths.to_dict(),
            "guard": guard_receipt,
            "privacy": {
                "rules": {
                    "held_workspaces": sorted(ctx.policy.denied_workspaces),
                    "reserved_panes": sorted(ctx.policy.denied_panes),
                    "denied_path_markers": list(ctx.policy.denied_path_markers),
                    "counts_and_paths_only": True,
                    "no_private_exports": [
                        "goal text", "todo subjects", "cron prompts", "room bodies/receipts",
                        "bead description/notes", "bead titles", "dagr run titles",
                        "session message content", "tool arguments", "skill bodies", "prompt bodies",
                        "env-var values other than the single allowlisted profile key",
                    ],
                },
                "denials": guard_receipt.get("denials", {}),
            },
            "runtime_only_pending": list(RUNTIME_ONLY_PENDING),
            "budget_targets": BUDGET_TARGETS,
            "cache": cache if cache is not None else {
                "mode": "off", "enabled": False, "path": "", "state": "disabled",
                "schema_version": None, "reason": "not opened for this run",
                "writes": "disabled", "rows": {}, "snapshot": None, "pi_state": None,
            },
            "lanes": {"total": len(emitted), "by_field_state": dict(sorted(by_state.items()))},
            "projection": projection.to_dict() if projection is not None else {
                "mode": "full",
                "tokens": None,
                "fields": None,
                "lane_keys": None,
                "session_derived": True,
                "note": "no projection: every lane key and every field is emitted",
            },
            "timings_ms": timings,
            "wall_ms": round(wall_ms, 3),
            "filters": filters,
            "sort": sorts,
        },
        "global": global_block,
        "lanes": emitted,
        "diagnostics": diagnostics,
    }
    if watch is not None:
        doc["behold"]["watch"] = watch
    return doc


def to_json(doc: dict[str, Any]) -> str:
    return json.dumps(doc, indent=2, sort_keys=False, ensure_ascii=False)


# --- markdown ---------------------------------------------------------------------

def _short(value: Any, limit: int = 44) -> str:
    if value is None:
        return "—"
    if isinstance(value, (dict, list)):
        text = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    else:
        text = str(value)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _state_text(field: dict[str, Any], limit: int = 44) -> str:
    state = field["state"]
    if state == "present":
        return _short(field["value"], limit)
    if state in ("stale", "expired", "divergent", "inferred", "conflict"):
        return f"{state}: {_short(field['value'], limit)}"
    if state == "withheld":
        return "withheld (class 2)"
    if state == "held":
        return f"held ({field.get('reason')})"
    if state in ("unknown", "absent", "error"):
        return f"{state}: {field.get('reason')}"
    return state


#: (column, field id, dotted path inside the field's value, or None for the whole value)
LANE_COLUMNS = (
    ("lane", "H-4", None),
    ("workspace", "H-1", None),
    ("pane", "H-3", None),
    ("status", "H-5", "status"),
    ("model", "P-2", "physical"),
    ("ctx%", "T-3", None),
    ("branch", "R-1", "branch"),
    ("dirty", "R-3", "dirty_total"),
    ("todos", "D-1", "total"),
    ("beads", "B-1", "count"),
    ("identity", "P-4", None),
)


def _dig(value: Any, path: str | None) -> Any:
    if path is None or not isinstance(value, dict):
        return value
    current: Any = value
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def to_markdown(doc: dict[str, Any], *, full: bool = False,
                lane_keys: Iterable[str] | None = None,
                projection: Projection | None = None) -> str:
    behold = doc["behold"]
    lines: list[str] = []
    lines.append("# behold roster")
    lines.append("")
    lines.append(
        f"derived on demand · read-only · {behold['lanes']['total']} lanes · "
        f"generated {behold['generated_at']} · as-of {behold['as_of']}"
    )
    lines.append("")
    lines.append(
        f"snapshot: protocol {behold['snapshot']['protocol']} · agents {behold['snapshot']['agents']} · "
        f"panes {behold['snapshot']['panes']} · workspaces {behold['snapshot']['workspaces']}"
    )
    denials = behold["privacy"]["denials"]
    lines.append(
        "privacy: counts and paths only · held workspaces "
        f"{', '.join(behold['privacy']['rules']['held_workspaces'])} · reserved panes "
        f"{', '.join(behold['privacy']['rules']['reserved_panes'])} · denials "
        f"{json.dumps(denials, sort_keys=True)}"
    )
    cache = behold.get("cache") or {}
    if cache.get("enabled"):
        snapshot = cache.get("snapshot") or {}
        pi_state = cache.get("pi_state") or {}
        lines.append(
            f"cache: {cache.get('state')} · {cache.get('path')} · schema v"
            f"{cache.get('schema_version')} · topology {snapshot.get('state', 'absent')} · "
            f"pi rows {pi_state.get('rows', 0)}"
        )
    else:
        lines.append(
            f"cache: disabled · mode {cache.get('mode')} · "
            f"{cache.get('reason') or 'not opened for this run'}")
    lines.append("")
    if behold.get("watch"):
        watch = behold["watch"]
        lines.append(
            f"watch: iteration {watch.get('iteration')} · changed {watch.get('changed_sources')} · "
            f"refreshed lanes {watch.get('refreshed_lanes')} · stale lanes {watch.get('stale_lanes')}"
        )
        lines.append("")
    lanes = doc["lanes"]
    if lane_keys is not None:
        wanted = set(lane_keys)
        lanes = [lane for lane in lanes if lane.get("key") in wanted]
    if not lanes:
        lines.append("_no lanes matched_")
    else:
        lines.append("| " + " | ".join(column[0] for column in LANE_COLUMNS) + " |")
        lines.append("|" + "---|" * len(LANE_COLUMNS))
        for lane in lanes:
            cells = []
            for name, field_id, path in LANE_COLUMNS:
                if name == "lane":
                    cells.append(_short(lane["handles"].get("name")))
                elif name == "pane":
                    cells.append(_short(lane["key"]))
                elif name == "identity":
                    ident = lane.get("identity") or {}
                    cells.append(_short(f"{ident.get('state')} · {ident.get('session_id')}", 30))
                else:
                    field = lane["fields"].get(field_id)
                    if field is None:
                        # A projected-away field is *omitted*, and says so. It is not
                        # rendered as "—" (which reads as "no value").
                        cells.append("omitted" if projection is not None else "—")
                    elif field["state"] == "present" and path:
                        cells.append(_short(_dig(field["value"], path), 30))
                    else:
                        cells.append(_state_text(field, 30))
            lines.append("| " + " | ".join(cells) + " |")
    lines.append("")
    lines.append("## pending runtime-only metrics")
    lines.append("")
    for item in behold["runtime_only_pending"]:
        lines.append(f"- {item}")
    lines.append("")
    lines.append("## budget targets (not measured whole-fleet proof)")
    lines.append("")
    for key, value in behold["budget_targets"].items():
        if key == "note":
            continue
        lines.append(f"- {key}: {value}")
    lines.append("")
    if full or lane_keys:
        omitted_ids = [field_id for field_id in FIELD_IDS
                       if projection is not None and field_id not in projection.field_ids]
        for lane in lanes:
            lines.append(f"## {lane['key']} — {(lane.get('handles') or {}).get('name')}")
            lines.append("")
            admission = lane.get("admission") or {}
            if not admission.get("admitted"):
                lines.append(f"held before any path read: `{admission.get('reason')}`")
                lines.append("")
            if projection is not None and omitted_ids:
                lines.append(
                    "omitted by the projection (not emitted; no state was altered): "
                    + ", ".join(omitted_ids))
                lines.append("")
            for field_id in sorted(lane["fields"], key=_field_sort_key):
                field = lane["fields"][field_id]
                lines.append(
                    f"- **{field_id}** `{field['state']}`/{field['class']}: {_state_text(field, 200)}"
                )
                meta = []
                if field.get("source"):
                    meta.append(f"source `{field['source']}`")
                if field.get("method"):
                    meta.append(f"method `{field['method']}`")
                if field.get("age_s") is not None:
                    meta.append(f"age {field['age_s']}s")
                if field.get("reason") and field["state"] == "present":
                    meta.append(f"reason {field['reason']}")
                if field.get("note"):
                    meta.append(f"note {field['note']}")
                if meta:
                    lines.append(f"  - {' · '.join(meta)}")
            lines.append("")
    if doc.get("diagnostics"):
        lines.append("## diagnostics")
        lines.append("")
        for item in doc["diagnostics"]:
            lines.append(f"- {json.dumps(item, sort_keys=True, ensure_ascii=False)}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _field_sort_key(field_id: str) -> tuple[str, int]:
    prefix, _, number = field_id.partition("-")
    try:
        return (prefix, int(number))
    except ValueError:
        return (prefix, 0)


_ = F  # field types are consumed via lane dicts; imported for type reference in docs
