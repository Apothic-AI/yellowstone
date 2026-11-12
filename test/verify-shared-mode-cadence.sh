#!/usr/bin/env bash
# verify-shared-mode-cadence.sh — the shared leader and worker contracts carry the
# fleet's communication cadence.
#
# Why this exists: the cadence (use pi-rooms for coordination, not narration) lived
# only in ONE space's project overlay — the Fleet workspace's — so a lane in any other
# space never saw it. The shared contracts in home/.pi/agent/modes/ are the ones every
# space composes onto, so the rule belongs there, in both roles.
#
# What it checks, per role: that the shared definition exists, parses, carries the
# right key, and holds the cadence with ALL of its parts — the channel (pi-rooms), the
# triggers (a blocker, another agent waiting, a handoff, an authorization boundary, a
# material scope/status change, a completed deliverable, a final/milestone report), the
# prohibition (no incremental narration) and the preservation clause. A rule that is
# half-present is a rule a lane can obey the wrong side of.
#
# It reads the canonical copies in this tree, not the live ones: until the adoption
# lands, the live files are the operator's, and a gate that read them would be red for
# the whole window between the candidate and the adoption. The adoption is verified on
# one lane instead, by re-resolving that lane's recorded fingerprint.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODES="$ROOT/home/.pi/agent/modes"
rc=0
checked=0

fail() {
  printf 'FAIL %s\n' "$*"
  rc=1
}

for key in leader worker; do
  file="$MODES/$key.json"
  if [ ! -f "$file" ]; then
    fail "no shared $key definition at ${file#"$ROOT"/}"
    continue
  fi
  if ! out="$(python3 - "$file" "$key" <<'PY'
import json, sys

path, key = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as handle:
    definition = json.load(handle)

problems = []
if definition.get("key") != key:
    problems.append(f"the file declares key {definition.get('key')!r}, not {key!r}")
if definition.get("promptStrategy") != "replace_base":
    problems.append(
        "the shared definition is not the base contract "
        f"(promptStrategy is {definition.get('promptStrategy')!r}, expected 'replace_base')"
    )

prompt = definition.get("systemPrompt") or ""
# The cadence's parts. Each is a distinct instruction a lane can act on, so each is
# checked on its own: a lane given only the prohibition would go silent, and a lane
# given only the triggers would narrate. The prompt is hard-wrapped, so the text is
# compared with its whitespace collapsed: a line break is typography, not a difference.
parts = [
    ("channel", "pi-rooms"),
    ("not narration", "for coordination, not narration"),
    ("no incremental narration", "Do not send incremental progress updates"),
    ("blocker", "you are blocked and need another agent or the operator"),
    ("another agent waiting", "another agent is blocked or waiting for your response"),
    ("completed deliverable", "a completed deliverable"),
    ("material scope change", "a material scope/status change"),
    ("handoff", "a handoff"),
    ("authorization boundary", "an authorization boundary"),
    ("final report", "a final/milestone report"),
    ("coordination preserved", "Preserve communication needed for coordination"),
    ("quiet preferred", "A quiet lane is preferred"),
]
flat = " ".join(prompt.split())
missing = [label for label, needle in parts if needle not in flat]
if missing:
    problems.append("the cadence is missing: " + ", ".join(missing))

if problems:
    for problem in problems:
        print(problem)
    raise SystemExit(1)
raise SystemExit(0)
PY
  )"; then
    fail "shared $key contract ${file#"$ROOT"/}:"
    printf '     %s\n' "$out"
  else
    checked=$((checked + 1))
  fi
done

if [ "$rc" -ne 0 ]; then
  echo "gate FAILED: a shared role contract does not carry the full communication cadence" >&2
  exit 1
fi
echo "gate passed: $checked shared role contract(s) carry the full pi-rooms communication cadence"
