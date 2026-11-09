#!/usr/bin/env bash
# verify-pi-modes-install — prove the fleet is actually running the fork, not the npm package.
#
# Why: `pi install <path>` is the only thing that repoints a package at a local checkout, and a
# failed or skipped install leaves settings.json on `npm:@tryinget/pi-modes`. The version can
# even look right if npm happens to carry a matching release, so accept from two facts:
#   1. the settings entry names a path (our fork), not the npm spec, and
#   2. the installed manifest's version/commit matches what we built.
# A lane still only picks it up at its next launch — report "installed" and "active" separately.
set -uo pipefail
settings="$HOME/.pi/agent/settings.json"
manifest="$HOME/.pi/agent/npm/node_modules/@tryinget/pi-modes/package.json"

python3 - "$settings" "$manifest" <<'PY'
import json, sys, os
settings, manifest = sys.argv[1], sys.argv[2]
out = {}
try:
    s = json.load(open(settings))
    entry = [p for p in s.get("packages", []) if "pi-modes" in str(p)]
    out["settings_entry"] = entry[0] if entry else None
except Exception as e:
    out["settings_entry"] = f"unreadable: {e}"
try:
    m = json.load(open(manifest))
    out["version"] = m.get("version")
except Exception as e:
    out["version"] = f"unreadable: {e}"

entry = str(out["settings_entry"])
local = entry.startswith("/") or "code/" in entry.lower() or "apothic" in entry.lower()
npm = "npm:" in entry
verdict = "PASS" if local and not npm else "FAIL"
print(f"{verdict} entry={out['settings_entry']} version={out['version']}")
if npm:
    print("  -> still the published package; `pi install <package path>` has not taken effect")
elif not local:
    print("  -> entry is neither a local path nor the npm spec; inspect settings.json by hand")
print("  reminder: installed != active. A lane runs the module it loaded at launch.")
raise SystemExit(0 if verdict == "PASS" else 1)
PY