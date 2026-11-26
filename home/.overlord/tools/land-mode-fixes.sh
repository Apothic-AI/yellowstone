#!/usr/bin/env bash
# land-mode-fixes — replace the two verified-false sentences in this space's mode file,
# then relaunch this lane, so the new definition digest is confirmed at startup.
#
# Why the two steps are one script: editing a mode file changes its digest, and this lane's
# session recorded the old digest, so the next request is governed by the DRIFT policy — which is
# per-build, not universal (corrected 2026-11-26; the original text here said "defaults to `block`"
# and that is TRUE ONLY OF THE NPM COPY, which no lane on this machine loads):
#
#   * `~/.pi/agent/npm/node_modules/@tryinget/pi-modes`      -> `?? "block"`  (loaded by NOBODY)
#   * `~/Code/yellowstone/src/pi-extensions/pi-modes`        -> `?? "reuse"`  (the build every lane
#     loads; declared in 32 of 32 instance `settings.json` that declare a pi-modes package at all —
#     measured 2026-11-26 by reading every
#     `/home/bitnom/.pi-profile-switch/instances/launch-*/settings.json` `packages[].source`)
#
# Both report version `0.6.0`, so nothing in the version string distinguishes them. Under the
# fleet's actual `reuse` policy an edited definition does NOT fall back to the native prompt —
# the lane keeps composing its **approved snapshot**, i.e. the OLD contract, silently, with a
# `definition changed since activation` diagnostic. Silent staleness is the hazard, not a dropped
# role contract. A relaunch whose environment carries PI_MODE_CONFIRM_PROJECT=1 records the new
# digest at startup; `/mode-reapprove` inside the lane is the other route, but a lane may not send
# it to itself (~/AGENTS.md, "Acting on yourself").
# Doing them in one script means the window in which the file is edited but not launched is
# the duration of a relaunch, not the gap between two of an agent's turns.
#
# Usage:
#   land-mode-fixes.sh --dry-run     show the edits and validate, change nothing
#   land-mode-fixes.sh               apply, back up, relaunch this lane
#   land-mode-fixes.sh --beads-dir   also fix the BEADS_DIR sentence (needs the operator's word)
case "${1:-}" in
  -h|--help)
    sed -n "2,17p" "$0" | sed "s/^#[ ]*//"
    exit 0
    ;;
esac
# land-mode-fixes — FLEET-ERA ARTIFACT (self-improvement-leader, retired 2026-11-26).
#
# THIS SCRIPT HAS ALREADY DONE ITS WORK AND MUST NOT BE RUN AGAINST YELLOWSTONE.
# It was a one-shot patch: it rewrote two exact sentences in the SI mode file. Measured
# 2026-11-26: neither the OLD nor the NEW form of either sentence exists in
# ~/Code/yellowstone/.pi/modes/leader.json (0 hits), and the assertion below is on SI's
# own opening line, which Yellowstone does not carry. Retargeting its defaults to
# yellowstone would produce a tool that edits a live lane's role contract with SI-era
# text and then refuses on its own assertion — a half-applied write in flight.
# Kept as history, with a hard guard so it cannot be pointed at the wrong mode file.
set -uo pipefail

# Only the Fleet (SI) mode file may be edited. Anything else is a mistake, not a target.
#
# The guard reads the CALLER'S ACTUAL DIRECTORY, not a variable that already defaults to the one
# path the guard permits. Measured 2026-11-26: the earlier form tested
# "${CWD:-/home/bitnom/Documents/Fleet}" while CWD was only defaulted ~10 lines LATER, so from any
# other directory CWD was unset, the guard substituted its own permitted default and always passed
# — a guard that could never fire. Proven by running it from this space and reaching the patch
# logic (rc=1) instead of refusing (rc=3).
CWD="${CWD:-$PWD}"
case "$CWD" in
  */Documents/Fleet|*/Documents/Fleet/) ;;
  *)
    echo "land-mode-fixes: REFUSED — Fleet-era artifact, will not edit $CWD". >&2
    echo "  This script patched SI's mode file and has no meaning for any other space." >&2
    exit 3 ;;
esac

