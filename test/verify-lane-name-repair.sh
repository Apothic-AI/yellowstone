#!/usr/bin/env bash
# verify-lane-name-repair.sh — the naming repair loop's failure modes, as a test.
#
# FT-81. `repair-lane-names.sh` derives an agent name from its tab label, and nothing upstream
# prevents two tabs from carrying one label. The observed damage was a 155x `FAILED` loop from
# three one-pane tabs labelled `ft76-startup-probe`, each line a bare `FAILED` with no error body
# and no end. Four properties are pinned here, because each one was a separate defect:
#
#   1. a label two tabs share is REPORTED once, naming both tabs, and nothing in those tabs is
#      renamed — the run that used to be a silent refusal loop now says why;
#   2. a refused rename writes herdr's own error body (code and message) and names the holder;
#   3. a refusal that cannot succeed is NOT RETRIED on later runs, and a transient one is;
#   4. the timestamp is UTC, marked Z — it used to be local time with a Z appended.
#
# Hermetic: `herdr` is a stub reading JSON fixtures, and the log and suppression ledger point at
# a temp dir, so it runs on a live machine and in a container with no herdr at all.
set -uo pipefail

REPO="$(cd "$(dirname -- "$0")/.." && pwd)"
TOOL="${LANE_NAME_REPAIR:-$REPO/home/.overlord/tools/repair-lane-names.sh}"
FAILED=0
PASSED=0

pass() { PASSED=$((PASSED + 1)); echo "ok   $1"; }
fail() {
  FAILED=$((FAILED + 1)); echo "FAIL $1"; shift
  for line in "$@"; do printf '%s\n' "$line" | sed 's/^/     /'; done
}
check() { # check <name> <pattern> <text>
  if printf '%s' "$3" | grep -Eq -- "$2"; then pass "$1"; else fail "$1" "expected /$2/ in:" "$3"; fi
}
refute() { # refute <name> <pattern> <text>
  if printf '%s' "$3" | grep -Eq -- "$2"; then fail "$1" "did NOT expect /$2/ in:" "$3"; else pass "$1"; fi
}
check_eq() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected '$2', got '$3'"; fi
}

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
BIN="$T/bin"
STATE="$T/state"
LOG="$T/lane-names.log"
mkdir -p "$BIN" "$STATE"

# --- stub herdr -------------------------------------------------------------------------------
# Fixtures: tabs.json, agents.json. `agent rename` appends to renames.log, applies the rename to
# agents.json (so a later run sees the name), and refuses with rename-error.json when that file
# exists.
cat > "$BIN/herdr" <<'STUB'
#!/usr/bin/env python3
import json, os, sys

root = os.environ["STUB_ROOT"]
args = sys.argv[1:]


def read(path, default):
    try:
        with open(os.path.join(root, path)) as fh:
            return json.load(fh)
    except Exception:
        return default


def write(path, data):
    with open(os.path.join(root, path), "w") as fh:
        json.dump(data, fh, indent=1)


def out(data, code=0):
    sys.stdout.write(json.dumps(data) + "\n")
    raise SystemExit(code)


tabs = read("tabs.json", {"result": {"tabs": []}})
if args[:2] == ["tab", "list"]:
    out(tabs)
if args[:2] == ["tab", "get"]:
    for tab in tabs["result"]["tabs"]:
        if tab["tab_id"] == args[2]:
            out({"result": {"tab": tab}})
    out({"error": {"code": "tab_not_found", "message": "tab %s not found" % args[2]}}, 1)

agents = read("agents.json", {"result": {"agents": []}})
if args[:2] == ["agent", "list"]:
    out(agents)
if args[:2] == ["agent", "rename"]:
    pane, name = args[2], args[3]
    with open(os.path.join(root, "renames.log"), "a") as fh:
        fh.write("%s %s\n" % (pane, name))
    refusal = read("rename-error.json", None)
    if refusal:
        sys.stderr.write(json.dumps({"error": refusal, "id": "cli:agent:rename"}) + "\n")
        raise SystemExit(1)
    for agent in agents["result"]["agents"]:
        if agent["pane_id"] == pane:
            agent["name"] = name
    write("agents.json", agents)
    out({"id": "cli:agent:rename", "type": "ok"})

out({"error": {"code": "bad_request", "message": "unexpected call: %s" % " ".join(args)}}, 1)
STUB
chmod +x "$BIN/herdr"

tabs_fixture() { # tabs_fixture <json>
  printf '%s' "$1" > "$T/tabs.json"
}
agents_fixture() {
  printf '%s' "$1" > "$T/agents.json"
}
run() { # run — one pass of the tool against the stub
  rm -f "$T/renames.log"
  : > "$LOG"
  PATH="$BIN:$PATH" STUB_ROOT="$T" LANE_NAMES_LOG="$LOG" LANE_NAMES_STATE="$STATE/lane-names-state.json" \
    bash "$TOOL" >"$T/out.txt" 2>"$T/err.txt"
}
renames() { cat "$T/renames.log" 2>/dev/null || true; }
logtext() { cat "$LOG" 2>/dev/null || true; }

# --- 1. a label two tabs share is reported once, naming both, and nothing is renamed ---------
tabs_fixture '{"result":{"tabs":[
 {"tab_id":"w9:t1","label":"ft81-dup-probe","pane_count":1,"workspace_id":"w9"},
 {"tab_id":"w9:t2","label":"ft81-dup-probe","pane_count":1,"workspace_id":"w9"}]}}'
