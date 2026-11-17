#!/usr/bin/env bash
# verify-lane-supervise-scope.sh — the coverage boundary of the fleet supervisor, as a test.
#
# FT-78 asked "does the supervisor monitor all fleet agents or only leaders?" and the answer was
# "leaders, plus whatever you --add" — but nothing in the tool said so. `--list` printed the lanes
# it covered and stayed silent about the rest, so an operator reading it concluded the fleet was
# covered. A worker lane named `experiment` was Ctrl-C'd and never came back, and no output anywhere
# said why. This test pins the boundary, in both directions:
#
#   1. a live worker is REPORTED as not supervised, with the reason and the lane named;
#   2. `--add` on a lane that is already down SEEDS the pane, session and ROLE from the lane's own
#      record, so the add can act at all after the fact;
#   3. a dry-run resume runs `pil --role worker`, never `--role leader` — the role comes from the
#      record, not from the default (the 2026-11-13 promotion defect in a different shape);
#   4. a resume REFUSES a pane that already holds a live pi, and one that no longer exists;
#   5. `--remove` drops the persisted state as well as the add, because a state file alone keeps a
#      lane discovered forever.
#
# Hermetic: herdr, behold and pil are stubbed from a JSON fixture, and XDG_STATE_HOME points at a
# temp dir, so it runs on a live machine without touching the real fleet and in a container with no
# herdr at all.
set -uo pipefail

REPO="$(cd "$(dirname -- "$0")/.." && pwd)"
TOOL="${LANE_SUPERVISE:-$REPO/home/.overlord/tools/lane-supervise}"
FAILED=0
PASSED=0

pass() { PASSED=$((PASSED + 1)); echo "ok   $1"; }
fail() { FAILED=$((FAILED + 1)); echo "FAIL $1"; shift; for line in "$@"; do printf '%s\n' "$line" | sed 's/^/     /'; done; }
check() { # check <name> <pattern> <text>
  if printf '%s' "$3" | grep -Eq -- "$2"; then pass "$1"; else fail "$1" "expected /$2/ in:" "$3"; fi
}
refute() { # refute <name> <pattern> <text>
  if printf '%s' "$3" | grep -Eq -- "$2"; then fail "$1" "did NOT expect /$2/ in:" "$3"; else pass "$1"; fi
}

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
STATE="$T/state"
BIN="$T/bin"
mkdir -p "$STATE/pil/roles" "$STATE/pil/sessions" "$STATE/pil/supervise" "$BIN"

# --- the lane records: a leader, a worker that is down, and a worker whose pane is occupied -------
printf 'PI_MODE=leader PI_PROFILE=leader\n' > "$STATE/pil/roles/space-leader.env"
printf 'PI_MODE=worker PI_PROFILE=worker\n' > "$STATE/pil/roles/experiment.env"
printf 'PI_MODE=worker PI_PROFILE=worker\n' > "$STATE/pil/roles/occupied-worker.env"
printf 'PI_MODE=worker PI_PROFILE=worker\n' > "$STATE/pil/roles/live-worker.env"

SESS="$T/sessions"
mkdir -p "$SESS"
printf '{}\n' > "$SESS/2026-11-17T11-46-09-425Z_01a1e954-2990-7539-a801-e423bdd70b5b.jsonl"
cat > "$STATE/pil/sessions/experiment.json" <<JSON
{"lane":"experiment","session":"$SESS/2026-11-17T11-46-09-425Z_01a1e954-2990-7539-a801-e423bdd70b5b.jsonl",
 "sessionId":"01a1e954-2990-7539-a801-e423bdd70b5b","paneId":"w1Z:p11","workspaceId":"w1Z",
 "tabId":"w1Z:tY","pid":1047296,"updatedAt":"2026-11-17T11:53:21.559Z","source":"extension"}