LANE="${LANE:-self-improvement-leader}"
# No default: w1K:p1 was retired 2026-11-26 and the workspace removed. A default naming a dead pane
# would make the final self-restart target a lane that cannot exist. Refuse instead, loudly.
if [ -z "${PANE:-}" ]; then
  echo "land-mode-fixes: REFUSED — no PANE given, and there is no safe default." >&2
  echo "  The historical default (w1K:p1) is retired; set PANE explicitly if you truly mean it." >&2
  exit 4
fi
CWD="${CWD:-/home/bitnom/Documents/Fleet}"
MODE="$CWD/.pi/modes/leader.json"
DRY=0
FIX_BEADS=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --beads-dir) FIX_BEADS=1 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

python3 - "$MODE" "$DRY" "$FIX_BEADS" <<'PY'
import json, sys, shutil, os

path, dry, fix_beads = sys.argv[1], sys.argv[2] == "1", sys.argv[3] == "1"
d = json.load(open(path))
sp = d["systemPrompt"]

OLD_RELOAD = "`/reload` re-reads a changed `AGENTS.md`; it never re-reads a changed mode file."
NEW_RELOAD = ("`/reload` re-reads a changed `AGENTS.md` (it reloads extensions, skills, prompts, themes "
              "and context files), but it does not govern a mode file: `pi-modes` re-reads mode "
              "definitions from disk on every turn, and a definition whose digest changed is *drift* — "
              "whose consequence depends on the build's `driftPolicy`. The fleet loads the fork, where "
              "the default is `reuse`: the lane keeps composing its approved snapshot (the OLD "
              "contract) silently until it re-approves. The npm copy defaults to `block`, which drops "
              "the space half instead. Both are version 0.6.0; read `packages[].source` to know which.")

OLD_BEADS = ("every space attached with `BEADS_DIR=<space>/.beads` and the\nsame `project_id` "
             "(`D1`, `migration-plan-20261029.md`)")
NEW_BEADS = ("attached by walking up from the working directory to a `.beads/metadata.json` carrying the "
             "shared `dolt_database` and `project_id` — `BEADS_DIR` is *not* set in a live lane (checked "
             "in `/proc`), so the env-var form is migration-plan intent, not runtime behaviour")

edits = []
if OLD_RELOAD in sp:
    edits.append(("reload", OLD_RELOAD, NEW_RELOAD))
elif NEW_RELOAD in sp:
    print("reload sentence: already correct")
else:
    print("reload sentence: TARGET TEXT NOT FOUND — refusing to guess", file=sys.stderr)
    sys.exit(1)

if fix_beads:
    if OLD_BEADS in sp:
        edits.append(("beads", OLD_BEADS, NEW_BEADS))
    elif NEW_BEADS in sp:
        print("beads sentence: already correct")
    else:
        print("beads sentence: TARGET TEXT NOT FOUND — refusing to guess", file=sys.stderr)
        sys.exit(1)

for name, old, new in edits:
    sp = sp.replace(old, new, 1)
    print(f"--- {name} ---")
    print(f"  was: {old[:110]}…")
    print(f"  now: {new[:110]}…")

d["systemPrompt"] = sp
blob = json.dumps(d, indent=2, ensure_ascii=False) + "\n"
# Validate before writing: the mode must still parse and keep its contract fields.
check = json.loads(blob)
assert check["schemaVersion"] == 2 and check["key"] == "leader"
assert check["promptStrategy"] in ("append", "replace_base"), check["promptStrategy"]
assert "You are the self-improvement leader of this space" in check["systemPrompt"]

if dry:
    print(f"\ndry run: {len(edits)} edit(s) validated, nothing written")
    sys.exit(0)

if not edits:
    print("\nnothing to change; not relaunching")
    sys.exit(3)

shutil.copy2(path, f"{path}.bak-{__import__('time').strftime('%Y%m%dT%H%M%S')}")
open(path, "w").write(blob)
print(f"\nwrote {path} ({len(sp)} chars of systemPrompt)")
PY
rc=$?
[ "$rc" -eq 0 ] || { say "FAIL refactor step rc=$rc — not relaunching"; exit "$rc"; }
[ "$DRY" = "1" ] && exit 0

say "relaunching $LANE via self-restart"
"$(dirname "$0")/self-restart.sh" "$LANE" "$PANE" "$CWD"
