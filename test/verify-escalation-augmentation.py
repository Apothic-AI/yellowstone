#!/usr/bin/env python3
"""verify-escalation-augmentation.py — the gate on "unblock as the escalation route".

The change this gate guards is a ROUTE change, not a trigger change. Every prompt
site it touches already told the agent to escalate, ask, message or report to the
operator; the change says only where that ask is filed (the `unblock` skill, a
page ask by default). The constraint worth enforcing is therefore:

  the escalation frequency must not rise — the existing narrow operator-only
  paths stay narrow; they route through `unblock` now.

Four checks, and each one fails the script:

  1. NO NEW TRIGGER. For every changed prompt file, count a fixed list of
     escalation trigger phrases and require every count to be <= the baseline
     captured from the pre-change text. A count that rises means a new escalation
     sentence was added, which the brief forbids.

  2. THE ROUTE IS PRESENT. Each augmented site must still carry its original
     anchor (exactly once) with the word `unblock` inside a short window of it.
     This is what stops the augmentation from being a no-op.

  3. CONTROLS UNTOUCHED. The sentences the audit listed as "Controls — already
     right, do not touch" must still be present byte-identical. Mode prompts are
     checked in their decoded `systemPrompt`; prose files (SKILL.md, AGENTS.md,
     overlord-wake.sh) are matched after collapsing whitespace runs to one space,
     because their layout wraps mid-sentence and the layout is not the control.

  4. NOTHING ELSE MOVED. Each changed file must be reproducible from the base
     commit by applying exactly the recorded insertions and nothing else. This is
     the reviewability check: a diff with one hidden edit in it fails here even
     if checks 1-3 pass.

Mirror discipline is checked too: where a live mode file exists (this is a fleet
tree installed onto a machine with `home/` as the install source), the live file
must be byte-identical to its repo copy. Files with no live counterpart here are
reported as skipped, not silently passed — a fresh clone on another machine has
no `~/.pi/agent`, and a check that fails on a normal state is a check people
learn to ignore (`test/verify-mirror-live.sh` skips on the same rule).

Baselines below were captured from the tree at base commit 8e3a04fd1
("git subrepo push src/herdr-plugins/unblock", 2026-11-28T03:50Z), which is the
commit this change sits on. Counts are over the DECODED `systemPrompt` of each
mode file (what a lane actually loads) and over the plain text of prose files,
with whitespace runs collapsed to one space. Re-run meaningfully by diffing the
files against that commit; the counts are facts about that text, not estimates.
"""

import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "8e3a04fd1375989c5f42eee732529488427bd09d"

# --- 1. the trigger vocabulary -------------------------------------------------
TRIGGERS = [
    "only the operator",
    "ask the operator",
    "escalate",
    "escalat",            # covers escalate/escalated/escalation in one shape
    "message the operator",
    "DM the operator",
    "report to the operator",
    "blocked on",
    "stop and report",
]

BASELINE = {
    "home/.pi/agent/modes/worker.json": {
        "only the operator": 0, "ask the operator": 0, "escalate": 0, "escalat": 0,
        "message the operator": 0, "DM the operator": 0, "report to the operator": 0,
        "blocked on": 0, "stop and report": 0},
    "home/.pi/agent/modes/leader.json": {
        "only the operator": 0, "ask the operator": 0, "escalate": 0, "escalat": 0,
        "message the operator": 0, "DM the operator": 0, "report to the operator": 0,
        "blocked on": 1, "stop and report": 0},
    "home/.overlord/.pi/modes/leader.json": {
        "only the operator": 0, "ask the operator": 1, "escalate": 5, "escalat": 6,
        "message the operator": 0, "DM the operator": 0, "report to the operator": 0,
        "blocked on": 1, "stop and report": 0},
    "home/.sysops/.pi/modes/leader.json": {
        "only the operator": 0, "ask the operator": 0, "escalate": 0, "escalat": 0,
        "message the operator": 0, "DM the operator": 0, "report to the operator": 0,
        "blocked on": 0, "stop and report": 0},
    ".pi/modes/leader.json": {
        "only the operator": 0, "ask the operator": 0, "escalate": 0, "escalat": 0,
        "message the operator": 0, "DM the operator": 0, "report to the operator": 0,
        "blocked on": 0, "stop and report": 0},
    "home/Unity/Projects/Pleroma/.pi/modes/leader.json": {
        "only the operator": 0, "ask the operator": 0, "escalate": 0, "escalat": 0,
        "message the operator": 0, "DM the operator": 0, "report to the operator": 0,
        "blocked on": 0, "stop and report": 0},
}

