# Incident: an unconfirmed `rm -rf` deleted a live skill from the fleet-wide load path

**Date:** 2026-11-08
**Lane:** `self-improvement-leader` (`w1K:p1`)
**Blast radius:** `~/.pi/agent/skills/profile-config/SKILL.md` — a real file on the **load path of every
leader lane**
**Outcome:** restored byte-identical. **The recovery was luck, not process.**
**Found by:** the lane itself, in the same turn, by running its own verification.

---

## 1. What happened

Relocating the fleet-authored skills into version control, I moved eight of them out of
`~/.agents/skills/` and symlinked each back. I then handled a ninth — `profile-config` — **without
checking where it lived**, on the assumption that it sat in the same root as the others:

```sh
# intended: replace a plain directory with a symlink
rm -rf ~/.pi/agent/skills/profile-config
ln -s "$REPO/profile-config" ~/.pi/agent/skills/profile-config
```

`$REPO/profile-config` did not exist, because `profile-config` was never moved — it does not live in
`~/.agents/skills/` at all. So the command deleted the real directory and pointed a dangling symlink
at a path that was never created. Both halves of one line were wrong, and neither was checked against
the filesystem first.

## 2. Why the recovery was luck

The content survived only because `profile-config` is a **shipped artifact of `pi-profile-switch`** —
our own fork of the launcher — so a second copy existed in two places:

| Source | sha256 | size |
|---|---|---|
| `~/Code/pi-profile-switch/skills/profile-config/SKILL.md` (the fork) | `e157d02c…f4ed` | 14892 B |
| `~/.pi/agent/npm/node_modules/pi-profile-switch/skills/profile-config/SKILL.md` (installed) | `e157d02c…f4ed` | 14892 B |
| restored `~/.pi/agent/skills/profile-config/SKILL.md` | `e157d02c…f4ed` | 14892 B |

**If that skill had been genuinely untracked — which is the exact condition the move was being made to
fix — the content would have been gone.** The nine *other* fleet-authored skills, the ones actually
being relocated, had no second copy anywhere: the same `rm -rf` against any of them would have
destroyed unrecoverable work. The one file that was lost was the only one that could be restored.

`stat` confirms the delete: the restored file is new content at the same path, and the original's
mtime (2026-11-06 01:42) is not recoverable — only its bytes are.

## 3. Conditions that made it possible

1. **A loop over an assumed root.** The eight real moves ran inside `for s in …` against
   `~/.agents/skills`. The ninth was handled by hand, outside that loop, and the hand-written
   version dropped the `[ -d "$SK/$s" ] && [ ! -L "$SK/$s" ]` guard the loop had. The guard was
   correct; leaving the loop removed it.
2. **`rm -rf` before the create, in one line.** Nothing verified that the source existed, or that the
   target was what it was believed to be, before the destructive half ran.
3. **A destructive command against a path that was assumed, not read.** This is the same defect as the
   fleet's standing rule about killing processes by command-line pattern: there, a pattern the caller
   *composed* was treated as if it identified a target it had never checked; here, a path the caller
   *assumed* was treated as if it had been read. Different flag, same failure.

### 3a. The class this belongs to — four instances in one day, three lanes

The same defect appeared four times on 2026-11-08, and in every one the **observation was true and the
sentence written from it was broader than its extent**:

| Observation (true) | The claim made from it (false) | Caught by |
|---|---|---|
| the string is absent from `src/` | `defer-mode-reapprove.py`'s confirmation check is dead code — it is in `extensions/mode.ts` | re-check before acting |
| `config.yaml` has 2 distinct hashes here | they "differ between spaces" — the axis is master vs client | the other lane |
| `find … -maxdepth 1 -xtype l` returns nothing | "no broken symlinks under `~/.agents/skills`" | the other lane |
| a *bare* `bd init` is dangerous | "never `bd init`" — withdrawing the one correct tool | the other lane |

**Two of those four were the other lane's, and one of them was asserted about its own file — where it had
the least excuse and the most direct access.** So the pattern is *not* "the author misses what the reader
catches", which would cast the reader as a checker and grant them an exemption. It is:

