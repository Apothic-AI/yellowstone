#!/usr/bin/env bash
# land-mode-fixes — replace the two verified-false sentences in this space's mode file,
# then relaunch this lane, so the new definition digest is confirmed at startup.
#
# Why the two steps are one script: editing a mode file changes its digest. This lane's
# session recorded the old digest, and `driftPolicy` defaults to `block` — so an edit on its
# own makes the NEXT turn fall back to the native prompt, losing the whole role contract
# (verified: resolveModeSelection with an edited definition and a recorded fingerprint =>
# blocked=true, base=NONE). A relaunch whose environment carries PI_MODE_CONFIRM_PROJECT=1
# records the new digest at startup, which is why <cwd>/.pi/launch.env already has that flag.
# Doing them in one script means the window in which the file is edited but not launched is
# the duration of a relaunch, not the gap between two of an agent's turns.
#
# Usage:
#   land-mode-fixes.sh --dry-run     show the edits and validate, change nothing
#   land-mode-fixes.sh               apply, back up, relaunch this lane
#   land-mode-fixes.sh --beads-dir   also fix the BEADS_DIR sentence (needs the operator's word)
set -uo pipefail

LANE="${LANE:-self-improvement-leader}"
PANE="${PANE:-w1K:p1}"
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
              "under the default `block` policy its space half drops on the next turn until it is "
              "re-approved.")

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
