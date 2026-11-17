#!/usr/bin/env bash
# verify-dispatch-lock.sh — the batch dispatcher's lock protects a REPOSITORY, not a cwd.
#
# FT-83. On 2026-11-17 the push dispatcher serialized jobs by the cwd each worker was spawned in.
# FT-74's worker had cwd `~/Documents/Fleet` and did its work inside the yellowstone tree; its
# `git commit --amend` raced an FT-72 lane in that shared checkout and replaced that lane's commit
# subject. `~/Documents/Fleet` is not even a git repository, so the two jobs shared one fake
# resource name and neither held the tree they were both writing. A cwd is where a lane starts, not
# where it writes.
#
# What this pins, in both directions:
#
#   1. two jobs that DECLARE the same repository do not overlap, whoever's cwd they start in — and
#      the waiting one says who holds it, by name;
#   2. two jobs that declare DIFFERENT repositories do overlap, so this is a per-repository lock and
#      not a global mutex wearing one;
#   3. a job whose cwd is a repository it did not declare is serialized against the repository it
#      DID declare (the FT-74 shape: cwd Documents/Fleet, writes yellowstone), and the cwd
#      repository is locked too;
#   4. two worktrees of one repository share one lock, because they share refs: a worktree is not an
#      isolation boundary for a commit;
#   5. a job with `commits: true` and no declared repo is REFUSED before it spawns — the declaration
#      is required, not inferred;
#   6. a declared repo that is not a git repository is REFUSED, rather than silently unlocked;
#   7. the lockfile lives inside the repository's git dir and not in its working tree, so the tool
#      that guards a commit does not itself dirty the tree;
#   8. a killed holder does not leave a stale lock (flock, not a pidfile).
#
# Hermetic: the spawner is stubbed and every repository is a temp dir, so it runs on a live machine
# and in a container.
set -uo pipefail

REPO="$(cd "$(dirname -- "$0")/.." && pwd)"
DISPATCH="${SI_DISPATCH:-$REPO/home/.overlord/tools/si-batch-dispatch.py}"
PYTHON="${PYTHON:-python3}"
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

[ -f "$DISPATCH" ] || { echo "FAIL dispatcher not found at $DISPATCH"; exit 1; }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

export GIT_AUTHOR_NAME=dispatch-test GIT_AUTHOR_EMAIL=dispatch@test.invalid
export GIT_COMMITTER_NAME=dispatch-test GIT_COMMITTER_EMAIL=dispatch@test.invalid
git config --global init.defaultBranch main >/dev/null 2>&1 || true

mkrepo() { # mkrepo <path>
  mkdir -p "$1"
  git -C "$1" init -q
  : > "$1/README"
  git -C "$1" add README
  git -C "$1" commit -qm "init $(basename "$1")"
}

# The stub spawner: records when a job actually ran, then writes the REPORT.md that is completion.
# Its interval log is the evidence — the dispatcher's own log is a claim about itself.
#
# Like the real `spawn-lane`, it RETURNS once the job has started; the work continues in the
# background and the dispatcher waits on REPORT.md. A spawner that blocks until the job finishes
# would serialize the whole batch, and the concurrency test below would pass for the wrong reason.
cat > "$T/spawn" <<'SPAWN'
#!/usr/bin/env bash
set -uo pipefail
slug="${SI_DISPATCH_SLUG:?}"; report="${SI_DISPATCH_REPORT:?}"
printf 'start %s %s\n' "$slug" "$(date +%s%N)" >> "$SPAWN_INTERVAL_LOG"
(
  sleep "${SPAWN_SLEEP:-1.2}"
  printf 'end %s %s\n' "$slug" "$(date +%s%N)" >> "$SPAWN_INTERVAL_LOG"
  printf '# report for %s\n' "$slug" > "$report"
) >/dev/null 2>&1 &
exit 0
SPAWN
chmod +x "$T/spawn"
export SPAWN_INTERVAL_LOG="$T/interval.log"
: > "$SPAWN_INTERVAL_LOG"

# overlap <a> <b> — did the two named jobs' intervals intersect? Reads the spawner's own log.
overlap() {
  "$PYTHON" - "$SPAWN_INTERVAL_LOG" "$1" "$2" <<'PY'
import sys
log, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
iv = {}
for line in open(log):
    kind, slug, ns = line.split()
    iv.setdefault(slug, {})[kind] = int(ns)
if a not in iv or b not in iv:
    print(f"missing interval: have {sorted(iv)}"); sys.exit(2)
x, y = iv[a], iv[b]
print("overlap" if x["start"] < y["end"] and y["start"] < x["end"] else "serial")
PY
}

waiting_line() { grep -c -- "WAIT $1" "$2/dispatch.log" 2>/dev/null || true; }

spec() { # spec <root> <jobs-json>
  printf '{"workspace":"w1K","concurrency":2,"timeout":60,"root":"%s","doc":"/dev/null","spawn":"%s","jobs":%s}' \
    "$1" "$T/spawn" "$2"
}

