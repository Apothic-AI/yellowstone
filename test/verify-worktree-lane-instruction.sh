#!/usr/bin/env bash
# Lane-topology instruction gate (FT-64, extended by FT-60).
#
# FT-64: the observed failure was ordering — a leader started a worker and then asked the worker to
# create a Git worktree. That checkout is discoverable but has no workspace membership, so it never
# nests under the space; only `herdr worktree create --workspace <parent>` establishes it.
#
# FT-60: a leader that needed a comparison worker split its own leader tab and started the worker in
# a sibling pane, because the herdr skill said "default to a sibling pane in the current tab" and
# "stop and ask ... rather than creating a new worker", while its mode said "default to spawning a
# worker" and "a subagent is a lane: a herdr tab named before it starts". Two instruction surfaces
# disagreed about the same act, and the skill's launch example was a bare `pil`, which starts the
# lane under the pane's default profile.
#
# So this gate holds every place that must agree, because a rule only one of them states is a rule
# an agent will read past:
#   1. the shared leader contract — create the worktree workspace first, then start the lane;
#   2. the shared worker contract — never create its own checkout;
#   3. the ACTIVE herdr skill — a new fleet lane gets a named tab, never a sibling pane in the
#      caller's tab, and its launch recipe carries the role, profile and project confirmation;
#   4. the lane-identity recipe — the same explicit launch form;
#   5. every instruction surface that prescribes a launch — the full triple on the recipe itself.
#
# The skill checked here is the active one: `skills/skills.tsv` selects `herdr repo bitnom/fleet-skills`,
# so `src/skills/fleet-skills/herdr/SKILL.md` is what a lane loads. `src/apps/herdr/skills/herdr/` is
# the vendored product skill, shadowed by that selection. FT-60 found this gate passing against the
# shadowed copy while the active skill said the opposite; the selection itself is now asserted below
# so a change there fails here instead of quietly moving the subject of the check.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_MODES="${REAL_AGENT_DIR:-$HOME/.pi/agent}/modes"
fail=0
ok()  { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fail=$((fail + 1)); }

prompt_of() { python3 - "$1" <<'PY'
import json, sys
try:
    print(json.load(open(sys.argv[1]))["systemPrompt"])
except Exception as exc:  # missing or malformed both fail the caller's greps
    print("")
PY
}

leader="$(prompt_of "$REPO_ROOT/home/.pi/agent/modes/leader.json")"
worker="$(prompt_of "$REPO_ROOT/home/.pi/agent/modes/worker.json")"

# 1. Leader: the ordering rule and the launch requirements that make it work.
for phrase in \
  "herdr worktree create" \
  "never start a lane and then ask it to make its own worktree" \
  "PI_MODE_CONFIRM_PROJECT=1" \
  "herdr pane run <returned-pane-id> env PI_MODE=worker" \
  "not_git_worktree"
do
  case "$leader" in *"$phrase"*) ;; *) bad "leader contract is missing: $phrase" ;; esac
done
case "$leader" in
  *"herdr worktree create --workspace"*) ok "leader contract prescribes create-then-start with the parent workspace" ;;
  *) bad "leader contract names create but not the required --workspace parent" ;;
esac

# 2. Worker: the other half — it must not create its own checkout.
case "$worker" in
  *"Do not create a Git worktree"*) ok "worker contract forbids self-created worktrees" ;;
  *) bad "worker contract no longer forbids creating its own worktree" ;;
esac

# 3. The active herdr skill: a new lane is a named tab with an explicit launch, never a sibling pane.
skill="$REPO_ROOT/src/skills/fleet-skills/herdr/SKILL.md"
if [ -f "$skill" ]; then
  for phrase in \
    "herdr tab create --workspace" \
    "--label <unique-lane-name>" \
    "PI_MODE_CONFIRM_PROJECT=1" \
    "standing policy"
  do
    grep -qF -- "$phrase" "$skill" || bad "active herdr skill is missing: $phrase"
  done
  grep -qF 'herdr pane run <returned-pane-id> "env PI_MODE=<leader|worker>' "$skill" \
    && ok "active herdr skill launches a new lane with the role and profile explicit" \
    || bad "active herdr skill no longer hands a new lane an explicit role/profile launch"

  if grep -qF 'herdr pane run <returned-pane-id> "pil"' "$skill"; then
    bad "active herdr skill prescribes a bare pil launch — it starts the lane under the pane's default profile"
  else
    ok "active herdr skill carries no bare-pil launch recipe"
  fi
  if grep -qF "Default to a sibling pane in the current tab" "$skill"; then
    bad "active herdr skill defaults agent delegation to a sibling pane in the caller's tab"
  else
    ok "active herdr skill does not put a worker in the caller's tab"
  fi
  if grep -qF "rather than creating a new worker" "$skill"; then
    bad "active herdr skill refuses to create the worker its own mode tells it to delegate to"
  else
    ok "active herdr skill leaves the delegate-or-not decision to the mode"
  fi