agents_fixture '{"result":{"agents":[
 {"pane_id":"w9:p1","tab_id":"w9:t1","name":""},
 {"pane_id":"w9:p2","tab_id":"w9:t2","name":""}]}}'
run
check "duplicate label is reported" 'duplicate-label' "$(logtext)"
check "the report names the first tab" 'w9:t1' "$(logtext)"
check "the report names the second tab" 'w9:t2' "$(logtext)"
check "the report names the colliding name" 'ft81-dup-probe' "$(logtext)"
check "the report says why it matters" 'merge' "$(logtext)"
check_eq "no pane in the colliding tabs was renamed" "" "$(renames)"
check "each pane is skipped with a pointer to the report" 'skip w9:p[12]: .*one of 2 tabs sharing it' "$(logtext)"
# The same collision on the next run must not repeat the report: 60x/hour is the defect.
printf '%s' "$(logtext)" > "$T/first-run.log"
run
check_eq "the second run repeats nothing" "" "$(logtext)"

# --- 2. a refused rename logs herdr's error body and names the holder ------------------------
# w9:p1 carries the name `held-name` but its tab is labelled something else (a lane renamed by
# hand, or from an earlier label), so the tab labels do not collide; the rename of w9:p2 is
# refused because the NAME is already held — the error-body path, not the tab-level guard.
tabs_fixture '{"result":{"tabs":[
 {"tab_id":"w9:t1","label":"other-label","pane_count":1,"workspace_id":"w9"},
 {"tab_id":"w9:t2","label":"held-name","pane_count":1,"workspace_id":"w9"}]}}'
agents_fixture '{"result":{"agents":[
 {"pane_id":"w9:p1","tab_id":"w9:t1","name":"held-name"},
 {"pane_id":"w9:p2","tab_id":"w9:t2","name":""}]}}'
printf '%s' '{"code":"agent_name_taken","message":"agent name held-name is already taken by w9:p1"}' > "$T/rename-error.json"
run
check "the refusal carries herdr's error code" 'FAILED w9:p2 -> held-name: agent_name_taken:' "$(logtext)"
check "the refusal carries herdr's message" 'already taken by w9:p1' "$(logtext)"
check "the refusal names the holder and its tab" 'held by w9:p1 in tab w9:t1' "$(logtext)"
check "the refusal says it will not be retried" 'not retried until' "$(logtext)"
check_eq "the refusal was attempted once" "w9:p2 held-name" "$(renames)"
run
check_eq "a second run logs nothing (no repeat, no retry)" "" "$(logtext)"
check_eq "and no second rename attempt" "" "$(renames)"
# The holder goes away: the refusal's cause is gone, so the pane is tried again.
agents_fixture '{"result":{"agents":[
 {"pane_id":"w9:p2","tab_id":"w9:t2","name":""}]}}'
rm -f "$T/rename-error.json"
run
check "a freed name is retried and renamed" 'renamed w9:p2 -> held-name' "$(logtext)"
check_eq "the retry reached herdr" "w9:p2 held-name" "$(renames)"

# --- 3. several unnamed panes in one tab: the first takes the name, the rest say why ---------
tabs_fixture '{"result":{"tabs":[{"tab_id":"w9:t1","label":"shared-tab","pane_count":2,"workspace_id":"w9"}]}}'
agents_fixture '{"result":{"agents":[
 {"pane_id":"w9:p1","tab_id":"w9:t1","name":""},
 {"pane_id":"w9:p2","tab_id":"w9:t1","name":""}]}}'
run
check "the first pane in the tab is renamed" 'renamed w9:p1 -> shared-tab' "$(logtext)"
check_eq "only the first pane reached herdr" "w9:p1 shared-tab" "$(renames)"
check "the second pane is skipped, naming the winner" 'skip w9:p2: 2 panes in tab w9:t1 .*w9:p1 takes it' "$(logtext)"

# --- 4. timestamps are UTC, marked Z ----------------------------------------------------------
tabs_fixture '{"result":{"tabs":[{"tab_id":"w9:t1","label":"5","pane_count":1,"workspace_id":"w9"}]}}'
agents_fixture '{"result":{"agents":[{"pane_id":"w9:p1","tab_id":"w9:t1","name":""}]}}'
# Run in a zone 8 hours off UTC: a local stamp with a Z appended cannot match the UTC hour.
TZ=Asia/Shanghai run
UTC_HOUR="$(date -u +%Y-%m-%dT%H)"
check_utc() { check_eq "$1" "$UTC_HOUR" "$(printf '%s' "$(logtext)" | cut -c1-13)"; }
check_utc "the stamp is UTC, not local time with a Z"
check "the stamp is still marked Z" '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z ' "$(logtext)"

# --- 5. --dry-run changes nothing -------------------------------------------------------------
tabs_fixture '{"result":{"tabs":[{"tab_id":"w9:t1","label":"dry-run-lane","pane_count":1,"workspace_id":"w9"}]}}'
agents_fixture '{"result":{"agents":[{"pane_id":"w9:p1","tab_id":"w9:t1","name":""}]}}'
rm -f "$T/renames.log"
: > "$LOG"
PATH="$BIN:$PATH" STUB_ROOT="$T" LANE_NAMES_LOG="$LOG" LANE_NAMES_STATE="$STATE/lane-names-state.json" \
  bash "$TOOL" --dry-run >/dev/null 2>&1
check "a dry run reports what it would do" 'would-rename w9:p1 -> dry-run-lane' "$(logtext)"
check_eq "a dry run calls no rename" "" "$(renames)"

echo
if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED failed, $PASSED passed"
  exit 1
fi
echo "$PASSED passed"
