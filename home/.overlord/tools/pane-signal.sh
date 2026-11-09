#!/usr/bin/env bash
# pane-signal — signal only the process that is *this pane's own foreground process*.
#
# The sanctioned way to stop something inside a herdr pane: read the pid herdr reports for
# that pane, show it, then signal exactly that pid. Never a pattern — a pattern over command
# lines matches the harness, the sibling lane and the shell you typed it in (see proc-find).
#
# For a pi lane the normal stop is still double `ctrl+c` in the pane. Use this when a lane
# is wedged and will not exit, when you need a specific signal, or when the target is not pi
# at all (a dev server, a watcher) but is nonetheless the pane's foreground process.
#
# Usage:
#   pane-signal <lane-or-pane> [--signal TERM] [--dry-run]
#
# Refuses to signal:
#   * anything when the pane is not found, or has no foreground process;
#   * this process itself, or any of its ancestors (you would be killing your own turn).
set -uo pipefail

HERDR="${HERDR_BIN_PATH:-herdr}"
[ -x "$HERDR" ] || HERDR="herdr"

target="${1:?usage: pane-signal <lane-or-pane> [--signal SIG] [--dry-run]}"
shift
sig="TERM"; dry=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --signal|-s) sig="${2:?--signal needs a value}"; shift 2 ;;
    --dry-run|-n) dry=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "pane-signal: unknown argument $1" >&2; exit 2 ;;
  esac
done

# Accept either a pane id (w17:p6) or a lane name.
pane="$target"
case "$target" in
  *:p*) ;;
  *) pane="$(timeout 20 "$HERDR" agent get "$target" 2>/dev/null | python3 -c '
import json,sys
try: print(json.load(sys.stdin)["result"]["agent"]["pane_id"])
except Exception: pass')" ;;
esac
[ -n "${pane:-}" ] || { echo "pane-signal: no pane found for '$target'" >&2; exit 2; }

# The target pid, plus an ancestry check: never signal ourselves or a parent.
exec 3>&1
read -r pid name started < <(timeout 20 "$HERDR" pane process-info --pane "$pane" 2>/dev/null | python3 -c '
import json,sys,os,time
try:
    d=json.load(sys.stdin)["result"]["process_info"]
except Exception:
    sys.exit(2)
procs=d.get("foreground_processes") or []
if not procs: sys.exit(3)
p=procs[0]
try: st=time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(os.stat("/proc/%d"%p["pid"]).st_ctime))
except Exception: st="?"
print(p["pid"], p.get("name") or "?", st.replace(" ","_"))
') || true
pid="${pid:-}"
[ -n "$pid" ] || { echo "pane-signal: $pane has no foreground process (nothing to signal)" >&2; exit 2; }

if [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ]; then
  echo "pane-signal: REFUSED — $pane's foreground pid is this shell; that would kill the caller" >&2
  exit 2
fi
# Walk up our own PPid chain; if the target is in it, signalling it ends this turn.
walk="$PPID"
while [ -n "$walk" ] && [ "$walk" != "0" ] && [ "$walk" != "1" ]; do
  if [ "$walk" = "$pid" ]; then
    echo "pane-signal: REFUSED — $pane's foreground pid ($pid) is an ancestor of this shell" >&2
    exit 2
  fi
  walk="$(grep -m1 '^PPid:' "/proc/$walk/status" 2>/dev/null | awk '{print $2}')"
done

echo "pane=$pane pid=$pid name=${name:-?} started=${started:-?} signal=$sig"
if [ "$dry" = 1 ]; then echo "dry-run: would send $sig to $pid"; exit 0; fi

kill "-$sig" "$pid" 2>/dev/null || { echo "pane-signal: failed to signal $pid" >&2; exit 2; }
echo "sent $sig to $pid"
