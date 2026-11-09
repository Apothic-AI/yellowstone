#!/usr/bin/env bash
# verify-mode-composition — prove a lane's composed prompt from its own transcript.
#
# Why this exists: a mode composition is all-or-nothing. A rejected overlay, a missing
# confirmation flag, or an untrusted project directory drops the lane to the native base
# prompt — losing the *base* role contract as well as the delta — with one line of stderr an
# interactive lane scrolls past. `/proc` shows what was selected, never what reached the
# model. So the only honest check is two counts: the base contract AND the overlay text.
# One alone is a failure, in opposite directions:
#   base only  -> the overlay did not load
#   overlay only -> something replaced the base instead of appending to it
#
# Scope of the count (fixed 2026-11-02): the markers are counted in the *composed prompt* —
# the system message's `sections.preamble` — not in the raw transcript. A raw grep counts the
# lane's own tool output, where a verification command or a `read` of a mode file legitimately
# quotes those very strings; that produced a false base=4/overlay=7 with a phantom forbidden
# hit on the first run of this check, i.e. a FAIL for a lane that was composed correctly.
#
# Usage:
#   verify-mode-composition.sh <pane> <base-marker> <overlay-marker> [--forbid <marker> ...]
# Exit: 0 both present (and no forbidden marker), 1 otherwise, 2 no session yet.
set -uo pipefail
pane="${1:?usage: verify-mode-composition.sh <pane> <base-marker> <overlay-marker> [--forbid <marker>]}"
base="${2:?base marker required}"
overlay="${3:?overlay marker required}"
shift 3
forbid=()
while [ "$#" -gt 0 ]; do
  case "$1" in --forbid) shift; [ "$#" -gt 0 ] && forbid+=("$1") ;; esac
  shift
done

sess=$(herdr agent get "$pane" 2>/dev/null | python3 -c 'import json,sys
d=(json.load(sys.stdin).get("result") or {}).get("agent") or {}
print(((d.get("agent_session") or {}).get("value")) or "")' 2>/dev/null)
[ -n "$sess" ] && [ -f "$sess" ] || { echo "NO-SESSION $pane (run a turn first)"; exit 2; }

python3 - "$sess" "$base" "$overlay" "${forbid[@]:-}" <<'PY'
import json, sys
path, base, overlay = sys.argv[1], sys.argv[2], sys.argv[3]
forbidden = [f for f in sys.argv[4:] if f]

# The composed prompt lives in the system message's `sections`; take the most recent one
# (a session can carry several after a model or mode change).
preamble, source = None, None
raw = open(path, encoding="utf-8", errors="replace").read()
for line in raw.splitlines():
    line = line.strip()
    if not line:
        continue
    try:
        d = json.loads(line)
    except Exception:
        continue
    msg = d.get("message") or {}
    sec = msg.get("sections")
    if msg.get("role") == "system" and isinstance(sec, dict):
        text = sec.get("preamble")
        if isinstance(text, str) and text:
            preamble, source = text, "sections.preamble"

if preamble is None:
    # Older transcript shape: no sections, so the system message body is the only place the
    # prompt could be. Counting the raw file here is the trap this script was fixed for, so
    # say so rather than quietly reporting a number that includes tool output.
    for line in raw.splitlines():
        try:
            d = json.loads(line.strip() or "null")
        except Exception:
            continue
        msg = (d or {}).get("message") or {}
        body = msg.get("content")
        if msg.get("role") == "system" and isinstance(body, str) and body:
            preamble, source = body, "message.content (legacy shape)"
if preamble is None:
    print("NO-SYSTEM-MESSAGE — transcript carries no composed prompt yet", file=sys.stderr)
    raise SystemExit(2)

b, o = preamble.count(base), preamble.count(overlay)
bad = {f: preamble.count(f) for f in forbidden if preamble.count(f)}
verdict = "PASS" if b and o and not bad else "FAIL"
why = []
if not b: why.append("base contract missing")
if not o: why.append("overlay missing")
for f, c in bad.items(): why.append(f"forbidden {f!r} present x{c}")
print(f"{verdict} base={b} overlay={o} chars={len(preamble)} [{source}]"
      + (" — " + "; ".join(why) if why else ""))
raise SystemExit(0 if verdict == "PASS" else 1)
PY