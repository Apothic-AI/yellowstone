#!/usr/bin/env bash
# verify-space-scaffold.sh — each fleet space's scaffolding is mirrored in home/ and still matches
# the machine it was copied from.
#
# Scope is deliberately the scaffolding only: AGENTS.md, .pi/launch.env, .pi/pi-persist.json and
# .pi/modes/*.json. Those are config, and they are what a fresh clone must reproduce. The spaces
# also hold state — continuations, notes, captures, outbound logs, operator documents — which is
# never mirrored and is not this gate's business.
#
# This is not a "which file is newer" check. When a space's mirror copy disagrees with the live one,
# one of the two is wrong and only a person can say which: a copy in either direction destroys
# content, and the disagreement is the finding. So a difference FAILS here, and a difference that
# has been decided and recorded goes in test/space-scaffold.divergences with its reason.
#
# The yellowstone space is not listed: its scaffolding is this repository's own root, so mapping it
# into home/ would be a copy of the tree inside itself.
#
# Since 2026-11-28 the gate also runs a skill-pointer check (see the section
# below the scaffold loop): every skill a mode file names must exist as a
# loadable skill and be in the lane's profile allowlist, or the pointer is dead
# (evaluation §6c/§8.4, Phase 5 item 18).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE_HOME="${SPACE_SCAFFOLD_HOME:-$HOME}"
DIV="$ROOT/test/space-scaffold.divergences"

# name:path-relative-to-$HOME
SPACES=(
  "assistant:Documents/Assistant"
  "comms:Documents/Comms"
  "overlord:.overlord"
  "self-improvement:Documents/Fleet"
  "sysops:.sysops"
  "personal:Documents/Personal"
  "pleroma:Unity/Projects/Pleroma"
)

is_declared() {  # $1 = path relative to home/, e.g. .overlord/AGENTS.md
  [ -f "$DIV" ] || return 1
  awk -v p="$1" '!/^#/ && NF && $1 == p { found = 1 } END { exit !found }' "$DIV"
}

