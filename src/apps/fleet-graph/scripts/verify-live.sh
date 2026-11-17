#!/usr/bin/env bash
# verify-live.sh — the app's own gate: start it, read the API, render both routes in a
# real browser, and check that what the DOM contains is what the API said.
#
# It is deliberately outside the app: a suite that mocks the fleet proves only that the
# mocks work. This one runs against whatever the machine currently is.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

PORT="${FLEET_GRAPH_PORT:-5199}"
BASE="http://127.0.0.1:${PORT}"
LOG="${TMPDIR:-/tmp}/fleet-graph-verify.log"
PROFILE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fleet-graph-chrome.XXXXXX")"
STATE_JSON="$(mktemp "${TMPDIR:-/tmp}/fleet-graph-state.XXXXXX.json")"
DOM_FLEET="$(mktemp "${TMPDIR:-/tmp}/fleet-graph-fleet.XXXXXX.html")"
DOM_WORK="$(mktemp "${TMPDIR:-/tmp}/fleet-graph-work.XXXXXX.html")"

fails=0
pass() { echo "  ok   $*"; }
fail() { echo "  FAIL $*"; fails=$((fails + 1)); }

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    # Signal the process group this script started, never a command-line pattern.
    kill -TERM -- "-${SERVER_PID}" 2>/dev/null || kill -TERM "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$PROFILE_DIR" "$STATE_JSON" "$DOM_FLEET" "$DOM_WORK"
}
trap cleanup EXIT

echo "fleet-graph: starting vite on :${PORT}"
setsid pnpm exec vite --host 127.0.0.1 --port "$PORT" --strictPort >"$LOG" 2>&1 &
SERVER_PID=$!

ready=0
for _ in $(seq 1 90); do
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "server did not come up; log:"; tail -40 "$LOG"; exit 1; }
pass "vite answering on ${PORT}"

echo "fleet-graph: reading /api/state"
curl -fsS "$BASE/api/state" >"$STATE_JSON"

python3 - "$STATE_JSON" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
s = state["summary"]
print("  api  workspaces=%d lanes=%d leaders=%d workers=%d unknown_role=%d" % (
    s["workspaces"], s["lanes"], s["leaders"], s["workers"], s["unknown_role"]))
print("  api  beads=%d open=%d assigned=%d derived_joins=%d projects=%d components=%d" % (
    s["beads_total"], s["beads_open"], s["assigned"], s["derived_joins"], s["projects"], s["components"]))
print("  api  build_ms=%d sources=%s" % (state["build_ms"], ", ".join(
    ("%s:%s" % (x["name"], "ok" if x["ok"] else "FAIL")) for x in state["sources"])))
assert s["lanes"] > 0, "no lanes read"
assert s["workspaces"] > 0, "no workspaces read"
assert s["beads_total"] > 0, "no beads read"
assert s["leaders"] > 0, "no leader lanes resolved"
ok = [x for x in state["sources"] if x["ok"]]
assert len(ok) >= 3, "fewer than three sources answered"
assert state["rooms"]["available"], "rooms store unavailable"
PY
pass "api assertions"

echo "fleet-graph: rendering routes in headless Chrome"
render() { # url out
  google-chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
    --user-data-dir="$PROFILE_DIR" --virtual-time-budget=12000 --dump-dom "$1" >"$2" 2>/dev/null
}
render "$BASE/" "$DOM_FLEET"
render "$BASE/work" "$DOM_WORK"

dom_lanes=$(grep -o 'data-lane="' "$DOM_FLEET" | wc -l | tr -d ' ')
dom_lane_attr=$(grep -o 'data-lane-count="[0-9]*"' "$DOM_FLEET" | head -1 | grep -o '[0-9]*' || true)
dom_beads=$(grep -o 'data-bead-id="' "$DOM_WORK" | wc -l | tr -d ' ')
dom_projects=$(grep -o 'data-project="' "$DOM_WORK" | wc -l | tr -d ' ')
api_lanes=$(python3 -c "import json,sys;print(json.load(open('$STATE_JSON'))['summary']['lanes'])")
api_beads=$(python3 -c "import json,sys;print(json.load(open('$STATE_JSON'))['summary']['beads_total'])")

echo "  dom  fleet: $dom_lanes lane cards (api says $api_lanes, rendered count attr ${dom_lane_attr:-none})"
echo "  dom  work:  $dom_beads bead cards, $dom_projects project lanes (api says $api_beads beads)"

[ "$dom_lanes" -gt 0 ] || fail "no lane card rendered in the Fleet View"
[ "$dom_lanes" -le "$api_lanes" ] || fail "more lane cards than the API reported"
[ "${dom_lane_attr:-0}" = "$api_lanes" ] || fail "rendered lane count attribute does not match the API"
[ "$dom_beads" -gt 0 ] || fail "no bead card rendered in the Work View"
[ "$dom_projects" -gt 0 ] || fail "no project lane rendered in the Work View"
[ "$dom_beads" -le "$api_beads" ] || fail "more bead cards than the API reported"
grep -q 'data-graph-view="fleet"' "$DOM_FLEET" || fail "Fleet View marker missing"
grep -q 'data-graph-view="work"' "$DOM_WORK" || fail "Work View marker missing"
grep -q 'data-parent-source="record"\|derived edge\|spawned by record' "$DOM_FLEET" || echo "  note no recorded-parent edge on screen yet (no lane has PI_SPAWNED_BY)"

if [ "$fails" = 0 ]; then
  echo "gate passed: the app renders the live fleet ($dom_lanes lanes, $dom_beads beads)"
else
  echo "gate FAILED: $fails check(s)"
fi
exit "$(( fails > 0 ))"
