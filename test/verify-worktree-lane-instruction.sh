#!/usr/bin/env bash
# Worktree-lane instruction gate (FT-64).
#
# The observed failure was ordering: a leader started a worker and then asked the worker to
# create a Git worktree. That checkout is discoverable but has no workspace membership, so it
# never nests under the space — the sidebar shows the worktree *workspace*, not an agent under
# an agent, and only `herdr worktree create --workspace <parent>` establishes the membership.
#
# This gate holds the three places that must agree, because the rule is useless if any one of
# them drifts back to the old ordering: the shared leader contract (create, then start), the
# shared worker contract (never self-create), and the herdr skill (the exact procedure, plus a
# reconciled exception so the skill's "do not create a workspace unless asked" line no longer
# contradicts the fleet's standing worktree policy).
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

# 3. The herdr skill: exact procedure, and the blanket rule reconciled rather than contradicted.
skill="$REPO_ROOT/src/apps/herdr/skills/herdr/SKILL.md"
if [ -f "$skill" ]; then
  for phrase in \
    "### Worktree-backed agents" \
    "--workspace" \
    "not_git_worktree" \
    "standing policy" \
    "occupied pane"
  do
    grep -qF -- "$phrase" "$skill" || bad "herdr skill is missing: $phrase"
  done
  if grep -qF "Do not create a workspace, tab, worktree, or different cwd unless the user explicitly requests that topology or location." "$skill"; then
    bad "herdr skill still carries the unreconciled blanket rule (no standing-policy exception)"
  else
    ok "herdr skill reconciles its blanket no-worktree rule with the standing policy"
  fi
else
  bad "herdr skill is missing at $skill"
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
else
  bad "lane-identity skill is missing at $lane"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "ok   worktree lanes: leader, worker and herdr skill agree on create-then-start"
  exit 0
fi
echo "FAIL worktree-lane instruction: $fail check(s) failed"
exit 1