scaffold_files() {  # $1 = directory; prints paths relative to it
  [ -d "$1" ] || return 0
  {
    for f in AGENTS.md .pi/launch.env .pi/pi-persist.json; do
      [ -f "$1/$f" ] && printf '%s\n' "$f"
    done
    for f in "$1"/.pi/modes/*.json; do
      [ -f "$f" ] && printf '.pi/modes/%s\n' "$(basename "$f")"
    done
  } | sort -u
}

rc=0
identical=0
differing=0
one_sided=0
unauthored=0
declared_ok=0

for entry in "${SPACES[@]}"; do
  name="${entry%%:*}"
  rel="${entry#*:}"
  mirror="$ROOT/home/$rel"
  live="$LIVE_HOME/$rel"

  m_files="$(scaffold_files "$mirror")"
  l_files="$(scaffold_files "$live")"

  if [ -z "$m_files" ] && [ -z "$l_files" ]; then
    printf '  none  %-16s no scaffolding authored on this machine yet\n' "$name"
    unauthored=$((unauthored + 1))
    continue
  fi
  if [ -z "$m_files" ]; then
    printf '  FAIL  %-16s live has scaffolding, the mirror has none\n' "$name"
    printf '%s\n' "$l_files" | sed 's/^/          live only: /'
    one_sided=$((one_sided + 1)); rc=1
    continue
  fi
  if [ -z "$l_files" ]; then
    printf '  FAIL  %-16s the mirror has scaffolding, live has none\n' "$name"
    printf '%s\n' "$m_files" | sed 's/^/          mirror only: /'
    one_sided=$((one_sided + 1)); rc=1
    continue
  fi

  space_ok=1
  for f in $(printf '%s\n%s\n' "$m_files" "$l_files" | sort -u); do
    key="$rel/$f"
    if [ ! -f "$mirror/$f" ]; then
      printf '  FAIL  %-16s live only: %s\n' "$name" "$f"
      space_ok=0; one_sided=$((one_sided + 1)); rc=1
    elif [ ! -f "$live/$f" ]; then
      printf '  FAIL  %-16s mirror only: %s\n' "$name" "$f"
      space_ok=0; one_sided=$((one_sided + 1)); rc=1
    elif cmp -s "$mirror/$f" "$live/$f"; then
      identical=$((identical + 1))
    elif is_declared "$key"; then
      printf '  decl  %-16s %s differs — declared: %s\n' "$name" "$f" \
        "$(awk -v p="$key" '$1 == p { $1 = ""; sub(/^ +/, ""); print; exit }' "$DIV")"
      space_ok=0; declared_ok=$((declared_ok + 1))
    else
      printf '  FAIL  %-16s %s differs (%s lines live, %s in mirror)\n' "$name" "$f" \
        "$(wc -l < "$live/$f")" "$(wc -l < "$mirror/$f")"
      space_ok=0; differing=$((differing + 1)); rc=1
    fi
  done
  [ "$space_ok" = 1 ] && printf '  ok    %-16s %s file(s) match live\n' "$name" \
    "$(printf '%s\n' "$m_files" | grep -c .)"
done

# --- Skill-pointer check (added 2026-11-28, skill-extraction Phase 5 item 18; eval §8.4) ---
# A skill a mode file names must (a) exist as a loadable skill — a SKILL.md under
# ~/.agents/skills/<name>/ (symlinks resolved) or in the fleet-skills source — and
# (b) be in the lane's profile allowlist (leader profile for leader mode files,
# worker profile for worker mode files). Project-level skills in a space's
# .pi/skills/ are visible regardless of the allowlist, so they pass (b) either way.
# Skill names are taken from pointer lines ("load the `<skill>` skill" /
# "see the `<skill>` skill" / "the `<skill>` skill", including unbackticked
# "the <skill> skill") and from bare backticked names that match a known skill.
# One PASS/FAIL line per reference; any failure fails the gate.
echo
echo "skill-pointer check — every skill named in a mode file must exist and be allowlisted"
skill_out="$(LIVE_HOME="$LIVE_HOME" ROOT="$ROOT" python3 - <<'PYEOF'
import json, os, re, sys

home = os.environ["LIVE_HOME"]
root = os.environ["ROOT"]
user_skills = os.path.join(home, ".agents", "skills")
fleet_skills = os.path.join(root, "src", "skills", "fleet-skills")

def skill_dirs(base):
    try:
        return {d for d in os.listdir(base)
                if os.path.isdir(os.path.join(base, d))}
    except OSError:
        return set()

known = skill_dirs(user_skills) | skill_dirs(fleet_skills)

SPACES = [
    ("assistant", "Documents/Assistant"),
    ("comms", "Documents/Comms"),
    ("overlord", ".overlord"),
    ("self-improvement", "Documents/Fleet"),
    ("sysops", ".sysops"),
    ("personal", "Documents/Personal"),
    ("pleroma", "Unity/Projects/Pleroma"),
]

# mode files: (label, role, path, space dir for project-level skills, or None)
modes = [
    ("global", "leader",
     os.path.join(home, ".pi", "agent", "modes", "leader.json"), None),
    ("global", "worker",
     os.path.join(home, ".pi", "agent", "modes", "worker.json"), None),
    ("overlord", "leader",
     os.path.join(home, ".overlord", ".pi", "modes", "leader.json"),
     os.path.join(home, ".overlord")),
    ("overlord", "worker",
     os.path.join(home, ".overlord", ".pi", "modes", "worker.json"),
     os.path.join(home, ".overlord")),
    ("yellowstone", "leader",
     os.path.join(root, ".pi", "modes", "leader.json"), root),
]
for name, rel in SPACES:
    if name == "overlord":
        continue  # already covered by the explicit overlord entries above
    sdir = os.path.join(home, rel)
    for role in ("leader", "worker"):
        modes.append((name, role,
                      os.path.join(sdir, ".pi", "modes", role + ".json"), sdir))

# project-level skills per space dir (bare-name detection + allowlist exemption)
proj_skills = {}
for _label, _role, _path, sdir in modes:
    if sdir and sdir not in proj_skills:
        proj_skills[sdir] = skill_dirs(os.path.join(sdir, ".pi", "skills"))
for s in proj_skills.values():
    known |= s

def load_profile(role):
    p = os.path.join(home, ".pi-profile-switch", "profiles", role + ".json")
    try:
        with open(p) as f:
            return set(json.load(f)["skills"]), None
    except (OSError, ValueError, KeyError) as e:
        return None, "cannot read %s profile %s: %s" % (role, p, e)

profiles, profile_err = {}, {}
for role in ("leader", "worker"):
    profiles[role], profile_err[role] = load_profile(role)

NAME = r"[A-Za-z0-9][A-Za-z0-9_-]*"
pat_pointer = re.compile(r"`(" + NAME + r")`\**\s+skill\b")
pat_bare_word = re.compile(r"\bthe ([a-z][a-z0-9-]*) skill\b")
pat_backticked = re.compile(r"`(" + NAME + r")`")

def references(text):
    found = []
    for m in pat_pointer.finditer(text):
        found.append(m.group(1))
    for m in pat_bare_word.finditer(text):
        found.append(m.group(1))
    for m in pat_backticked.finditer(text):
        if m.group(1) in known:
            found.append(m.group(1))
    out, seen = [], set()
    for s in found:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out

def skill_exists(skill, sdir):
    for base in (user_skills, fleet_skills):
        if os.path.isfile(os.path.join(base, skill, "SKILL.md")):
            return True
    if sdir and os.path.isfile(
            os.path.join(sdir, ".pi", "skills", skill, "SKILL.md")):
        return True
    return False

checked = failed = 0
for label, role, path, sdir in modes:
    if not os.path.isfile(path):
        print("  skip  %-16s %s: no mode file" % (label, role))
        continue
    try:
        with open(path) as f:
            text = f.read()
    except OSError as e:
        print("  FAIL  %-16s %s: cannot read %s: %s" % (label, role, path, e))
        failed += 1
        continue
    refs = references(text)
    if not refs:
        print("  ok    %-16s %s: no skill references" % (label, role))
        continue
    allowed = profiles.get(role)
    for skill in refs:
        checked += 1
        tag = "%-16s %s %-24s" % (label, role, skill)
        if not skill_exists(skill, sdir):
            print("  FAIL  %s: no such skill (no SKILL.md under ~/.agents/skills,"
                  " fleet-skills, or this space's .pi/skills)" % tag)
            failed += 1
        elif allowed is None:
            print("  FAIL  %s: cannot verify allowlist — %s"
                  % (tag, profile_err[role]))
            failed += 1
        elif skill in allowed:
            print("  PASS  %s: exists, in %s profile" % (tag, role))
        elif sdir and skill in proj_skills.get(sdir, set()):
            print("  PASS  %s: exists, visible via this space's .pi/skills"
                  " (profile allowlist does not apply)" % tag)
        else:
            print("  FAIL  %s: exists but NOT in the %s profile allowlist"
                  % (tag, role))
            failed += 1

print("skill-pointer check: %d reference(s) checked, %d failed"
      % (checked, failed))
sys.exit(1 if failed else 0)
PYEOF
)"
skill_rc=$?
printf '%s\n' "$skill_out"
skill_summary="$(printf '%s\n' "$skill_out" \
  | awk '/^skill-pointer check:/ { line = $0 } END { print (line == "" ? "skill-pointer check: no summary (see output above)" : line) }')"
[ "$skill_rc" -ne 0 ] && rc=1

echo
if [ "$rc" = 0 ]; then
  echo "gate passed: $identical scaffold file(s) match live · $declared_ok declared divergence(s)" \
       "· $unauthored space(s) not yet authored · $skill_summary"
else
  echo "gate FAILED: $differing differing · $one_sided one-sided — a copy in either direction destroys" \
       "content, so decide each one and record it in test/space-scaffold.divergences · $skill_summary"
fi
exit "$rc"