else
  bad "active herdr skill is missing at $skill"
fi

# The check above is only about the active manual if the manifest still selects it.
if grep -qP '^herdr\trepo\tbitnom/fleet-skills\t' "$REPO_ROOT/skills/skills.tsv"; then
  ok "skills/skills.tsv still selects the fleet manual (the product skill stays shadowed)"
else
  bad "skills/skills.tsv no longer selects the fleet manual — the skill assertions above would be watching a shadowed file"
fi

# 4. The lane-identity skill is the reusable launch recipe agents actually load. Keep it
# explicit too: a bare `pil` in a worktree pane inherits the pane's default profile and
# caused FT54's integration lane to start as a leader. The role must be part of the command,
# not left as a prose suggestion.
lane="$REPO_ROOT/src/skills/fleet-skills/lane-identity/SKILL.md"
if [ -f "$lane" ]; then
  grep -qF 'herdr pane run <verified-new-pane-id> "env PI_MODE=worker PI_PROFILE=worker PI_MODE_CONFIRM_PROJECT=1 pil"' "$lane" \
    && ok "lane-identity worker recipe passes the role/profile explicitly" \
    || bad "lane-identity worker recipe still permits an unqualified pil launch"
  grep -qF 'herdr pane run <verified-new-pane-id> "env PI_MODE=leader PI_PROFILE=leader PI_MODE_CONFIRM_PROJECT=1 pil"' "$lane" \
    && ok "lane-identity leader recipe passes the role/profile explicitly" \
    || bad "lane-identity leader recipe lacks an explicit role/profile launch"
  if grep -qE 'Start it with `pi` inside its herdr pane' "$lane"; then
    bad "lane-identity still tells an agent to start a lane with pi — agent shells do not source the rc shim"
  else
    ok "lane-identity makes pil the launch route and pi only the interactive shim"
  fi
else
  bad "lane-identity skill is missing at $lane"
fi

# 5. Every instruction surface that prescribes a fleet launch carries all three settings on the
# recipe itself. FT-60's defect class is a line that reads as a launch instruction and is missing
# one: the overlord's spawn line omitted PI_MODE_CONFIRM_PROJECT=1, which drops the project half
# of the contract with nothing printed in the pane.
python3 - "$REPO_ROOT" <<'PY' || fail=$((fail + 1))
import json, re, sys
from pathlib import Path

root = Path(sys.argv[1])
surfaces = [
    *sorted((root / 'home/.pi/agent/modes').glob('*.json')),
    *sorted((root / 'home/.overlord/.pi/modes').glob('*.json')),
    *sorted((root / 'home/Documents/Fleet/.pi/modes').glob('*.json')),
    root / 'home/AGENTS.md',
    root / 'home/.overlord/AGENTS.md',
    root / 'home/Documents/Fleet/AGENTS.md',
    *sorted((root / 'src/skills/fleet-skills').rglob('*.md')),
]
# The narrowest window that still spans a real recipe: role, profile, confirmation, `pil`.
recipe = re.compile(r'PI_MODE=(leader|worker)[^"`]{0,90}?pil')
bad = 0
for path in surfaces:
    rel = path.relative_to(root)
    if not path.is_file():
        print(f'FAIL launch surface is missing: {rel}')
        bad += 1
        continue
    text = path.read_text()
    if path.suffix == '.json':
        try:
            text = json.loads(text).get('systemPrompt', '')
        except ValueError:
            print(f'FAIL {rel} is not valid JSON')
            bad += 1
            continue
    offenders = [m.group(0).strip() for m in recipe.finditer(text) if 'PI_MODE_CONFIRM_PROJECT' not in m.group(0)]
    if offenders:
        for line in offenders:
            print(f'FAIL {rel}: launch recipe without PI_MODE_CONFIRM_PROJECT=1: {line}')
        bad += 1
    else:
        print(f'ok   {rel}: launch recipes carry role, profile and project confirmation')
sys.exit(1 if bad else 0)
PY

echo
if [ "$fail" -eq 0 ]; then
  echo "ok   lane topology: leader, worker, herdr skill and lane-identity agree on create-then-start and on an explicit launch"
  exit 0
fi
echo "FAIL lane-topology instruction: $fail check(s) failed"
exit 1