JSON
cat > "$STATE/pil/sessions/occupied-worker.json" <<JSON
{"lane":"occupied-worker","session":"$SESS/2026-11-17T11-46-09-425Z_01a1e954-2990-7539-a801-e423bdd70b5b.jsonl",
 "sessionId":"01a1e954-2990-7539-a801-e423bdd70b5b","paneId":"wE:p2","cwd":"/tmp"}
JSON

# --- stubs: herdr answers from a fixture, behold says lane-not-found, pil is never run ------------
cat > "$BIN/herdr" <<'PY'
#!/usr/bin/env python3
import json, os, sys
fx = json.load(open(os.environ["FT78_FIXTURE"]))
args = sys.argv[1:]
if args[:2] == ["agent", "list"]:
    print(json.dumps({"result": {"agents": fx.get("agents", [])}})); sys.exit(0)
if args[:2] == ["agent", "get"]:
    for a in fx.get("agents", []):
        if a.get("name") == args[2]:
            print(json.dumps({"result": {"agent": a}})); sys.exit(0)
    sys.stderr.write("agent not found\n"); sys.exit(1)
if args[:2] == ["pane", "list"]:
    panes = []
    for p in fx.get("panes", []):
        panes.append(p if isinstance(p, dict) else {"pane_id": p})
    print(json.dumps({"result": {"panes": panes}})); sys.exit(0)
if args[:2] == ["pane", "process-info"]:
    pane = args[args.index("--pane") + 1]
    procs = fx.get("foreground", {}).get(pane, [])
    print(json.dumps({"result": {"process_info": {"foreground_processes": procs}}})); sys.exit(0)
print(json.dumps({"result": {}}))
PY
cat > "$BIN/behold" <<'SH'
#!/usr/bin/env bash
echo '{"error":"lane-not-found"}' >&2
exit 5
SH
cat > "$BIN/pil" <<'SH'
#!/usr/bin/env bash
echo "PIL-RAN $*" >> "${FT78_PIL_LOG:-/dev/null}"
SH
chmod +x "$BIN/herdr" "$BIN/behold" "$BIN/pil"

export PATH="$BIN:$PATH"
export XDG_STATE_HOME="$STATE"
export FT78_FIXTURE="$T/fixture.json"
export FT78_PIL_LOG="$T/pil.log"
: > "$FT78_PIL_LOG"

fixture() { cat > "$FT78_FIXTURE"; }
run() { "$TOOL" "$@" 2>&1; }

# 1 ---------------------------------------------------------------------------------------------
# A live worker is reported as uncovered. This is the whole defect: silence read as coverage.
fixture <<'JSON'
{"agents":[{"name":"space-leader","pane_id":"w1:p1","agent_status":"idle","cwd":"/tmp/space"},
           {"name":"live-worker","pane_id":"w1:p9","agent_status":"idle","cwd":"/tmp/work"},
           {"name":"droid","pane_id":"w1:p10","agent_status":"idle","cwd":"/tmp/droid"}],
 "panes":[{"pane_id":"w1:p1","cwd":"/tmp/space"},
          {"pane_id":"w1:p9","cwd":"/tmp/work"},
          {"pane_id":"w1:p10","cwd":"/tmp/droid"},
          {"pane_id":"w1Z:p11","cwd":"/home/bitnom/Documents/Assistant"}],
 "foreground":{"w1:p1":[{"name":"pi","pid":11}],"w1:p9":[{"name":"pi","pid":99}]}}
JSON
out=$(run --list)
check "--list reports a live worker lane as uncovered, by name" 'live-worker .*worker role record' "$out"
check "--list reports a live lane with NO role record (invisible to discovery)" 'droid .*no role record' "$out"
check "--list still reports the supervised leader" 'space-leader.*leader' "$out"
check "--list says the down worker is not listed without --uncovered" 'not supervised, not live: 2' "$out"
out=$(run --list --uncovered)
check "--list --uncovered names the down worker (the FT-78 lane)" 'experiment .*experiment-pane|experiment .*worker role record' "$out"
jout=$(run --list --json)
check "--list --json carries uncovered_live" '"uncovered_live"' "$jout"
check "--list --json reports the inactive count" '"uncovered_inactive": 2' "$jout"

