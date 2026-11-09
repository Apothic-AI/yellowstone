#!/usr/bin/env bash
# repair-lane-names — keep herdr agent names in sync with tab labels.
#
# Why: a herdr agent *name* is runtime detection state; the tab label is workspace state.
# `/new`, herdr's "reload config", and detach/re-attach all make herdr re-detect the agent
# and drop the name while the label survives — so a lane looks correct and cannot be reached
# by name. Observed 2026-11-01: 8 of 49 panes unnamed after one `/new` plus a detach, two of
# them leader lanes.
#
# Idempotent and quiet: nothing to do prints nothing. A numeric tab label is skipped, not
# renamed — herdr auto-names a fresh tab "1", and pil deliberately refuses those rather than
# baking a number into a lane identity.
set -uo pipefail
LOG="$HOME/.local/state/overlord/lane-names.log"
python3 - "$LOG" <<'PY'
import json,subprocess,sys,re,time
log=open(sys.argv[1],"a")
def sh(*a):
    return subprocess.run(a,capture_output=True,text=True).stdout
try:
    agents=json.loads(sh("herdr","agent","list"))["result"]["agents"]
except Exception as e:
    log.write("%s error reading agent list: %s\n"%(time.strftime("%Y-%m-%dT%H:%M:%SZ"),e)); raise SystemExit(0)
for a in [x for x in agents if not x.get("name")]:
    try: label=json.loads(sh("herdr","tab","get",a["tab_id"]))["result"]["tab"]["label"]
    except Exception: continue
    slug=re.sub(r"[^a-z0-9]+","-",label.lower()).strip("-")
    if not slug or not slug[0].isalpha():
        log.write("%s skip %s: tab label %r is not a name\n"%(time.strftime("%Y-%m-%dT%H:%M:%SZ"),a["pane_id"],label)); continue
    r=subprocess.run(["herdr","agent","rename",a["pane_id"],slug],capture_output=True,text=True)
    log.write("%s %s %s -> %s\n"%(time.strftime("%Y-%m-%dT%H:%M:%SZ"),"renamed" if r.returncode==0 else "FAILED",a["pane_id"],slug))
PY
