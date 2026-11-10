#!/usr/bin/env bash
# run.sh — run the container suite against THIS work tree, not the baked copy.
#
# The image bakes the repo in so it works with no arguments, but a baked copy
# goes stale the moment you edit anything. This wrapper bind-mounts the current
# checkout over /repo so the tests always exercise uncommitted work.
#
#   ./test/run.sh            all suites
#   ./test/run.sh install    one suite
#   ./test/run.sh gates      the two monorepo gates, on the host (see below)
#
# `gates` is deliberately not a container suite. Both gates clone the repository
# and talk to its remotes, so they need network and a real git; the image has
# neither on purpose. They are also the checks that say whether the subrepo
# conversion and the install sources are still coherent, which is a question you
# ask on the host before pushing, not inside a sandbox.
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
  gate() {
    gates_run=$((gates_run + 1))
    if "$@"; then return 0; fi
    gates_failed=$((gates_failed + 1))
    rc=1
    return 0
  }
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
  # What a new machine actually receives: the plugin manifest must link components out
  # of the repo (Objective 4) and the space table must carry all seven labels verbatim.
  # Both failed silently: two plugins pointed at ~/Code checkouts, and three space
  # labels were lowercased against the operator's capitalised workspaces, which would
  # have created duplicate spaces rather than failing.
  gate ./test/verify-fleet-manifest.sh
  echo
  # Objective 2 has two halves and only the local one was checked. A development machine
  # installs from src/; a fresh machine installs `git:Apothic-AI/<repo>@<sha>` from each
  # component's .gitrepo, and until this gate existed `PI_EXTENSIONS_FROM` appeared in
  # install.sh and in no test at all — implemented, never exercised, and the mode a new
  # machine actually runs. It also catches the closed-list defect: install.sh iterates a
  # hardcoded nine, so a tenth component would install locally and never in production.
  gate ./test/verify-extensions-git-mode.sh
  echo
  # The mirror gate's own test: a reverted mirror, an uncommitted live edit and a
  # pending install must be told apart. Without it, that gate is verified only by
  # whatever happened to be true on this machine the day it was written — and its
  # first version passed the revert case for an hour, in production, green.
  gate ./test/verify-revert-detection.sh
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
