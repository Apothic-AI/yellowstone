#!/usr/bin/env python3
"""Audit the bead<->pane join: beads carrying join metadata vs the live herdr inventories.

Two independent inventories are read, and they answer different questions:

  herdr pane list    the FULL pane inventory (every pane, 62 on 2026-11-12). A pane
                     present here EXISTS. Absence here is the only evidence that a
                     joined pane is gone.
  herdr agent list   the RECOGNIZED-AGENT inventory (38 of those 62 panes). A pane
                     missing here has no agent herdr recognizes; it is not dead.

States (FT-58), never two:

  LIVE                a join is recorded, the pane exists, and a recognized agent holds it.
  UNRECOGNIZED_AGENT  a join is recorded and the pane exists, but no agent in the
                      recognized-agent inventory holds it. The join is present in the
                      pane inventory, so this is NOT an orphan and NOT a dead pane.
  ORPHAN              a join is recorded and the pane is ABSENT from the full pane
                      inventory. Only this is an orphan.
  INCONSISTENT        a join is recorded, a recognized agent holds the pane, but the
                      pane row is absent from the pane inventory. Two reads disagree;
                      report, never classify as dead.
  UNATTRIBUTED        a claim carries NO join at all. This is not an orphan: the absence
                      of a join says how the claim was written, not whether anyone is
                      working. The ordinary claim path can complete without recording a
                      join, so absence must never be read as abandonment.

Denominators are printed separately and never mixed:

  claims               beads with status in_progress in the selected bead scope.
  joined_claims        those claims that carry a join.  UNATTRIBUTED = claims - joined_claims.
  unattributed         claims with no join. Denominated against CLAIMS only.
  orphan_claims        claims whose join names an absent pane. Denominated against CLAIMS only.
  joined_all_statuses  every in-scope bead carrying a join, any status. Reported on its own
                       denominator; orphan_all_statuses is measured against THIS, not claims.

A failed or WRONG-SHAPED read is UNKNOWN, never a count. Syntactically valid JSON of the
wrong schema is the dangerous case: `{"result": []}` parses, yields no rows, and would make
every join look dead. Every read is therefore validated (top-level object, result object,
result.type, row list, required row key names and types) before any classification, and a
validation failure prints UNKNOWN with the reason and exits non-zero with no numeric count.

Bead scope is explicit. `bd list --all` omits gate issues (bd 1.3.2: --include-gates
"Include gate issues in output (normally hidden)"); the default read here passes
--include-gates --limit 0 so the scope is all statuses and all types, and the gate row
count is printed. --exclude-gates narrows the scope and then says so, with the count of
gate rows omitted (measured in the same validated read).

Exit: 0 when the join was measured (even if orphans were found — this reports, it does not
gate); 2 when it could not be measured; 64 on usage error.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys

EXIT_OK = 0
EXIT_UNKNOWN = 2
EXIT_USAGE = 64
VERSION = 2

STATE_DEFS = (
    "LIVE = join recorded, pane exists, recognized agent holds it | "
    "UNRECOGNIZED_AGENT = join recorded, pane exists, no recognized agent (not an orphan) | "
    "ORPHAN = join recorded, pane absent from the FULL pane inventory | "
    "INCONSISTENT = recognized agent but no pane row (report, not death) | "
    "UNATTRIBUTED = claim with no join recorded (not an orphan)"
)


class SchemaError(Exception):
    """A read returned something this tool cannot interpret. Never a count."""


def _require(cond, message):
    if not cond:
        raise SchemaError(message)


def _type_name(value):
    return "null" if value is None else type(value).__name__


def sh(args):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        raise SchemaError(f"{' '.join(args)}: timed out after 60s")
    except OSError as exc:
        raise SchemaError(f"{' '.join(args)}: could not run ({type(exc).__name__}: {exc})")


def read_json(args, what, validator):
    """Run args, parse JSON, validate the expected schema. Raises SchemaError."""
    proc = sh(args)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()[:300]
        raise SchemaError(f"{what}: exit {proc.returncode}: {detail or '(no stderr)'}")
    try:
        value = json.loads(proc.stdout)
    except Exception as exc:  # JSONDecodeError, or empty stdout
        raise SchemaError(
            f"{what}: not JSON ({type(exc).__name__}: {exc}); "
            f"first 200 bytes: {proc.stdout[:200]!r}"
        )
    return validator(value)


def _herdr_rows(obj, what, result_type, key):
    _require(isinstance(obj, dict), f"{what}: top level is {_type_name(obj)}, expected an object")
    _require("result" in obj, f"{what}: no 'result' key (keys: {sorted(obj)})")
    result = obj["result"]
    _require(isinstance(result, dict), f"{what}: 'result' is {_type_name(result)}, expected an object")
    got_type = result.get("type")
    _require(
        got_type == result_type,
        f"{what}: result.type is {got_type!r}, expected {result_type!r} "
        "(this is valid JSON of the wrong schema)",
    )
    _require(key in result, f"{what}: result has no {key!r} key (keys: {sorted(result)})")
    rows = result[key]
    _require(isinstance(rows, list), f"{what}: result.{key} is {_type_name(rows)}, expected a list")
    return rows


def validate_pane_inventory(obj):
    """Full pane inventory: result.type == pane_list, result.panes[].pane_id is a string."""
    rows = _herdr_rows(obj, "pane list read", "pane_list", "panes")
    for i, row in enumerate(rows):
        _require(isinstance(row, dict), f"pane list read: panes[{i}] is {_type_name(row)}, expected an object")
        pane_id = row.get("pane_id")
        _require(
            isinstance(pane_id, str) and pane_id,
            f"pane list read: panes[{i}].pane_id is {_type_name(pane_id)}, expected a non-empty string",
        )
        for optional in ("label", "agent", "agent_status"):
            value = row.get(optional)
            _require(
                value is None or isinstance(value, str),
                f"pane list read: panes[{i}].{optional} is {_type_name(value)}, expected string or null",
            )
        sess = row.get("agent_session")
        _require(
            sess is None or isinstance(sess, dict),
            f"pane list read: panes[{i}].agent_session is {_type_name(sess)}, expected object or null",
        )
    return rows


def validate_agent_inventory(obj):
    """Recognized-agent inventory: result.type == agent_list, result.agents[].pane_id is a string."""
    rows = _herdr_rows(obj, "agent list read", "agent_list", "agents")
    for i, row in enumerate(rows):
        _require(isinstance(row, dict), f"agent list read: agents[{i}] is {_type_name(row)}, expected an object")
        pane_id = row.get("pane_id")
        _require(
            isinstance(pane_id, str) and pane_id,
            f"agent list read: agents[{i}].pane_id is {_type_name(pane_id)}, expected a non-empty string",
        )
        for optional in ("name", "agent", "agent_status"):
            value = row.get(optional)
            _require(
                value is None or isinstance(value, str),
                f"agent list read: agents[{i}].{optional} is {_type_name(value)}, expected string or null",
            )
        sess = row.get("agent_session")
        _require(
            sess is None or isinstance(sess, dict),
            f"agent list read: agents[{i}].agent_session is {_type_name(sess)}, expected object or null",
        )
    return rows


def validate_bead_list(obj):
    """`bd list --json` returns an array of issue objects with id/status/metadata."""
    _require(isinstance(obj, list), f"bead list read: top level is {_type_name(obj)}, expected an array")
    for i, row in enumerate(obj):
        _require(isinstance(row, dict), f"bead list read: rows[{i}] is {_type_name(row)}, expected an object")
        for key in ("id", "status"):
            value = row.get(key)
            _require(
                isinstance(value, str) and value,
                f"bead list read: rows[{i}].{key} is {_type_name(value)}, expected a non-empty string",
            )
        for key in ("assignee", "issue_type"):
            value = row.get(key)
            _require(
                value is None or isinstance(value, str),
                f"bead list read: rows[{i}].{key} is {_type_name(value)}, expected string or null",
            )
        md = row.get("metadata")
        _require(
            md is None or isinstance(md, dict),
            f"bead list read: rows[{i}].metadata is {_type_name(md)}, expected object or null",
        )
    return obj


def join_pane(bead):
    """Return (pane_id or None, session or ''). Metadata is the only join source."""
    md = bead.get("metadata") or {}
    pane = md.get("agent_pane")
    if not isinstance(pane, str) or not pane:
        pane = None
    session = md.get("agent_session")
    if not isinstance(session, str):
        session = ""
    return pane, session


def session_value(entry):
    if not isinstance(entry, dict):
        return ""
    sess = entry.get("agent_session")
    if isinstance(sess, dict):
        value = sess.get("value")
        if isinstance(value, str):
            return value
    return ""


def classify(bead, panes, agents):
    """Return a row dict. `panes` is the full pane inventory; `agents` is recognized-only."""
    pane, sess = join_pane(bead)
    status = bead.get("status")
    assignee = bead.get("assignee") or ""
    verdicts = []

    if status == "closed":
        verdicts.append("CLOSED-STALE")

    pane_row = panes.get(pane) if pane else None
    agent_row = agents.get(pane) if pane else None

    if pane is None:
        state = "UNATTRIBUTED"
        verdicts.append("NO-JOIN-RECORDED")
    elif pane_row is None and agent_row is None:
        state = "ORPHAN"
        verdicts.append("PANE-ABSENT-FROM-PANE-INVENTORY")
    elif pane_row is None:
        state = "INCONSISTENT"
        verdicts.append("RECOGNIZED-AGENT-WITHOUT-PANE-ROW")
    elif agent_row is None:
        state = "UNRECOGNIZED_AGENT"
        verdicts.append("PANE-EXISTS-NO-RECOGNIZED-AGENT")
    else:
        state = "LIVE"

    holder = None
    if agent_row is not None:
        holder = agent_row.get("name") or None
    if holder is None and pane_row is not None:
        holder = pane_row.get("label") or None

    if state in ("LIVE", "INCONSISTENT"):
        if assignee and holder and holder != assignee:
            verdicts.append(f"PANE-HELD-BY-{holder}")
        elif assignee and not holder:
            verdicts.append("UNNAMED-AGENT")
        elif not assignee:
            # A join with no claimant recorded: real, and LIVE. Not a mismatch
            # (there is nothing to mismatch against) and never an orphan.
            verdicts.append("JOINED-WITHOUT-ASSIGNEE")
        live_session = session_value(agent_row) or session_value(pane_row)
        if sess and live_session and sess != live_session:
            verdicts.append("SESSION-STALE")

    return {
        "id": bead.get("id"),
        "status": status,
        "type": bead.get("issue_type"),
        "assignee": assignee,
        "pane": pane,
        "pane_exists": pane_row is not None,
        "recognized_agent": agent_row is not None,
        "holder": holder,
        "state": state,
        "verdicts": verdicts,
    }


def flagged_rows(rows):
    """Rows a reviewer must look at. A flag is a question, never a mutation order."""
    return [
        r
        for r in rows
        if r["state"] != "LIVE"
        or any(
            v.startswith(("PANE-HELD-BY-", "SESSION-", "CLOSED-"))
            or v in ("JOINED-WITHOUT-ASSIGNEE", "UNNAMED-AGENT")
            for v in r["verdicts"]
        )
    ]


def measure(include_gates):
    pane_rows = read_json(
        ["herdr", "pane", "list"], "pane list read", validate_pane_inventory
    )
    agent_rows = read_json(
        ["herdr", "agent", "list"], "agent list read", validate_agent_inventory
    )
    beads = read_json(
        ["bd", "list", "--all", "--include-gates", "--limit", "0", "--json"],
        "bead list read",
        validate_bead_list,
    )

    panes = {row["pane_id"]: row for row in pane_rows}
    agents = {row["pane_id"]: row for row in agent_rows}

    gate_rows = [b for b in beads if b.get("issue_type") == "gate"]
    scope = [b for b in beads if include_gates or b.get("issue_type") != "gate"]

    rows = []
    for bead in scope:
        pane, _ = join_pane(bead)
        if pane is None and bead.get("status") != "in_progress":
            continue  # no join and not a claim: nothing to audit
        rows.append(classify(bead, panes, agents))

    claims = [b for b in scope if b.get("status") == "in_progress"]
    joined_all = [b for b in scope if join_pane(b)[0] is not None]
    joined_claims = [b for b in claims if join_pane(b)[0] is not None]

    claim_ids = {b.get("id") for b in claims}
    orphan_rows = [r for r in rows if r["state"] == "ORPHAN"]
    counts = {}
    for r in rows:
        counts[r["state"]] = counts.get(r["state"], 0) + 1
    claim_counts = {}
    for r in rows:
        if r["id"] in claim_ids:
            claim_counts[r["state"]] = claim_counts.get(r["state"], 0) + 1

    status_counts = {}
    for bead in scope:
        key = bead.get("status") or "?"
        status_counts[key] = status_counts.get(key, 0) + 1
    type_counts = {}
    for bead in scope:
        key = bead.get("issue_type") or "?"
        type_counts[key] = type_counts.get(key, 0) + 1

    return {
        "scope": {
            "statuses": "all (--all)",
            "types": "all" if include_gates else "all except gates",
            "gates_included": include_gates,
            "gate_rows_present": len(gate_rows),
            "gate_rows_in_scope": 0 if not include_gates else len(gate_rows),
            "gate_rows_excluded": 0 if include_gates else len(gate_rows),
            "rows_in_scope": len(scope),
            "rows_read": len(beads),
            "limit": 0,
            "command": "bd list --all --include-gates --limit 0 --json",
            "status_counts": status_counts,
            "type_counts": type_counts,
        },
        "inventory": {
            "panes": len(panes),
            "recognized_agents": len(agents),
            "pane_only": len([p for p in panes if p not in agents]),
            "agent_only": len([p for p in agents if p not in panes]),
        },
        "coverage": {
            "claims": len(claims),
            "joined_claims": len(joined_claims),
            "unattributed": len(claims) - len(joined_claims),
            "orphan_claims": len([r for r in orphan_rows if r["id"] in claim_ids]),
            "joined_all_statuses": len(joined_all),
            "orphan_all_statuses": len(orphan_rows),
        },
        "counts": counts,
        "claim_counts": claim_counts,
        "flagged": flagged_rows(rows),
        "states": STATE_DEFS,
        "rows": rows,
    }


def render(report, stream=sys.stdout):
    scope = report["scope"]
    inv = report["inventory"]
    cov = report["coverage"]

    if scope["gates_included"]:
        gate_line = (
            f"gates INCLUDED: {scope['gate_rows_present']} gate row(s) in scope "
            "(plain `bd list --all` omits them: --include-gates 'normally hidden')"
        )
    else:
        gate_line = (
            f"gates EXCLUDED: {scope['gate_rows_excluded']} gate row(s) omitted "
            f"(read and counted in the same validated read; {scope['rows_in_scope']} row(s) in scope)"
        )
    print(
        f"bead scope: statuses={scope['statuses']} types={scope['types']} "
        f"rows_in_scope={scope['rows_in_scope']} rows_read={scope['rows_read']} limit={scope['limit']}",
        file=stream,
    )
    print(f"  {gate_line}", file=stream)
    print(
        "  statuses: "
        + ", ".join(f"{k}={v}" for k, v in sorted(scope["status_counts"].items()))
        + " | types: "
        + ", ".join(f"{k}={v}" for k, v in sorted(scope["type_counts"].items())),
        file=stream,
    )
    print(
        f"inventories: panes={inv['panes']} recognized_agents={inv['recognized_agents']} "
        f"pane_only(no recognized agent)={inv['pane_only']} agent_only={inv['agent_only']}",
        file=stream,
    )
    print("join source: bead metadata field 'agent_pane' (plus 'agent_session')", file=stream)
    print(
        "coverage: "
        f"claims={cov['claims']} "
        f"(joined_claims={cov['joined_claims']} "
        f"UNATTRIBUTED={cov['unattributed']} "
        f"ORPHAN_claims={cov['orphan_claims']}) "
        f"| joined_all_statuses={cov['joined_all_statuses']} "
        f"(ORPHAN_all_statuses={cov['orphan_all_statuses']})",
        file=stream,
    )
    print("  UNATTRIBUTED and ORPHAN_claims are denominated against claims only;", file=stream)
    print("  ORPHAN_all_statuses is denominated against joined_all_statuses, never against claims.", file=stream)
    print(f"states: {report['states']}", file=stream)
    print(file=stream)

    rows = report["rows"]
    if rows:
        width = max(len(str(r["id"])) for r in rows)
        for r in sorted(rows, key=lambda x: (x["state"] == "LIVE", str(x["id"]))):
            holder = r["holder"] or "-"
            pane = r["pane"] or "-"
            print(
                f"{str(r['id']):<{width}}  {str(r['status']):<12} {str(r['assignee'])[:26]:<26} "
                f"pane={pane:<9} holds={holder:<26} {r['state']:<18} {','.join(r['verdicts'])}",
                file=stream,
            )
        print(file=stream)

    flagged = report["flagged"]
    print(
        f"beads flagged for review: {len(flagged)} "
        f"(state != LIVE, or a verdict names a claim/assignee question) | "
        f"ORPHAN claims: {cov['orphan_claims']}",
        file=stream,
    )
    print(
        f"UNRECOGNIZED_AGENT (pane alive, no recognized agent — not orphans): "
        f"{report['counts'].get('UNRECOGNIZED_AGENT', 0)}",
        file=stream,
    )


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Audit the bead<->pane join against the full pane and recognized-agent inventories."
    )
    parser.add_argument(
        "--exclude-gates",
        action="store_true",
        help="drop gate issues from the bead scope; the omitted count is still reported",
    )
    parser.add_argument("--json", action="store_true", help="emit the report as JSON")
    args = parser.parse_args(argv)

    try:
        report = measure(include_gates=not args.exclude_gates)
    except SchemaError as exc:
        print(f"UNKNOWN: could not measure the join: {exc}", file=sys.stderr)
        print(
            "no count is reported: the read this tool depends on failed validation",
            file=sys.stderr,
        )
        return EXIT_UNKNOWN

    report["tool"] = "join-audit"
    report["version"] = VERSION
    if args.json:
        json.dump(report, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
    else:
        render(report)
    return EXIT_OK


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("UNKNOWN: interrupted; no count is reported", file=sys.stderr)
        sys.exit(EXIT_UNKNOWN)
