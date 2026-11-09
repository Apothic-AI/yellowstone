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
