#!/usr/bin/env bash
# link-deps.sh — the *minimal* local dependency link for the FT-20 vendor tree.
#
# No install, no postinstall, no network, no fetch. Every entry is a symlink to a
# copy that is already on this machine. Four are host-provided (Pi injects them
# at runtime, but TypeScript needs them on disk to resolve `import`), one is the
# Node type surface, and exactly one — strip-ansi — is a real runtime dependency
# this package must resolve through node_modules.
#
# Nothing here is recursive and nothing is copied: the six symlinks are the whole
# dependency tree, which is the point of "minimal". A link into an *ancestor*
# directory is refused: the tree must resolve its own deps, not inherit a
# neighbour's node_modules. The accepted source gate had to prove exactly that
# (receipts "no-ancestor.txt"); this script makes it a precondition.
#
#   ./link-deps.sh <package-dir>
#
# Required/optional environment:
#   FT20_HOST_ROOT    @earendil-works/pi-coding-agent package dir
#                     default: resolved from `pi` on PATH
#   FT20_SDK_ROOT     directory holding pi-ai, pi-tui, typebox
#                     default: $FT20_HOST_ROOT/node_modules
#   FT20_NODE_TYPES   @types/node package dir
#                     default: $FT20_SDK_ROOT/@types/node
#   FT20_NPM_ROOT     directory holding strip-ansi (the extension install root)
#                     default: ${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm/node_modules
#   FT20_BETTER_SQLITE3  0 to skip the optional better-sqlite3 link (default: link if present)
set -euo pipefail

PKG="${1:-}"
[ -n "$PKG" ] || { echo "usage: link-deps.sh <package-dir>" >&2; exit 2; }
PKG="$(cd "$PKG" && pwd)"
[ -f "$PKG/package.json" ] || { echo "not a package dir: $PKG" >&2; exit 2; }

resolve_host_root() {
  local bin pkgdir
  bin="$(command -v pi || true)"
  [ -n "$bin" ] || { echo "FT20_HOST_ROOT unset and no 'pi' on PATH" >&2; return 1; }
  pkgdir="$(dirname "$(dirname "$(readlink -f "$bin")")")"
  while [ "$pkgdir" != / ]; do
    if [ -f "$pkgdir/package.json" ] &&
       node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).name==="@earendil-works/pi-coding-agent"?0:1)' "$pkgdir/package.json" 2>/dev/null; then
      printf '%s\n' "$pkgdir"; return 0
    fi
    pkgdir="$(dirname "$pkgdir")"
  done
  echo "could not resolve @earendil-works/pi-coding-agent from 'pi' on PATH; set FT20_HOST_ROOT" >&2
  return 1
}

HOST_ROOT="${FT20_HOST_ROOT:-$(resolve_host_root)}"
SDK_ROOT="${FT20_SDK_ROOT:-$HOST_ROOT/node_modules}"
NODE_TYPES="${FT20_NODE_TYPES:-$SDK_ROOT/@types/node}"
NPM_ROOT="${FT20_NPM_ROOT:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm/node_modules}"
BETTER_SQLITE3="${FT20_BETTER_SQLITE3:-1}"

NM="$PKG/node_modules"

# Refuse to work on a tree that already inherits deps from an ancestor: the
# link has to be self-contained or it proves nothing about the candidate.
ancestor="$PKG"
while [ "$ancestor" != / ]; do
  ancestor="$(dirname "$ancestor")"
  if [ -e "$ancestor/node_modules" ]; then
    echo "REFUSED: ancestor $ancestor/node_modules exists; stage this tree outside the repo" >&2
    exit 2
  fi
done

mkdir -p "$NM"

link() {
  local name="$1" target="$2" optional="${3:-0}"
  if [ ! -e "$target" ]; then
    if [ "$optional" = 1 ]; then echo "skip  $name (not present: $target)"; return 0; fi
    echo "MISSING: $target" >&2
    return 1
  fi
  mkdir -p "$NM/$(dirname "$name")"
  ln -sfnT "$target" "$NM/$name"
  printf 'link  %-38s -> %s\n' "$name" "$target"
}

link "@earendil-works/pi-coding-agent" "$HOST_ROOT"
link "@earendil-works/pi-ai"          "$SDK_ROOT/@earendil-works/pi-ai"
link "@earendil-works/pi-tui"         "$SDK_ROOT/@earendil-works/pi-tui"
link "@types/node"                    "$NODE_TYPES"
link "typebox"                        "$SDK_ROOT/typebox"
link "strip-ansi"                     "$NPM_ROOT/strip-ansi"
if [ "$BETTER_SQLITE3" = 1 ]; then
  link "better-sqlite3" "$NPM_ROOT/better-sqlite3" 1
fi

# This tool writes exactly one kind of thing: the symlinks under $NM. It has no
# receipt destination and reads no path from the environment, so it cannot be
# pointed at a file outside the package tree by a variable. Callers that want a
# selection receipt generate it themselves inside a validated scratch root
# (verify-portable.sh does, into receipts/sdk-selection.json).
echo
echo "linked under $NM (gitignored in the package; never committed)"