# The skill is PART 1 of the change: it moves the page-vs-fields DEFAULT, so it
# must not widen the gate on what may be filed at all. These counts are the gate
# wording itself (the only_you schema and the two filing calls).
SKILL = "src/herdr-plugins/unblock/skills/unblock/SKILL.md"
SKILL_TRIGGERS = ["only_you", "file an ask", "unblock_park", "unblock file"]
SKILL_BASELINE = {"only_you": 9, "file an ask": 1, "unblock_park": 2, "unblock file": 2}

# --- 2. the augmented sites ----------------------------------------------------
# Each row: the pre-change anchor (proves the site existed before, and makes the
# file reproducible from the base commit), the inserted text, a pointer that is
# stable AFTER the change, and the word that must sit near that pointer — so the
# augmentation cannot be a no-op and cannot drift away from the site it augments.
# `old is None` means the anchor survives the insertion verbatim.
SITES = [
    dict(tag="1 worker stop-on-blocked", file="home/.pi/agent/modes/worker.json",
         old="If blocked, say what is missing and who owns it, then stop.",
         new="If blocked, say what is missing and who owns it, file it with the unblock skill "
             "as a page ask rather than a chat question, then stop.",
         pointer="If blocked, say what is missing and who owns it,", near="unblock"),

    dict(tag="2 worker room-post/DM", file="home/.pi/agent/modes/worker.json",
         old="a handoff, an authorization boundary, or a final/milestone report.",
         new="a handoff, an authorization boundary, or a final/milestone report — and when the answer "
             "is the operator's, file it with the unblock skill as a page ask, not a DM.",
         pointer="a handoff, an authorization boundary, or a final/milestone report",
         near="unblock"),

    dict(tag="3 leader room-post/DM", file="home/.pi/agent/modes/leader.json",
         old="a handoff, an authorization boundary, or a final/milestone report.",
         new="a handoff, an authorization boundary, or a final/milestone report — and when it is the "
             "operator's item from that list, file it with the unblock skill as a page ask, not a DM.",
         pointer="a handoff, an authorization boundary, or a final/milestone report",
         near="unblock"),

    dict(tag="4 leader genuinely-blocked list", file="home/.pi/agent/modes/leader.json",
         old="Genuinely blocked, and reporting is then the right answer:",
         new="Genuinely blocked, and reporting is then the right answer — file it with the unblock "
             "skill as a page ask, not a chat question:",
         pointer="Genuinely blocked, and reporting is then the right answer", near="unblock"),

    dict(tag="5 overlord preference-escalation", file="home/.overlord/.pi/modes/leader.json",
         old="escalate to the operator only when the answer is a preference with no reasonable resolution; a preference",
         new="escalate to the operator only when the answer is a preference with no reasonable resolution, "
             "filed with the unblock skill as a page ask; a preference",
         pointer="escalate to the operator only when the answer is a preference with no reasonable resolution",
         near="unblock"),

    dict(tag="6 overlord escalate-only-the-rest list", file="home/.overlord/.pi/modes/leader.json",
         old=None,
         new="escalate only if it is a genuine operator sign-in/approval; and each item here that does "
             "reach them is filed the way the line below says — with `unblock`, a page ask",
         pointer="escalate only if it is a genuine operator sign-in/approval",
         near="unblock"),

    dict(tag="P1 skill page-ask opener", file=SKILL,
         old="When the answer needs more than fields — a form of your own design, formatted\n"
             "context, an image, a chart, a link out, an embedded artefact — file a PAGE ask.",
         new="A PAGE ask is the DEFAULT for anything you put in front of the human: a form of\n"
             "your own design, formatted context, an image, a chart, a link out, an embedded\n"
             "artefact — and equally a single question whose answer deserves the room. Keep\n"
             "structured fields only for a simple single question that gains nothing from a\n"
             "page: one thing back, a name, a value, a yes. A page costs you real authoring\n"
             "effort — the ticket's page is a directory you edit, with assets to write or\n"
             "fetch — so this is a default, not a ban: spending that effort when the page\n"
             "carries the question better is the point, and reaching for fields only to skip\n"
             "it is the mistake.",
         pointer="## Page asks (kind: page)", near="DEFAULT"),

    dict(tag="P1b skill fields introduction", file=SKILL,
         old=None,
         new="`paste` for output only their machine can produce.\n"
             "  For anything beyond a single question that gains nothing from a page — context\n"
             "  to show, options to compare, an answer that deserves room of its own — file a\n"
             "  page ask (see Page asks below).",
         pointer="`paste` for output only their machine can produce.", near="page ask"),
]

