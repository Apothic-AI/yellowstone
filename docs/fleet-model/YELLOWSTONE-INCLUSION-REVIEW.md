# Yellowstone inclusion review — what is in, what is proposed, what is excluded

**For operator review.** Nothing here is a decision until you say so; where the repo already does
something, it is marked *in place* rather than *approved*, because most of it landed during FT-01 under
delegated authority and has never been reviewed as a list.

Measured against `origin/master` **`d6ddedd1`** at 2026-11-09 04:22 GMT-5. Every count below came from
the tree, and the command that produced it is named, so a later reader can re-derive rather than trust.

---

## 1. Components carried as git subrepos — 15

Named by lineage, not by org; branch is the branch the install *resolves to* (D9), not the merge branch.

| path | remote | branch | pin |
|---|---|---|---|
| `pi-extensions/signalridge` | `Apothic-AI/pi-extensions` | `apothic` | `d4e3f53f` |
| `pi-extensions/tryinget` | `Apothic-AI/pi-extensions-1` | `apothic-main` | `295b3136` |
| `pi-extensions/bizzy` | `Apothic-AI/bizzy` | `apothic-main` | `3e458fae` |
| `pi-extensions/pi-rooms` | `Apothic-AI/pi-rooms` | `master` | `efe58960` |
| `pi-extensions/apothic-todo` | `Apothic-AI/apothic-todo` | `main` | `ef2dc635` |
| `pi-extensions/pi-persist` | `Apothic-AI/pi-persist` | `main` | `194b7ece` |
| `pi-extensions/pi-pretty-tui` | `Apothic-AI/pi-pretty-tui` | `test/composer-selection-on-apothic` | `ec6df5eb` |
| `pi-extensions/pi-cache-optimizer` | `bitnom/pi-cache-optimizer` | `feat/opencode-cache-stats` | `ec7886dd` |
| `pi-extensions/pi-fleet-hooks` | `Apothic-AI/pi-fleet-hooks` | `master` | `b048cc08` |
| `pi-extensions/pi-profile-switch` | `Apothic-AI/pi-profile-switch` | `main` | `08d9a897` |
| `herdr-plugins/unblock` | `Apothic-AI/unblock` | `apothic-main` | `5887cefa` |
| `herdr-plugins/herdr-voice-linux` | `Apothic-AI/herdr-voice-linux` | `linux-port` | `5c3cf3f7` |
| `skills/fleet-skills` | `bitnom/fleet-skills` | `master` | `f471ec53` |
| `skills/mycord` | `Apothic-AI/mycord` | `master` | `082556ff` |

`find src -name .gitrepo | wc -l` → 14. Round-trip gate reproduces all 14 from a fresh clone with every
pull a no-op.

**Two of these are skills-only and carry no pi package** — `fleet-skills` (8 skills) and `mycord`
(10 skills). They are invisible to `pi list` and to the install gate; only a manifest check sees them.

---

## 2. Included, but not as subrepos

| what | where | size | why not a subrepo |
|---|---|---|---|
| **fleet tooling** — 51 scripts, `bin/{bd,pil,pi-session-rescue}`, `overlord-operations` skill | `home/.overlord/` | 57 files | it is the fleet's own machinery, not a third-party project; there is no upstream to track |
| **config mirror** — herdr config, pi settings/models, agent skills, `~/AGENTS.md`, `~/.local/bin`, `~/.sysops` | `home/` | 83 files total | the mirror *is* the source of truth for machine config; a subrepo would be a subrepo of nothing |
| **repo tooling** — `install.sh`, `scripts/*.sh`, `test/*.sh` | repo root | ~30 files | belongs to this repo by definition |
| **skills bundles** — `yellowstone`, `hotshot`, `shared-flyio-build-server`, `cargo-remote-build`, +1 | `home/.agents/skills/` | 5 rows | content with no installable home, or host-specific |
| **dagr skill** | via dagr plugin | 1 row | the provider is the dagr binary, not a repo |

