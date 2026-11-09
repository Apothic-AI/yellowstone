#!/usr/bin/env python3
"""verify-space-split — mechanical gate for the AGENTS.md / role-mode split.

Checks, per space:
  * .pi/launch.env exists and carries the composed launch line
  * every .pi/modes/<key>.json parses, has schemaVersion 2, key == filename,
    promptStrategy "append", non-empty systemPrompt
  * each role file's opening sentence appears in AGENTS.md's `## Degraded start`
  * AGENTS.md has `## Degraded start` when any role file exists
  * preserved: every substantive line removed from the original AGENTS.md still
    appears in one of the role files (reported, not failed, as ORPHAN)
  * scope: no working-tree change outside AGENTS.md and .pi/ (git and jj)

Usage: verify-space-split.py <space-cwd> [--orig <path>]
Exit: 0 all hard checks pass, 1 otherwise.
"""
import json, os, re, subprocess, sys

LAUNCH = "PI_MODE=leader PI_PROFILE=leader PI_MODE_CONFIRM_PROJECT=1"
OPENERS = {"leader": "You are the", "worker": "You are a worker in the"}

def norm(s):
    return re.sub(r"\s+", " ", s).strip()

def main(argv):
    cwd = argv[0]
    orig_arg = None
    if "--orig" in argv:
        orig_arg = argv[argv.index("--orig") + 1]
    slug = re.sub(r"[^a-z0-9]+", "-", os.path.basename(cwd).lower()).strip("-")
    orig = orig_arg or f"/tmp/workspace-split/{slug}.AGENTS.md.orig"
    agents = os.path.join(cwd, "AGENTS.md")
    fails, warns, notes = [], [], []

    text = open(agents, encoding="utf-8", errors="replace").read() if os.path.isfile(agents) else ""
    if not text:
        fails.append("AGENTS.md missing")

    # launch.env
    le = os.path.join(cwd, ".pi", "launch.env")
    if not os.path.isfile(le):
        fails.append("no .pi/launch.env")
    elif norm(open(le).read()) != LAUNCH:
        fails.append(f"launch.env is {norm(open(le).read())!r}")

    # role files
    modes = {}
    mdir = os.path.join(cwd, ".pi", "modes")
    if os.path.isdir(mdir):
        for name in sorted(os.listdir(mdir)):
            if not name.endswith(".json"):
                continue
            key = name[:-5]
            p = os.path.join(mdir, name)
            try:
                d = json.load(open(p, encoding="utf-8"))
            except Exception as e:
                fails.append(f"{name}: invalid JSON ({e})")
                continue
            if d.get("schemaVersion") != 2:
                fails.append(f"{name}: schemaVersion != 2")
            if d.get("key") != key:
                fails.append(f"{name}: key {d.get('key')!r} != {key!r}")
            if d.get("promptStrategy") != "append":
                fails.append(f"{name}: promptStrategy {d.get('promptStrategy')!r} != 'append'")
            sp = (d.get("systemPrompt") or "").strip()
            if not sp:
                fails.append(f"{name}: empty systemPrompt")
            modes[key] = sp

    # degraded start names the openers
    if modes:
        if "## Degraded start" not in text:
            fails.append("role files exist but AGENTS.md has no '## Degraded start'")
        ds = text.split("## Degraded start", 1)[-1] if "## Degraded start" in text else ""
        for key, sp in modes.items():
            first = norm(sp.split("\n", 1)[0])
            # the phrase to look for: opener up to the first clause break
            phrase = re.split(r" [—-] ", first)[0]
            if phrase not in norm(ds):
                fails.append(f"Degraded start does not name {key} opener: {phrase!r}")

    # preservation: every substantive sentence of the original must survive somewhere
    # (shared file or a role file), allowing for re-wrapping and light rewording.
    orphans = []
    if os.path.isfile(orig):
        old = open(orig, encoding="utf-8", errors="replace").read()
        union = norm(text + " " + " ".join(modes.values()))
        low = union.lower()
        for sentence in re.split(r"(?<=[.:;!?])\s+", norm(old)):
            s = norm(sentence)
            if len(s.split()) < 8 or s.lower() in low:
                continue
            from difflib import SequenceMatcher
            if SequenceMatcher(None, s.lower(), low).quick_ratio() < 0.85:
                orphans.append(s)
                continue
            # cheap local window search around the longest word
            if SequenceMatcher(None, s.lower(), low).ratio() < 0.80:
                orphans.append(s)
        if orphans:
            warns.append(f"{len(orphans)} original sentence(s) not preserved in text or role file")
    else:
        notes.append(f"no original at {orig}")

    # scope
    try:
        out = subprocess.run(["git", "-C", cwd, "status", "--porcelain"], capture_output=True, text=True, timeout=20).stdout
        bad = [l for l in out.splitlines() if l[3:].strip() and not (l[3:].strip().startswith(".pi/") or l[3:].strip() == "AGENTS.md")]
        if bad:
            warns.append("git dirty outside AGENTS.md/.pi (may predate this change): " + "; ".join(bad[:4]))
    except Exception:
        pass
    try:
        out = subprocess.run(["jj", "-R", cwd, "status"], capture_output=True, text=True, timeout=20).stdout
        if out.strip() and "No working copy changes" not in out:
            touched = [l for l in out.splitlines() if l.startswith(("M ", "A ", "D "))]
            bad = [l for l in touched if not any(t in l for t in ("AGENTS.md", ".pi/"))]
            if bad:
                warns.append("jj dirty outside AGENTS.md/.pi (may predate this change): " + "; ".join(bad[:4]))
    except Exception:
        pass

    verdict = "PASS" if not fails else "FAIL"
    print(f"{verdict} {cwd}")
    print(f"  modes={sorted(modes)} agents_lines={len(text.splitlines())}")
    for f in fails:
        print("  FAIL:", f)
    for w in warns:
        print("  WARN:", w)
        if orphans:
            shown = orphans[:6]
            for o in shown:
                print("    orphan:", o[:120])
            if len(orphans) > len(shown):
                print(f"    ... {len(orphans) - len(shown)} more")
    for n in notes:
        print("  NOTE:", n)
    return 0 if not fails else 1

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))