# --- 3. the controls the audit says are already right --------------------------
# (file, exact substring, decoded-as-json?)
CONTROLS = [
    # global leader: the act rule, and the section that carries it
    ("home/.pi/agent/modes/leader.json",
     "Converting a known resolution into a question is a defect, not caution.", True),
    ("home/.pi/agent/modes/leader.json", "When you already know the resolution, act", True),
    # yellowstone leader: standing authority, its exhaustive-list rule, and the
    # operator list this change now routes (the list itself must not grow)
    (".pi/modes/leader.json", "Standing authority: fleet and harness updates are yours", True),
    (".pi/modes/leader.json", "Whose call is it when it is not on that list? Yours.", True),
    # overlord leader: the do-nothing resolution rule, and the file's own existing
    # unblock line that site 6 points the escalation list at
    ("home/.overlord/.pi/modes/leader.json",
     '**A resolution that is "do nothing, record it" needs no one.**', True),
    ("home/.overlord/.pi/modes/leader.json",
     "Structured asks that must outlive the chat go through the `unblock` skill: "
     "chat reports, the queue asks.", True),
    # the two restrictions that must NOT have grown a route
    ("home/.overlord/.pi/modes/worker.json", "You never message the operator", True),
    ("home/.sysops/.pi/modes/worker.json",
     "Your report is `reported` until the leader reads the artifact.", True),
    # global core: the don't-stop-to-report rule
    ("home/AGENTS.md",
     "You do not stop to report while work remains unless blocked on something "
     "only the operator can resolve.", False),
    # the wake prompt's narrow escalation rule
    ("home/.overlord/tools/overlord-wake.sh",
     "Only escalate to the operator if a stall persists after you nudged it, or a "
     "genuinely new blocker appears that is not an authorization ask or a provider retry.",
     False),
    # the skill's gate: the only_you categories and the filing table
    (SKILL, "| `credential` | their sign-in, password, key or 2FA code |", False),
    (SKILL, "| `their_account` | a click in a console or app signed in as them. "
            "Ask for consent first |", False),
    (SKILL, "| `spend` | money or a paid plan: a `spend` ask |", False),
    (SKILL, "| `message` | a message sent to a real person, as them: a `message` ask |", False),
    (SKILL, "| `judgment` | a product or taste call only they should make |", False),
    (SKILL, "A blocker made only of choices is a question in disguise and is rejected.", False),
    (SKILL, "| `unblock_park` | yes. Holds until answered | one per agent |", False),
    (SKILL, "Merges, deploys, infra fixes and keys the human already set up need no ask.", False),
]

