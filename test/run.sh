#!/usr/bin/env bash
# run.sh — run the container suite against THIS work tree, not the baked copy.
#
# The image bakes the repo in so it works with no arguments, but a baked copy
# goes stale the moment you edit anything. This wrapper bind-mounts the current
# checkout over /repo so the tests always exercise uncommitted work.
#
#   ./test/run.sh            all suites
#   ./test/run.sh install    one suite
#   ./test/run.sh gates      the host-side gates, in one traversal (see below)
#
# `gates` is deliberately not a container suite. Most of them clone the repository
# and talk to its remotes, so they need network and a real git; the image has
# neither on purpose. They are also the checks that say whether the subrepo
# conversion, the install sources and the mirror are still coherent, which is a
# question you ask on the host before pushing, not inside a sandbox.
#
# Every test/verify-*.sh is either invoked here or the run fails — see gate_wiring
# at the end of the block. A control that no wrapper runs is a file, not a check.
set -euo pipefail
cd "$(dirname -- "$0")/.."

if [ "${1:-}" = gates ]; then
  rc=0
  # The count comes from the traversal, never from the narrator. This suite has been
  # quoted as "7 gates", "8", "9" and "10" in one session. Two of those were
  # recollections and one was a measured proxy, which wants the opposite cure: pasting
  # `grep -c 'gate passed'` reproduces the 10 faithfully. Either way none of them came
  # from the file, because until now it never printed its own size.
  #
  # The "10" is worth keeping as the example, and the first explanation of it was wrong.
  # It came from `grep -c 'gate passed'` on a run log. That counts LINES, and the number
  # of such lines a script prints is a property of that script's STATE, not of the suite:
  # measured per script, eight print one line each and verify-mirror-live.sh prints two
  # when every check passes and NONE when one fails (the second is mirror-provenance.sh's
  # own, called at :120 with no -q, so its say() at :43 emits when QUIET=0, and its :180
  # prints). So the same nine gates produced 10 matching lines on one run and 8 on
  # another. There is no fixed "one script prints it twice" to point at — the string is
  # simply not a count of anything stable, and the second line is not even the caller's.
  #
  # A suite that will not state its own size invites everyone to guess it, so it states
  # it: the total below is computed from the calls actually made, not from prose.
  gates_run=0
  gates_failed=0
  gated=""
  gate() {
    gates_run=$((gates_run + 1))
    gated="$gated $1"
    if "$@"; then return 0; fi
    gates_failed=$((gates_failed + 1))
    rc=1
    return 0
  }
  # Every control under test/verify-*.sh must be RUN here, or the run fails. A
  # verify script that nothing invokes is the state this suite keeps finding in
  # other people's work: the file reads as coverage and no wrapper ever runs it.
  # The wiring check at the end of this block is derived from the directory, so
  # adding a control without wiring it to a `gate` call fails here.
  gate ./test/verify-subrepo-roundtrip.sh
  echo
  gate ./test/verify-monorepo-install.sh
  echo
  gate ./test/verify-profile-skills.sh
  gate ./test/verify-pre-push-hook.sh
  echo
  # Host-side like the others, and machine-local: it compares the mirror to the
  # machine it is being pushed from, which no container suite can do (they install
  # a copy of this tree and compare the install to the tree). Skips itself when
  # there is no live overlord space to compare against.
  gate ./test/verify-mirror-live.sh
  echo
  # The same idea for the spaces themselves. verify-mirror-live covers home/.overlord/tools
  # only — its count does not move when a space's AGENTS.md or .pi/modes appears under home/,
  # which is how a 510-line file and a 108-line file of the same name sat in the tree and on
  # the machine without anything noticing. This gate holds the scaffolding together, and
  # requires a difference that has been decided to be written down rather than tolerated.
  gate ./test/verify-space-scaffold.sh
  echo
  # The shared role contracts -- the ones every space composes onto. The fleet's
  # pi-rooms communication cadence lived only in one space's project overlay, so a lane
  # in any other space never saw it; the rule belongs in the shared contracts, in both
  # roles, and this gate holds both of them to it.
  gate ./test/verify-shared-mode-cadence.sh
  echo
  # What a new machine actually receives: the plugin manifest must link components out
  # of the repo (Objective 4) and the space table must carry all seven labels verbatim.
  # Both failed silently: two plugins pointed at ~/Code checkouts, and three space
  # labels were lowercased against the operator's capitalised workspaces, which would
  # have created duplicate spaces rather than failing.
  gate ./test/verify-fleet-manifest.sh
  gate node ./test/verify-ft28-vendor.mjs
  echo
  # Objective 2 has two halves and only the local one was checked. A development machine
  # installs from src/; a fresh machine installs `git:Apothic-AI/<repo>@<sha>` from each
  # component's .gitrepo, and until this gate existed `PI_EXTENSIONS_FROM` appeared in
  # install.sh and in no test at all — implemented, never exercised, and the mode a new
  # machine actually runs. It also catches the closed-list defect: install.sh iterates a
  # hardcoded nine, so a tenth component would install locally and never in production.
  gate ./test/verify-extensions-git-mode.sh
  echo
  # Behold is not a `pi install` package — a Python CLI plus a single-file reporter — so
  # its landing has two silent failure modes the extension gate above cannot see: the
  # component drifting from the accepted source, and the reporter the installer places
  # ceasing to be the reporter the component carries. This gate binds both by bytes and
  # then runs the component's own capture tests.
  gate ./test/verify-behold-landing.sh
  echo
  # The mirror gate's own test: a reverted mirror, an uncommitted live edit and a
  # pending install must be told apart. Without it, that gate is verified only by
  # whatever happened to be true on this machine the day it was written — and its
  # first version passed the revert case for an hour, in production, green.
  gate ./test/verify-revert-detection.sh
  echo
  # The accepted vendor payload's provenance. The container suite grants a lint
  # exemption to a payload member by membership AND matching bytes, which is only
  # meaningful if the manifest itself cannot be rewritten — so this gate binds the
  # manifest and the four provenance artifacts to the committed blobs and to pinned
  # hashes, and proves its own negatives still fail. Host-side because the oracle is
  # git, and it never regenerates the manifest.
  gate ./test/verify-vendor-provenance.sh
  echo
  # The revert-detection gate's own environment test, which existed and that nothing
  # ran. It runs that script under the Git environment a push hook exports
  # (GIT_DIR, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_COMMON_DIR, …) and requires
  # the caller's HEAD, branch, index, tracked-file hashes and config to be untouched
  # on both a pass and a forced failure. Hooks are the one caller that can hand a
  # gate a pointer to somebody else's repository, and a gate that rewrites the
  # pusher's index on its way to reporting green is worse than no gate.
  gate ./test/verify-revert-detection-invariants.sh
  echo
  # The wiring check, last so the run above already shows what exists. Derived from
  # the directory, not restated here: every test/verify-*.sh must have been invoked
  # by a `gate` call above, or this fails. It runs through gate() like the rest, so
  # a control added without wiring is a red run and not a silent gap.
  gate_wiring() {
    local g unwired=""
    for g in ./test/verify-*.sh; do
      case " $gated " in *" $g "*) ;; *) unwired="$unwired $g" ;; esac
    done
    if [ -n "$unwired" ]; then
      echo "FAIL unwired control(s) — a verify script this wrapper never runs:${unwired}"
      return 1
    fi
    echo "ok   every test/verify-*.sh control is wired into this list"
  }
  gate gate_wiring
  echo
  if [ "$gates_failed" -eq 0 ]; then
    echo "gates: ${gates_run}/${gates_run} passed, rc=0"
  else
    echo "gates: $((gates_run - gates_failed))/${gates_run} passed, ${gates_failed} failed, rc=${rc}"
  fi
  exit "$rc"
fi

IMAGE="${IMAGE:-yellowstone-test}"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "building $IMAGE ..." >&2
  docker build -f test/Dockerfile -t "$IMAGE" . >/dev/null
fi

# Mount the whole checkout, suite included: both the scripts under test and the
# assertions themselves must come from this work tree.
# A memory ceiling per container, so a suite that cannot fit dies *inside* its own
# container with an OOM and a summary rather than taking the whole run with it as
# rc=137 and no output. On a box already deep into swap that is the difference
# between "failed" and "killed", and only one of those is a gate.
#   YELLOWSTONE_TEST_MEMORY=6g ./test/run.sh all      # raise it on a roomier box
exec docker run --rm \
  --memory "${YELLOWSTONE_TEST_MEMORY:-4g}" \
  --memory-swap "${YELLOWSTONE_TEST_MEMORY:-4g}" \
  -v "$PWD:/repo:ro" \
  -e REPO=/repo \
  -e YELLOWSTONE_TEST_MEMORY="${YELLOWSTONE_TEST_MEMORY:-4g}" \
  "$IMAGE" "${1:-all}"
