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
  ./test/verify-subrepo-roundtrip.sh || rc=1
  echo
  ./test/verify-monorepo-install.sh || rc=1
  echo
  ./test/verify-profile-skills.sh || rc=1
  ./test/verify-pre-push-hook.sh || rc=1
  echo
  # Host-side like the others, and machine-local: it compares the mirror to the
  # machine it is being pushed from, which no container suite can do (they install
  # a copy of this tree and compare the install to the tree). Skips itself when
  # there is no live overlord space to compare against.
  ./test/verify-mirror-live.sh || rc=1
  echo
  # The same idea for the spaces themselves. verify-mirror-live covers home/.overlord/tools
  # only — its count does not move when a space's AGENTS.md or .pi/modes appears under home/,
  # which is how a 510-line file and a 108-line file of the same name sat in the tree and on
  # the machine without anything noticing. This gate holds the scaffolding together, and
  # requires a difference that has been decided to be written down rather than tolerated.
  ./test/verify-space-scaffold.sh || rc=1
  echo
  # What a new machine actually receives: the plugin manifest must link components out
  # of the repo (Objective 4) and the space table must carry all seven labels verbatim.
  # Both failed silently: two plugins pointed at ~/Code checkouts, and three space
  # labels were lowercased against the operator's capitalised workspaces, which would
  # have created duplicate spaces rather than failing.
  ./test/verify-fleet-manifest.sh || rc=1
  echo
  # The mirror gate's own test: a reverted mirror, an uncommitted live edit and a
  # pending install must be told apart. Without it, that gate is verified only by
  # whatever happened to be true on this machine the day it was written — and its
  # first version passed the revert case for an hour, in production, green.
  ./test/verify-revert-detection.sh || rc=1
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