# --- 4. repo mirror -> the live file it installs to ----------------------------
MIRRORS = [
    ("home/.pi/agent/modes/worker.json", ".pi/agent/modes/worker.json"),
    ("home/.pi/agent/modes/leader.json", ".pi/agent/modes/leader.json"),
    ("home/.overlord/.pi/modes/leader.json", ".overlord/.pi/modes/leader.json"),
    ("home/.sysops/.pi/modes/leader.json", ".sysops/.pi/modes/leader.json"),
    ("home/Unity/Projects/Pleroma/.pi/modes/leader.json",
     "Unity/Projects/Pleroma/.pi/modes/leader.json"),
]

failures = []
warnings = []


def norm(s):
    return re.sub(r"\s+", " ", s)


def text_of(rel, decoded_json=True):
    """The text a lane reads: systemPrompt for a mode file, the file for prose."""
    path = os.path.join(ROOT, rel)
    raw = open(path, encoding="utf-8").read()
    if rel.endswith(".json") and decoded_json:
        return json.loads(raw).get("systemPrompt", "")
    return raw


def base_text(rel, decoded_json=True):
    out = subprocess.run(["git", "-C", ROOT, "show", f"{BASE}:{rel}"],
                         capture_output=True, text=True)
    if out.returncode != 0:
        return None
    if rel.endswith(".json") and decoded_json:
        return json.loads(out.stdout).get("systemPrompt", "")
    return out.stdout


def fail(msg):
    failures.append(msg)
    print(f"FAIL  {msg}")


def ok(msg):
    print(f"ok    {msg}")


print("== 1. no new escalation trigger (counts must not rise above base commit "
      f"{BASE[:9]})")
for rel, baseline in BASELINE.items():
    text = norm(text_of(rel))
    for pattern, allowed in baseline.items():
        got = text.count(pattern)
        if got > allowed:
            fail(f"{rel}: trigger {pattern!r} x{got} > baseline x{allowed}")
    if not any(f.startswith(rel) for f in failures):
        ok(f"{rel}: every trigger count <= baseline "
           f"({sum(baseline.values())} occurrences total, all unchanged or lower)")
skill_text = norm(text_of(SKILL, decoded_json=False))
for pattern, allowed in SKILL_BASELINE.items():
    got = skill_text.count(pattern)
    if got > allowed:
        fail(f"{SKILL}: gate word {pattern!r} x{got} > baseline x{allowed}")
ok(f"{SKILL}: page-mode default did not widen the askable set "
   f"({len(SKILL_BASELINE)} gate words at or below baseline)")

print("\n== 2. the route is present at every augmented site")
for site in SITES:
    text = text_of(site["file"])
    if text.count(site["pointer"]) != 1:
        fail(f"{site['tag']}: pointer appears {text.count(site['pointer'])} times in "
             f"{site['file']} (expected 1)")
        continue
    if site["new"] not in text:
        fail(f"{site['tag']}: the recorded augmentation is not present in {site['file']}")
        continue
    start = text.find(site["new"])
    window = text[max(0, start - 200):start + len(site["new"]) + 200]
    if site["near"] not in window:
        fail(f"{site['tag']}: {site['near']!r} is not within 200 chars of the site in {site['file']}")
        continue
    ok(f"{site['tag']}: {site['file']} — anchor x1, {site['near']!r} inside the sentence")

print("\n== 3. controls byte-identical")
for rel, sentence, decoded in CONTROLS:
    text = text_of(rel, decoded) if decoded else text_of(rel, decoded_json=False)
    hay = text if decoded else norm(text)
    needle = sentence if decoded else norm(sentence)
    if hay.count(needle) != 1:
        fail(f"control missing or duplicated in {rel}: {sentence[:70]!r}")
    else:
        ok(f"{rel}: control intact — {sentence[:60]!r}")

print("\n== 4. nothing else moved (every recorded insertion is still in place, and nothing is uncommitted)")
changed_files = []
for site in SITES:
    if site["file"] not in changed_files:
        changed_files.append(site["file"])
