#!/usr/bin/env bash
# run.sh — run the container suite against THIS work tree, not the baked copy.
#
# The image bakes the repo in so it works with no arguments, but a baked copy
# goes stale the moment you edit anything. This wrapper bind-mounts the current
# checkout over /repo so the tests always exercise uncommitted work.
#
#   ./test/run.sh            all suites
#   ./test/run.sh install    one suite
set -euo pipefail
cd "$(dirname -- "$0")/.."

IMAGE="${IMAGE:-yellowstone-test}"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "building $IMAGE ..." >&2
  docker build -f test/Dockerfile -t "$IMAGE" . >/dev/null
fi

# Mount the whole checkout, suite included: both the scripts under test and the
# assertions themselves must come from this work tree.
exec docker run --rm \
  -v "$PWD:/repo:ro" \
  -e REPO=/repo \
  "$IMAGE" "${1:-all}"