> **the extent of an observation is invisible from inside the sentence you are composing, and visible
> from the sentence you have never read.**

That is symmetrical, it is the same defect in both directions, and it is the actual argument for two
readers on every artifact — neither lane auditing the other, both being audited. The defect is not
carelessness in looking: every one of those observations was correctly made. It is that the *conclusion*
was written from the observation's **shape** rather than its **extent**. Two habits follow, and they are
the reason this section exists: state the scope you actually searched, and treat a claim you are about to
make in the absolute as a claim you have not yet tested.

## 4. The uncomfortable part, stated plainly

The delete happened **in the same turn as the argument for versioning these skills on safety grounds.**
The reasoning was that a load-bearing file with no history is a hazard, and the first action taken on
the strength of it was to destroy one — from the load path, unbacked-up, while two other lanes were
running. The argument was right and the execution was careless in exactly the way the argument was
supposed to prevent.

## 5. What changed as a result

- **`profile-config` must stay a real file, never a symlink — this is a correctness rule, not a
  consequence of the mistake.** Its package's `postinstall` writes the shipped skill **only when the
  path does not exist** (`test/postinstall.test.ts`: *"First install - writes shipped skill when
  `skills/profile-config` does not exist"*). A symlink satisfies that check, so package updates would
  **silently stop refreshing the skill** — a quieter failure than the untracked copy it replaced. Its
  history belongs in `~/Code/pi-profile-switch`, which is our fork. Recorded in
  `~/Code/fleet-skills/README.md`.
- **Never `rm -rf` a path not first confirmed moved**, and keep the `mv && ln` pair inside one guarded
  step **for every item, including the last one**. The durable form of the fix is not "remember the
  guard" — a hand-written ninth is how a loop's invariant leaks. Run the same guarded command for all
  N, so there is no ninth.
- Verification now reads the whole tree, not one level: `find ~/.agents/skills -xtype l` — which is how
  the pre-existing broken links below were found, after an earlier, narrower claim of "no broken
  symlinks" was made from `find … -maxdepth 1` and was wrong about its own scope.

## 6. Pre-existing, unrelated, and NOT from this incident

Four broken symlinks exist under `~/.agents/skills`; none were touched on 2026-11-08 and none are on a
lane's load path as a skill:

| Link | Target | Dated |
|---|---|---|
| `blue-steel/.venv` | `../cloverlabs-camoufox/.venv` | 2026-07-18 |
| `vrm-avatar-generation/.venv/bin/python` | `~/.proto/tools/python/3.12.0/bin/python3` | 2026-07-29 |
| `vrm-avatar-generation/.venv/bin/python3` | `python` | 2026-07-29 |
| `vrm-avatar-generation/.venv/bin/python3.12` | `python` | 2026-07-29 |

All **27** top-level symlinks under `~/.agents/skills` resolve.

## 7. Verification of the recovery

```sh
sha256sum ~/.pi/agent/skills/profile-config/SKILL.md
#   e157d02cb0f874dda1885392de97ad0522a94b7ee52004a6aa30736251c3f4ed  (14892 bytes)
head -4 ~/.pi/agent/skills/profile-config/SKILL.md   # frontmatter intact: name/description present
ls -la ~/.pi/agent/skills/profile-config              # a real directory, not a symlink
```

Confirmed independently by `overlord` (`wE:p1`): regular file, 14 892 bytes, same sha256.

## Sources

- This lane's transcript: `~/.pi/agent/sessions/--home-bitnom-Documents-Fleet--/2026-11-08T06-59-06-601Z_01a1b9f4-…jsonl`
- `~/Code/pi-profile-switch/test/postinstall.test.ts` — the "writes shipped skill when it does not
  exist" scenario
- `~/Code/pi-profile-switch/src/settings-generator.ts:27-30` — project-scope resources are never
  encoded into the profile filter
- `~/Code/fleet-skills/README.md` — the relocation, the convention, and the `profile-config` exception
- `pi-fleet-model/EXECUTION-RECORD.md` — the dated entry for this day's work