`skills/skills.tsv` → 20 `repo` · 5 `bundle` · 1 `dagr`. **Zero `repo` rows point outside the tree** —
every repo-kind skill resolves inside the checkout.

---

## 3. Candidates — not in the tree, needs your call

### 3a. `herdr` — **decided: carried as subrepo 15**

`Apothic-AI/herdr` @ `apothic-main` at `src/apps/herdr`. Operator decision, 2026-11-09: *our herdr
fork should probably be a subrepo.* It is in, 52M tracked, 3113 files, `EXPECTED=15`.

My earlier recommendation here was *do not carry it*, on the reasoning that it ships binaries and its
deploy path is already procedural. That reasoning was wrong for this fork: **we carry local changes to
it**, which is the same test that puts the other nine pi extensions in `src/` — a fork is a component,
an unmodified upstream is not. `herdr-leader` develops against it, and a fork developed outside the
monorepo is the scatter the monorepo exists to end.

**One loose end it exposes:** herdr ships its own skill at `skills/herdr/SKILL.md` (214 lines) while the
live copy is 224 — the fork's delta has not been reconciled back into the fork's own repo. Once it is,
that skill row can stop being a `home/` copy, which is the third directive below.

### 3b. Sixteen remote npm packages the fleet installs

`pi-thinking-fold`, `pi-web-access`, `pi-auto-compact`, `pi-themes`, `pi-nested-skills`, `pi-btw`,
`pi-copy-message`, `pi-model-picker`, `pi-core-tps-stats`, `agents-cron`, `pi-hermes-memory`, `pix-voice`,
`pi-beads-extension`, `pi-double-paste`, `pi-paster`, `pi-undo`

**The question:** stay remote (`pi update --extensions` advances them) or vendor into `src/`?

**Recommendation: stay remote.** They are unmodified upstream packages; vendoring sixteen forks to track
code we do not change is the opposite of what the monorepo is for. The nine in-tree packages are there
because they are **forked** — we carry local changes.

### 3c. `cargo-remote-3000` — infrastructure, content already inside

Removed as a subrepo tonight at your instruction; its 164-line `SKILL.md` is now a mirror bundle. Still
on disk at `~/Code/cargo-remote-3000` (1.2G, the Fly build server) for `cargo-remote-build` builds.

**The question:** nothing, unless you want the build server's source tracked somewhere. It is
infrastructure, not harness.

### 3d. Project repos — live lanes that are *not* fleet components

`solid-lynx`, `apothic-website-v2`, `billion-context-bleeding`, `open-surrealdb-ds`, `dxdb`, `sub2api`,
`synomone`, `vpn2proxy`, `sionna-*`, and the rest. Ten live lanes currently `cd` into a `~/Code` repo
that is not a subrepo.

**Recommendation: exclude them all.** They are products with their own remotes and cadences; a lane for
a product works in that product's repo. This is the distinction you drew — several herdr lanes are not
fleet components.

---

### 3e. Non-fleet workspaces — **decided: they stay out, permanently**

Operator decision, 2026-11-09: *Assistant, Comms, overlord, self-improvement, sysops, Personal are not
run from yellowstone. Sync changes via git to their subrepos. There are a lot of files and data relating
to our specific fleet we won't want tracked in git anyway.*

So the `spaces/` layer is scoped to **component development only** — a lane editing a pi extension or a
herdr plugin. A lane whose subject is documents, coordination, or personal data keeps its own directory
and its own state, and shares code with the monorepo through `git subrepo pull`/`push`, not by living
inside the tree.

| space | cwd | in yellowstone? |
|---|---|---|
| `pi-rooms`, `pi-pretty-tui`, `pi-modes`, `unblock`, `mycord`, `herdr-voice` | `spaces/<component>` in a worktree | **yes** — component lanes |
| `assistant`, `comms`, `overlord`, `self-improvement`, `sysops`, `personal` | `~/Documents/*`, `~/.overlord`, `~/.sysops` | **no** — never |

This also rules out a tempting future move: putting `.overlord/tools` *state* or the fleet's continuity
files into `home/` because they are fleet-related. The mirror carries content; it does not carry the
fleet's working data.