# 2 ---------------------------------------------------------------------------------------------
# `--add` after the lane is already down seeds pane, session AND role from the lane's own record.
out=$(run --add experiment)
check "--add seeds the pane" 'pane=w1Z:p11' "$out"
check "--add seeds the session id" 'session=01a1e954-2990-7539-a801-e423bdd70b5b' "$out"
check "--add seeds the ROLE (worker, not leader)" 'role=worker' "$out"
check "--add seeds where it seeded from" 'seeded_from|/sessions/experiment.json' "$out"
check "the seeded state carries role=worker" '"role": "worker"' "$(cat "$STATE/pil/supervise/experiment.json")"
check "the seeded state is discoverable" 'experiment.*added explicitly' "$(run --list)"
check "the seed took the cwd from the pane, not from \$HOME" '"cwd": "/home/bitnom/Documents/Assistant"' "$(cat "$STATE/pil/supervise/experiment.json")"

# 3 ---------------------------------------------------------------------------------------------
# A dry-run resume builds `pil --role worker`. Never leader, and never actually launched.
out=$(run --dry-run --only experiment)
check "dry-run plans a worker resume" "would run in w1Z:p11: cd '/home/bitnom/Documents/Assistant' && pil --role worker --session '01a1e954" "$out"
refute "dry-run never promotes the worker to leader" 'role leader' "$out"
if [ -s "$FT78_PIL_LOG" ]; then fail "dry-run must not launch pil" "$(cat "$FT78_PIL_LOG")"; else pass "dry-run launched nothing"; fi

# 4 ---------------------------------------------------------------------------------------------
# Pane hazards: occupied by another live pi, or gone entirely. Both refuse without typing.
cat > "$FT78_FIXTURE" <<'JSON'
{"agents":[{"name":"space-leader","pane_id":"w1:p1","agent_status":"idle","cwd":"/tmp/space"},
           {"name":"other-lane","pane_id":"wE:p2","agent_status":"idle","cwd":"/tmp/elsewhere"}],
 "panes":[{"pane_id":"w1:p1","cwd":"/tmp/space"},{"pane_id":"wE:p2","cwd":"/tmp/elsewhere"}],
 "foreground":{"w1:p1":[{"name":"pi","pid":11}],"wE:p2":[{"name":"pi","pid":222}]}}
JSON
run --add occupied-worker > /dev/null
out=$(run --dry-run --only occupied-worker)
check "refuses a pane another lane now occupies" "pane wE:p2 is now other-lane's" "$out"
refute "does not plan a run into an occupied pane" 'would run in wE:p2' "$out"
refute "does not rewrite the down lane's state to the foreign pane" 'would refresh state' "$out"

rm -f "$STATE/pil/supervise/experiment.json"
run --add experiment > /dev/null
out=$(run --dry-run --only experiment)
check "refuses a pane that no longer exists" 'no longer exists' "$out"
refute "does not plan a run in a vanished pane" 'would run in w1Z:p11' "$out"
if [ -s "$FT78_PIL_LOG" ]; then fail "no refusal may launch pil" "$(cat "$FT78_PIL_LOG")"; else pass "no refusal launched anything"; fi

# 5 ---------------------------------------------------------------------------------------------
# --remove must drop the persisted observation, or discovery keeps the lane forever.
run --add experiment > /dev/null
run --remove experiment > /dev/null
if [ -e "$STATE/pil/supervise/experiment.json" ]; then
  fail "--remove deletes the persisted state" "$(ls "$STATE/pil/supervise")"
else
  pass "--remove deletes the persisted state"
fi
out=$(run --list)
refute "--remove takes the lane out of discovery" '^experiment ' "$out"

echo
echo "passed: $PASSED  failed: $FAILED"
[ "$FAILED" -eq 0 ]