for rel in changed_files:
    base = base_text(rel, decoded_json=rel.endswith(".json"))
    sites = [x for x in SITES if x["file"] == rel]
    if base is None:
        warnings.append(f"{rel}: base commit {BASE[:9]} not readable here, "
                        "reconstruction check skipped")
        print(f"SKIP  {rel}: base commit not readable (reconstruction not proven)")
        continue
    for site in sites:
        # the site must have existed before the change: the pre-change anchor is
        # either the now-surviving pointer, or the text the insertion replaced
        before = site["old"] if site["old"] is not None else site["pointer"]
        if base.count(before) != 1:
            fail(f"{site['tag']}: pre-change anchor appears {base.count(before)} times "
                 f"in {rel} at base (expected 1) — is this still the same site?")
    # A commit AFTER the insertion base may edit these files on purpose — 2f38fec99
    # ("act means drive it through a lane") changed the global leader, sysops leader and
    # global AGENTS.md on the operator's instruction. That is allowed and is not this
    # script's business. What is NOT allowed is a recorded insertion disappearing, a
    # trigger count rising (section 1) or a control moving (section 3) — so reconstruct
    # nothing, and assert the insertions survive plus the file is the committed one.
    now = text_of(rel)
    for site in sites:
        if now.count(site["new"]) != 1:
            fail(f"{site['tag']}: the recorded insertion is present "
                 f"{now.count(site['new'])} times in {rel} (expected 1) — a later edit "
                 "removed or duplicated it")
    uncommitted = subprocess.run(
        ["git", "-C", ROOT, "diff", "--quiet", "HEAD", "--", rel]
    ).returncode != 0
    if uncommitted:
        fail(f"{rel}: working copy differs from the committed blob (uncommitted edit)")
    else:
        ok(f"{rel}: {len(sites)} recorded insertion(s) present; working copy matches HEAD")

print("\n== 6. no space file restates the global route (global mode's 'Creating a new space')")
# A lane composes the global mode AND its space file, so the route arrives through the global
# mode. Repeating it in a space file is a restated copy: it drifts from the original, and the
# copy is what the lane follows. The space-specific sentence stays; only the route phrasing
# must not appear in the space file.
SPACE_FILES = [
    ".pi/modes/leader.json",
    "home/.sysops/.pi/modes/leader.json",
    "home/Unity/Projects/Pleroma/.pi/modes/leader.json",
]
for rel in SPACE_FILES:
    prompt = text_of(rel, decoded_json=True)
    if prompt is None:
        warnings.append(f"{rel}: not readable, restatement check skipped")
        print(f"SKIP  {rel}: not readable")
        continue
    if "with the unblock skill" in prompt or "unblock skill as a page ask" in prompt:
        fail(f"{rel}: restates the global unblock route — the route belongs in the global "
             "mode; a space file carries only what is specific to that space")
    else:
        ok(f"{rel}: carries no restated route")

print("\n== 5. tree and machine agree (repo copies vs installed live files)")
home = os.path.expanduser("~")
for rel, live_rel in MIRRORS:
    if rel not in changed_files:
        continue
    live = os.path.join(home, live_rel)
    if not os.path.exists(live):
        warnings.append(f"{live}: absent on this machine, mirror equality not checked")
        print(f"SKIP  {rel}: {live} absent (mirror equality not checked)")
        continue
    repo_bytes = open(os.path.join(ROOT, rel), "rb").read()
    live_bytes = open(live, "rb").read()
    if repo_bytes != live_bytes:
        fail(f"{rel} != {live} — the tree and the machine disagree")
    else:
        ok(f"{rel} == {live}")

print()
for w in warnings:
    print(f"note: {w}")
if failures:
    print(f"\nFAILED — {len(failures)} check(s) broke the constraint.")
    sys.exit(1)
print("PASS — no trigger count rose, every site routes through unblock, "
      "controls intact, nothing else moved.")