### 3f. Agent skills — **decided: subrepos, not copies**

Operator decision, 2026-11-09: *regarding agent skills, those should all be subrepos.*

Current manifest: **20 `repo` · 5 `bundle` · 1 `dagr`**. Target is `repo` for everything a repo can
serve. Measured state of the five bundles:

| skill | source | can be a subrepo row | action |
|---|---|---|---|
| `herdr` | herdr's own `skills/herdr/` | **yes**, now that herdr is subrepo 15 | make `repo`; needs path support — resolver builds `<checkout>/<id>` but the file is at `<checkout>/skills/<id>` |
| `shared-flyio-build-server` | 9 host-specific files, no repo | needs a home | move into `fleet-skills` (a subrepo we own) |
| `cargo-remote-build` | a skill dir in `cargo-remote-3000` | needs a home | move into `fleet-skills` |
| `hotshot` | `Apothic-AI/one-shot-genius` — **0 commits** | **no** | blocked until that repo has content |
| `yellowstone` | this repo's own `yellowstone-skill/` | **no** — it *is* the repo | in-repo by definition |

**Two genuine exceptions, both structural rather than deferred:** a repo cannot carry its own skill as a
subrepo of itself, and a repo with no commits cannot be cloned. Everything else should move.

**And one real gap this exposes:** `install_repo` resolves `<checkout>/<id>`, but herdr keeps its skill
at `skills/<id>`. Either the resolver gains a path suffix or the skill stays a copy — and a copy is what
this directive exists to remove.

## 4. Deliberately excluded, with the cost named

| excluded | why | what it costs |
|---|---|---|
| `Apothic-AI/pi-ghost-text-x` | ships a pi package nothing installs — no lane, no settings entry, no skill | if it is ever used, it needs a subrepo and a manifest row; today it is invisible |
| `bitnom/pi-extensions` (a **third**, different `pi-extensions`) | referenced by no settings entry, no skill, no lane | nothing today; a trap for whoever assumes the name is unique |
| `~/Code` non-fleet projects (hundreds) | not fleet components by the definition in `FT-01-FLEET-MIGRATION.md` | nothing — `~/Code` is your project area and stays populated |
| The 24 fleet checkouts under `~/Code` | they become dormant once lanes run from worktrees | **18 of 25 "free" ones hold branches with no remote counterpart** — deleting them loses work; per-owner disposition, not cleanup |

---

## 5. Decisions requested

1. ~~**`herdr` itself — subrepo 15, or upstream binary?**~~ **DECIDED: subrepo 15, in at `36035d856`.**
2. **The 16 remote npm packages — stay remote, or vendor?** *(recommend: stay remote; we only carry forks)*
3. **Confirm the 14 subrepos in §1 are the intended set**, including the two skills-only ones
   (`fleet-skills`, `mycord`) and `pi-profile-switch` under `pi-extensions/` rather than `apps/`.
4. **Confirm the exclusions in §4**, particularly `pi-ghost-text-x` and the third `pi-extensions`.
5. **`pi-modes-leader`'s checkout holds 54 uncommitted entries** (component `AGENTS.md` and
   `.pi/prompts/*` edits). Commit, discard, or leave the lane's clone in place? This is the only place in
   the migration that can still lose work.
6. **Retirement of the `~/Code` fleet checkouts** — per-owner disposition, and not a completion criterion.
   Nothing requires it; naming it here so it does not read as pending work.

---

## 6. How to re-derive every number in this document

```bash
find src -name .gitrepo | wc -l                        # 14 subrepos
grep -c '\.gitrepo' /dev/null; find src -maxdepth 4 -name AGENTS.md | wc -l   # component docs
git show origin/master:skills/skills.tsv | grep -vcE '^\s*#|^\s*$'            # 26 skill rows
git ls-tree -r --name-only origin/master home/ | wc -l                        # 83 mirror files
./test/run.sh gates                                    # the whole gate set, rc read from the gate
```

Anything in this document that cannot be re-derived by one of those commands should be treated as a
claim rather than a measurement.