RA="$T/repo-a"; RB="$T/repo-b"
mkrepo "$RA"; mkrepo "$RB"
OTHER="$T/not-a-repo"; mkdir -p "$OTHER"

# --- 1 + 2: same declared repository serializes, different ones do not ------------------------
: > "$SPAWN_INTERVAL_LOG"; S1="$T/s1"
spec "$S1" "[
 {\"slug\":\"same1\",\"label\":\"l-same1\",\"cwd\":\"$OTHER\",\"repo\":\"$RA\",\"commits\":true,\"heading\":\"A\",\"intent\":\"x\"},
 {\"slug\":\"same2\",\"label\":\"l-same2\",\"cwd\":\"$OTHER\",\"repo\":\"$RA\",\"commits\":true,\"heading\":\"B\",\"intent\":\"x\"}
]" > "$T/spec1.json"
"$PYTHON" "$DISPATCH" --jobs "$T/spec1.json" --poll 0.1 > "$T/out1.txt" 2>&1
rc=$?
[ "$rc" = 0 ] && pass "same-repo dispatch exits 0" || fail "same-repo dispatch exits 0" "rc=$rc" "$(tail -5 "$T/out1.txt")"
check "both same-repo jobs ran" "DONE same1" "$(cat "$S1/dispatch.log")"
check "both same-repo jobs ran (2)" "DONE same2" "$(cat "$S1/dispatch.log")"
res="$(overlap same1 same2)"
[ "$res" = serial ] && pass "two jobs declaring one repository do NOT overlap" \
  || fail "two jobs declaring one repository do NOT overlap" "overlap() said: $res" "$(cat "$SPAWN_INTERVAL_LOG")"
[ "$(waiting_line same2 "$S1")" -ge 1 ] && pass "the waiting job names the lock it is waiting for" \
  || fail "the waiting job names the lock it is waiting for" "no 'WAIT same2' line" "$(cat "$S1/dispatch.log")"
check "the WAIT line names the holder, not just 'busy'" "WAIT same2 .*held by .*same1" "$(cat "$S1/dispatch.log")"

: > "$SPAWN_INTERVAL_LOG"; S2="$T/s2"
spec "$S2" "[
 {\"slug\":\"diff1\",\"label\":\"l-diff1\",\"cwd\":\"$OTHER\",\"repo\":\"$RA\",\"commits\":true,\"heading\":\"A\",\"intent\":\"x\"},
 {\"slug\":\"diff2\",\"label\":\"l-diff2\",\"cwd\":\"$OTHER\",\"repo\":\"$RB\",\"commits\":true,\"heading\":\"B\",\"intent\":\"x\"}
]" > "$T/spec2.json"
"$PYTHON" "$DISPATCH" --jobs "$T/spec2.json" --poll 0.1 > "$T/out2.txt" 2>&1
res="$(overlap diff1 diff2)"
[ "$res" = overlap ] && pass "two jobs declaring different repositories DO overlap" \
  || fail "two jobs declaring different repositories DO overlap" "overlap() said: $res — a global mutex, not a per-repo lock" "$(cat "$SPAWN_INTERVAL_LOG")"
[ "$(waiting_line diff2 "$S2")" = 0 ] && pass "no WAIT line when the repositories differ" \
  || fail "no WAIT line when the repositories differ" "$(cat "$S2/dispatch.log")"

# --- 3: the FT-74 shape — cwd in one repo, work in another -----------------------------------
# Job X's cwd is repo A and it declares repo B (it will amend in B, from a lane started in A).
# Job Y declares repo B from an unrelated cwd. They must serialize, or the amendment races.
: > "$SPAWN_INTERVAL_LOG"; S3="$T/s3"
spec "$S3" "[
 {\"slug\":\"ft74shape\",\"label\":\"l-x\",\"cwd\":\"$RA\",\"repo\":\"$RB\",\"commits\":true,\"heading\":\"X\",\"intent\":\"x\"},
 {\"slug\":\"ft72lane\",\"label\":\"l-y\",\"cwd\":\"$OTHER\",\"repo\":\"$RB\",\"commits\":true,\"heading\":\"Y\",\"intent\":\"x\"}
]" > "$T/spec3.json"
"$PYTHON" "$DISPATCH" --jobs "$T/spec3.json" --poll 0.1 > "$T/out3.txt" 2>&1
res="$(overlap ft74shape ft72lane)"
[ "$res" = serial ] && pass "a declared repo wins over a different cwd repo (FT-74 shape serializes)" \
  || fail "a declared repo wins over a different cwd repo (FT-74 shape serializes)" "overlap() said: $res" "$(cat "$SPAWN_INTERVAL_LOG")"
check "the undeclared cwd repository is locked as well" "lock=.*repo-a" "$(cat "$S3/dispatch.log")"
check "the cwd-vs-declared divergence is stated, not silent" "cwd repository differs from the declared repository" "$(cat "$S3/dispatch.log")"

# --- 4: worktrees of one repo share one lock --------------------------------------------------
WT="$T/repo-a-wt"
git -C "$RA" worktree add -q -b side "$WT" >/dev/null 2>&1
[ -d "$WT" ] || fail "worktree created for the sharing test"
: > "$SPAWN_INTERVAL_LOG"; S4="$T/s4"
spec "$S4" "[
 {\"slug\":\"mainwt\",\"label\":\"l-m\",\"cwd\":\"$OTHER\",\"repo\":\"$RA\",\"commits\":true,\"heading\":\"M\",\"intent\":\"x\"},
 {\"slug\":\"sidewt\",\"label\":\"l-w\",\"cwd\":\"$OTHER\",\"repo\":\"$WT\",\"commits\":true,\"heading\":\"W\",\"intent\":\"x\"}
]" > "$T/spec4.json"
"$PYTHON" "$DISPATCH" --jobs "$T/spec4.json" --poll 0.1 > "$T/out4.txt" 2>&1
res="$(overlap mainwt sidewt)"
[ "$res" = serial ] && pass "two worktrees of one repository share one lock" \
  || fail "two worktrees of one repository share one lock" "overlap() said: $res" "$(cat "$S4/dispatch.log")"

# --- 5 + 6: refusals --------------------------------------------------------------------------
: > "$SPAWN_INTERVAL_LOG"; S5="$T/s5"
spec "$S5" "[
 {\"slug\":\"undeclared\",\"label\":\"l-u\",\"cwd\":\"$OTHER\",\"commits\":true,\"heading\":\"U\",\"intent\":\"x\"},
 {\"slug\":\"notgit\",\"label\":\"l-n\",\"cwd\":\"$OTHER\",\"repo\":\"$OTHER\",\"commits\":true,\"heading\":\"N\",\"intent\":\"x\"}
]" > "$T/spec5.json"
"$PYTHON" "$DISPATCH" --jobs "$T/spec5.json" --poll 0.1 > "$T/out5.txt" 2>&1
rc=$?
[ "$rc" != 0 ] && pass "a refused job fails the dispatch (rc != 0)" || fail "a refused job fails the dispatch (rc != 0)" "rc=0"
check "commits=true without a declared repo is refused" "REFUSE undeclared .*must name the repository" "$(cat "$S5/dispatch.log")"
check "a declared repo that is not a git repo is refused" "REFUSE notgit .*does not resolve to a git repository" "$(cat "$S5/dispatch.log")"
[ ! -s "$SPAWN_INTERVAL_LOG" ] && pass "a refused job never reaches the spawner" \
  || fail "a refused job never reaches the spawner" "$(cat "$SPAWN_INTERVAL_LOG")"

# --- 7: the lockfile is inside the git dir, not the working tree ------------------------------
S7="$T/s7"; : > "$SPAWN_INTERVAL_LOG"
spec "$S7" "[{\"slug\":\"where\",\"label\":\"l-w\",\"cwd\":\"$OTHER\",\"repo\":\"$RA\",\"commits\":true,\"heading\":\"W\",\"intent\":\"x\"}]" > "$T/spec7.json"
"$PYTHON" "$DISPATCH" --jobs "$T/spec7.json" --poll 0.1 > "$T/out7.txt" 2>&1
common="$(git -C "$RA" rev-parse --path-format=absolute --git-common-dir)"
[ -f "$common/si-batch-dispatch.lock" ] && pass "lockfile lives inside the repository's git dir" \
  || fail "lockfile lives inside the repository's git dir" "expected $common/si-batch-dispatch.lock"
[ ! -e "$RA/si-batch-dispatch.lock" ] && pass "lockfile is not in the working tree" \
  || fail "lockfile is not in the working tree" "$RA/si-batch-dispatch.lock exists"
[ -z "$(git -C "$RA" status --porcelain)" ] && pass "the guarded working tree is still clean" \
  || fail "the guarded working tree is still clean" "$(git -C "$RA" status --porcelain)"

# --- 8: a killed holder leaves no stale lock --------------------------------------------------
"$PYTHON" - "$common/si-batch-dispatch.lock" >/dev/null <<'PY' &
import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o644)
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
time.sleep(60)
PY
holder=$!
sleep 0.5
# A second holder must fail while the first lives...
"$PYTHON" - "$common/si-batch-dispatch.lock" <<'PY'
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o644)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    sys.exit(1)
sys.exit(0)
PY
[ $? = 1 ] && pass "the lock is exclusive while held" || fail "the lock is exclusive while held"
kill -TERM "$holder" 2>/dev/null
wait "$holder" 2>/dev/null
# ...and must succeed once it dies, with no cleanup and no pid guessing.
"$PYTHON" - "$common/si-batch-dispatch.lock" <<'PY'
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o644)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    sys.exit(1)
sys.exit(0)
PY
[ $? = 0 ] && pass "a killed holder leaves no stale lock" || fail "a killed holder leaves no stale lock"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "dispatch lock: ${PASSED}/${PASSED} checks passed"
  exit 0
fi
echo "dispatch lock: $PASSED/$((PASSED + FAILED)) passed, $FAILED failed"
exit 1
