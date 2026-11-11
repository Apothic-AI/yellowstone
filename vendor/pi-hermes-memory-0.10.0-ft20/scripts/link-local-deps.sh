#!/usr/bin/env bash
# Link the local dependency set this component type-checks and tests against.
#
# No install, no network, no package fetch: every entry is a symlink to a copy
# that is already on this machine, which is how the extension resolves them at
# runtime anyway (Pi injects its own host SDK; the package's other deps live in
# the extension install root).
#
# Override with:
#   HOST_ROOT       actual deployed pi-coding-agent package directory
#   SDK_ROOT        host dependency directory (@earendil-works siblings, typebox)
#   NODE_TYPES_ROOT installed @types/node package directory
#   NPM_ROOT        extension dependency directory (strip-ansi)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_ROOT="${HOST_ROOT:-/home/bitnom/.local/share/mise/installs/node/22.23.3/lib/node_modules/@earendil-works/pi-coding-agent}"
SDK_ROOT="${SDK_ROOT:-$HOST_ROOT/node_modules}"
NODE_TYPES_ROOT="${NODE_TYPES_ROOT:-$HOST_ROOT/node_modules/@types/node}"
NPM_ROOT="${NPM_ROOT:-/home/bitnom/.pi/agent/npm/node_modules}"

link() {
  local name="$1" target="$2"
  if [ ! -e "$target" ]; then
    echo "MISSING: $target" >&2
    return 1
  fi
  mkdir -p "$HERE/node_modules/$(dirname "$name")"
  ln -sfnT "$target" "$HERE/node_modules/$name"
  echo "linked $name -> $target"
}

# Older versions linked the whole scope, which omits the host itself. Remove
# only that local symlink, never create links inside the installed SDK scope.
if [ -L "$HERE/node_modules/@earendil-works" ]; then
  rm "$HERE/node_modules/@earendil-works"
fi
link "@earendil-works/pi-coding-agent" "$HOST_ROOT"
link "@earendil-works/pi-ai" "$SDK_ROOT/@earendil-works/pi-ai"
link "@earendil-works/pi-tui" "$SDK_ROOT/@earendil-works/pi-tui"
link "@types/node" "$NODE_TYPES_ROOT"
link "typebox" "$SDK_ROOT/typebox"
link "strip-ansi" "$NPM_ROOT/strip-ansi"

echo
echo "node_modules is gitignored; nothing here is committed."
