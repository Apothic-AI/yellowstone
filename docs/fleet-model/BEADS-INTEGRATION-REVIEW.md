# Beads integration review — our fleet vs the upstream docs

**Written:** 2026-11-02, from a read-only review. **Acted on nothing.** No config edit, no `bd`
mutation, no mode-file change, no service change, no restart. Every recommendation below is the
operator's to accept or reject.

**Sources.** Upstream docs at `https://beads.gascity.com/` (live, reachable, and the site states
plainly: *"These docs are for the 1.3.2 release of beads"* — the exact version we run). Our tree:
`~/AGENTS.md`, the four space `AGENTS.md` files, all eight mode files, `launch.env`s,
`~/.agents/skills/beads/`, `migration-plan-20261029.md`, `EXECUTION-RECORD.md`,
`HANDOFF-fleet-migration.md`, `pi-fleet-model/README.md`, `continuations/overlord.md`,
the four `tools/` files, the `bin/bd` shim, and the live `.beads` metadata/config.

**What I read in full:** the introduction, IDE setup, `bd prime`, `bd setup`, `bd onboard`, the Dolt
backend page (both halves), the worktrees guide, agent coordination, multi-repo routing,
configuration (all keys and env vars), and the Dolt/doctor/context CLI reference.
**What I read by targeted extraction only:** labels, metadata, events journal, JSON schema,
advanced features, upgrading, FAQ, troubleshooting, installation, community tools, federation,
sync setup, and the Claude Code / Codex integration pages. **What I did not read page-by-page:** the
~150 generated CLI reference pages. For those I used the installed binary's own `--help`, which is
the same generator the docs are built from. Treat any claim below whose only support is an unread
CLI reference page as unverified; I have marked the ones that matter.

---

## 1. What we run today — verified facts

Each line is something I read live, not something I inferred from a record.

| Fact | How verified |
|---|---|
| `bd 1.3.2 (9b65b9e19)` | `bd --version` |
| `dolt 2.6.0` | `dolt version` — this is the version the docs pin, so we are exactly on the supported engine |
| One Dolt server: PID 2046, `--data-dir=/home/bitnom/.local/share/dolt/beads --host 127.0.0.1 --port 3307` | `pgrep -af 'dolt sql-server'` |
| The data dir holds exactly one database directory: `swarm/` | `ls -la ~/.local/share/dolt/beads/` |
| `~/.beads/metadata.json`, `~/.overlord/.beads/metadata.json` and `~/Code/synomone/.beads/metadata.json` are **byte-identical, 217 B each**: `dolt_mode: server`, `dolt_server_host: 127.0.0.1`, `dolt_server_port: 3307`, `dolt_database: swarm`, `project_id: 07b8230e-d7cf-4f22-a338-ef727894a4c1` | `cat` on all three |
| `bd dolt show` → `Database: swarm`, `Host: 127.0.0.1`, `Port: 3307`, `User: root`, `TLS: false`, **`Mode: per-project`**, server connection OK, **remotes: none** | `bd dolt show` |
| `bd where` resolves **per working directory** to that space's own `.beads`: from `~/.overlord` → `~/.overlord/.beads`; from `~/Code/synomone` → `~/Code/synomone/.beads`; from `$HOME` → `~/.beads` | `bd where` run in three cwds |
| **`BEADS_DIR` is not set anywhere.** Not in the environment, not in any `launch.env`, not in any `tools/` script | `env`, `grep` over `.overlord/tools/`, `.overlord/bin/`, `.pi/`, the three `launch.env` files |
| 242 issues | `bd info`; `bd list --all --json` returns all 242 (not clipped by `list.limit: 50`) |
| `bd prime` emits **50,980 characters / 513 lines**, of which **134 persistent memories** are the bulk | `bd prime \| wc -c`, `\| wc -l` |
| All five git hooks missing | `bd hooks list`; `bd info` warns "Git hooks not installed (5 missing)" |
| `bd doctor`: 84 passed, 3 warnings, 0 errors — 1 uncommitted Dolt change (`config: modified`), 1 complete-but-unclosed molecule `swarm-0zr` (`personal-leader — durable work`, 3/3), duplicate Dolt-lock warning | `bd doctor` |
| No Dolt remote, no `.beads/backup/` directory | `bd dolt remote list`; `ls ~/.beads/backup` |
| Effective config: `no-git-ops = true` (from `config.yaml`), `dolt.auto-commit = on (default)`, `issue_prefix = swarm (database)`, `export.auto = false`, `events-journal = false`, `backup.enabled = false`, `metrics.disabled = false` | `bd config show` |
| Anonymous usage metrics **ON**, posting to `https://gastownhall-eventsapi.com/mp/collect` | `bd metrics`; `~/.config/bd/config.yaml` |
| The `bd` on PATH is a **bash shim** at `~/.local/bin/bd` → `~/.overlord/bin/bd`; the real 154 MB ELF is `~/.local/bin/bd-real` (dated 2026-10-29) | `ls -la`, `file`, `cat` of the shim |
| `~/.beads/dolt/` and `~/.overlord/.beads/dolt/` exist but are **empty (0 bytes)** | `ls -la`, `du -sh` |
| `/home/bitnom` is **not** a git repository; `bd context` fails there accordingly | `git rev-parse`, `bd context` |
| bdi's config is one `[[projects]]` block, `name = "swarm"`, `path = "/home/bitnom"`, generated | `~/.config/beady-eye/config.toml` |
| beady-eye is a **documented community tool** ("Live terminal viewer … integrates with herdr … watches several projects at once. Read-only.") | Community Tools page |

### One correction to the brief's own premise

The brief says every workspace is *"reached via `BEADS_DIR=<space>/.beads`"*. That is the design
intent recorded in the migration plan and the mode files, but **it is not what is happening at
runtime**: `BEADS_DIR` is unset everywhere, and the attach works because each space carries its own
`.beads/metadata.json` naming the same `dolt_database` and the same `project_id`. `bd` walks up from
cwd, finds that space's `.beads`, reads its metadata, and connects to the shared server. This matters
for recommendation 9 — the mechanism we actually depend on is the *metadata fields*, and those are
the least-documented part of the whole design.

---

## 2. Recommendations, ranked

Ranking is by (value to this fleet) ÷ (cost + risk of being wrong). "Confidence" is my confidence in
the *factual claim*, not in whether you should do it.

---

### R1 — `bd prime` costs ~13k tokens per lane and the docs give us four knobs to cut it

**(a) What we do now.** `~/.agents/skills/beads/SKILL.md` tells every lane its *first step* is
`bd prime`. Live measurement: **50,980 characters / 513 lines**, dominated by **134 persistent
memories**. At a rough 3.8 chars/token that is ~13,000 tokens, paid by every lane that follows the
skill — and the fleet's own `context-economy` skill exists precisely to stop this.

**(b) What the docs say.** The `bd prime` reference page states the design target explicitly:

> CLI mode: Full command reference (**~1-2k tokens**)

and — this is the part that matches our situation word for word:

> Large memory sets can exceed what a session-start hook host will ingest, and hosts truncate
> silently. Cap what prime injects with `--max-memories N` and/or `--max-memory-chars N` (or the
> `prime.max-memories` / `prime.max-memory-chars` config keys; an explicit flag wins, and an explicit
> `0` forces unlimited). Caps apply at whole-memory boundaries … and a banner ahead of the entries
> reports how many were elided and how to browse the rest with `bd memories`.

There are four documented levers plus a template override:
`--max-memories` / `--max-memory-chars` (flags), `prime.max-memories` / `prime.max-memory-chars`
(config keys, env `BD_PRIME_MAX_MEMORIES` / `BD_PRIME_MAX_MEMORY_CHARS`), `--memories-only`,
`--no-memories`, `memories.budget-chars` (a corpus-wide ceiling that makes `bd remember` *refuse* a
write that would cross it), and `.beads/PRIME.md` to replace the workflow text wholesale
(`--export` dumps the default for editing).
Sources: https://beads.gascity.com/cli-reference/prime.md,
https://beads.gascity.com/reference/configuration.md

**(c) The concrete change.** Set `prime.max-memories` to something like 20–30, and/or
`memories.budget-chars`. Then have lanes use `bd memories <keyword>` for lookup instead of relying on
everything being injected. If you want a real budget, `memories.budget-chars` is the only one that
prevents growth rather than hiding it.

**(d) Cost/risk.** Low cost, low risk, immediately reversible. The real risk is *behavioural*: the
caps elide memories, and some are operational traps (`w1E-rfc8032-key-trap`, `w0-signal-cli-hang`,
`no-bd-setup`) that currently arrive unasked. Eliding the wrong one trades tokens for a mistake. The
elision banner names how to browse the rest, which softens it. Also note `bd prime` is not in our
launch path — no hook runs it — so the saving only lands on lanes that follow the skill.

**(e) Confidence.** **High** on the measurement and on the documented knobs (I read the page and
reproduced the size). **Medium** on the right cap value — 134 is far past the point where a blanket
injection helps, but I did not measure which memories any lane actually needed.

---

### R2 — The docs have a first-class construct for "one server, many workspaces", and it is not what we built

This is the answer to the brief's questions 1 and 2, and it is the most consequential finding.

**(a) What we do now.** One `dolt sql-server` on 3307, **one database** (`swarm`), **one
`project_id`** for all 20 spaces. Per-space ownership is expressed *only* by convention: one epic per
space, titled `<Space> — durable work`, plus a `project:<w-id>` label on every bead. There is no
server-side namespace, no role, no grant, no branch. `bd list` from anywhere returns all 242 beads,
and `bd dolt show` labels our mode **`per-project`** — a word the docs use for something else
entirely (below).

**(b) What the docs say.** They describe two distinct shapes, and ours is a third:

1. **Shared *server*, isolated *databases*** — the supported multi-workspace construct:

   > Shared server mode runs a single Dolt server at `~/.beads/shared-server/` that serves all
   > projects … **Automatic database isolation (each project uses its own database name)** … Each
   > project's database is stored as a subdirectory (e.g., `~/.beads/shared-server/dolt/myproject/`)
   > … Default port is 3308 (not 3307) to avoid conflict with the orchestrator.

   Enabled by `bd init --prefix myproject --shared-server`, `dolt.shared-server: true`, or
   `BEADS_DOLT_SHARED_SERVER=1`. The docs are emphatic about the collision rule: *"Each project on a
   shared server must have a unique prefix (database name). Two projects with the same prefix share
   the same database — if this happens accidentally, the project identity check will detect the
   mismatch and refuse to connect, preventing silent data corruption."* There is also a
   machine-level `beads_global` database that `bd init` will create on a shared server.

2. **`BEADS_DIR` as an external shared workspace** — documented, but for a different purpose:

   > If you want a separate issue-tracker repository shared by many code worktrees, point `BEADS_DIR`
   > at that workspace … With an external `BEADS_DIR`, `bd dolt push` and `bd dolt pull` target the
   > external beads workspace, not the code repository.

   That is *one workspace, many worktrees* — the single-project shape. It is not "many independent
   projects, one database."

3. **What we built:** one database shared by many projects, discriminated by a label and an epic.
   I could not find this shape anywhere on the site. The configuration reference documents
   `dolt.shared-server` as the way to *"Share one Dolt server"*, and every isolation guarantee it
   offers comes from **separate databases**, which we deliberately do not have.

Sources: https://beads.gascity.com/architecture/dolt.md (Shared Server Mode, Configuration Reference),
https://beads.gascity.com/reference/worktrees.md (External Beads Workspace),
https://beads.gascity.com/reference/configuration.md (`dolt.shared-server`),
https://beads.gascity.com/reference/faq.md ("Can I track issues for multiple projects?" — *"each
project is completely isolated"*).

**(c) The concrete change.** My recommendation is **hold the current design, and know what you are
holding.** One database is a legitimate engineering choice for this fleet and the docs do not forbid
it — but it is a *documented-gap* design, so three things follow:

1. **Record the deviation as a deliberate decision, with its cost named.** D1 already does this for
   the choice; it does not record that the choice is unsupported, i.e. that *nothing upstream will
   tell us if we get it wrong*. The failure it enables is the one the docs warn about: two workspaces
   that accidentally share an identity are silently one project, and the "project identity check"
   that would have caught it exists only in shared-server mode.
2. **If isolation ever does matter, the documented upgrade path is `dolt.shared-server` with a unique
   prefix per space** — a different database per space on the *same* server, which preserves
   "one server, one machine" while giving real isolation. Note what you would lose: the single
   `bd ready` portfolio query that motivated D1 in the first place — you would need `bd repo add` +
   `bd repo sync` hydration (or our `beads-board.py` looping `bd -C`) to get the fleet view back.
   That is the honest trade, and it is why I am not recommending the switch.
3. **If you keep one database, prefer the label to a name.** Our `project:<w-id>` label is already
   the idiomatic spelling — the Labels page documents namespaced `dimension:value` labels and a Team/Ownership category. That part is right.

**(d) Cost/risk.** Doing nothing costs nothing today. The risk of *switching* is the exact thing D1
was protecting: 20 spaces, 242 beads, and every cross-space dependency and `bd ready` query would need rework, on a live graph the fleet is mid-flight on.

**(e) Confidence.** **High** that the docs' multi-workspace construct is per-database on a shared
server at port 3308, and that our single-database model is not documented (I read the Dolt page's
Shared Server Mode section, the worktrees page, the configuration table, and the FAQ entry).
**Medium** on how much we should care: `bd dolt show` reporting `Mode: per-project` suggests the binary itself tolerates our shape without complaint, and 242 beads are working.

---

### R3 — We have no backup and no remote for the fleet's only durable record

**(a) What we do now.** `bd dolt remote list` → "No remotes configured." No `~/.beads/backup/`
directory. `backup.enabled = false`. One Dolt data directory on one disk
(`~/.local/share/dolt/beads`), holding the fleet's entire task graph: 242 beads, every space epic,
every close reason that carries the fleet's evidence.

**(b) What the docs say.** `bd backup` is a first-class Dolt-native backup (`bd backup init <path>`,
`bd backup sync`, `bd backup restore`, `bd backup status`), explicitly distinct from `bd export`:

> `bd export` is not a substitute for this flow. JSONL exports contain issue records from the issues
> table for migration and interoperability; they do not capture Dolt branches, full commit history,
> working-set state, or non-issue tables. Use `bd backup` or a manual Dolt backup when you need a
> restorable database backup.

There is also periodic auto-backup (`backup.enabled`, `backup.interval` default 15m,
`backup.size-cap-mb` default 2048) and `dolt.local-only` to explicitly declare "no network sync on
purpose" rather than leaving it ambiguous.
Source: https://beads.gascity.com/architecture/dolt.md (Migrating Between Backends, Backup Commands
Reference, Configuration Reference)

**(c) The concrete change.** Register a backup destination (`bd backup init ~/some/dir`, then
`bd backup sync`), and consider a Dolt remote — the docs recommend `bd dolt remote add` over raw
`dolt remote add`, because remotes added with the `dolt` CLI may not be visible to the running server
until restart.

**(d) Cost/risk.** Low risk, small disk cost (~a few dozen MB for 242 beads' history). The one real
consideration: the machine is at 100% disk per a stored memory (`build-remote`), so pick a
destination with room — I did not re-measure free space, and the brief forbids acting, so treat the
"where" as an open question. Do **not** point a backup at the machine only; an off-disk destination is
the point.

**(e) Confidence.** **High** on the absence (two independent reads: `bd dolt remote list` and the
missing backup dir) and on the documented remedy. **Medium** on urgency — nothing is currently
failing, but `bd doctor` already flags an uncommitted working-set change, which is exactly the state
that makes a restore non-trivial.

---

### R4 — The `bd` shim lives at the stock path, so the documented upgrade paths will silently disable the join

This is the brief's question 5, and it is the sharpest operational risk in the review.

**(a) What we do now.** `~/.local/bin/bd` is a **symlink** to a bash shim at `~/.overlord/bin/bd`.
The real 154 MB binary was renamed to `~/.local/bin/bd-real`, and the shim hardcodes
`REAL_BD=/home/bitnom/.local/bin/bd-real`. The shim intercepts `update`/`close`, writes
`agent_pane` + `agent_session` on a claim and clears them on a stop, and passes every other verb
through. Its own header says the placement is deliberate: `bash -c` reads no rc file, so a shell
function could not do this job.

**(b) What the docs say.** Every documented install path writes a binary named `bd` to a standard bin
directory: `brew install beads` / `brew upgrade beads`, `npm i -g @beads/bd` / `npm update -g`,
`curl … install.sh | bash`, or `CGO_ENABLED=… go install …/cmd/bd@latest` (which lands in `$GOBIN`,
and on this machine `~/.local/share/mise/installs/go/1.27.1/bin`). The installation page also
documents `sudo mv bd /usr/local/bin/` as a normal step. None of these know about a symlink at
`~/.local/bin/bd`, and none preserve a renamed `bd-real`. There is no documented hook, plugin point
or wrapper mechanism for `bd` — the extension surface the docs do offer is `bd setup --add` (agent
instruction files) and the `bd serve` HTTP API, neither of which intercepts a CLI claim.
Sources: https://beads.gascity.com/getting-started/installation.md,
https://beads.gascity.com/getting-started/upgrading.md,
https://beads.gascity.com/cli-reference/setup.md

**(c) The concrete change.** Whichever of these you prefer:

- **Make the failure loud rather than silent.** The current failure mode is the bad one: an upgrade
  overwrites `~/.local/bin/bd`, `bd` *keeps working*, and only the join silently stops — which
  surfaces later as bdi `orphan-claim` anomalies, exactly the class the reconciler exists to clean up.
  A post-upgrade assertion (does `bd` on PATH resolve to the shim?) turns a silent degradation into a
  visible error.
- **Or move the risk off the stock path**: give the shim a distinct name (`bd-claim`), put it earlier
  on `PATH` than the real binary, and have the skill/shim story point at that name — leaving `bd`
  itself untouched and upgradeable.
- **Or drop the shim** and let `bdi-reconcile.py` (which already handles the same writes, idempotently,
  on a 25s timer) be the only writer, accepting a join gap of up to one timer period. This is the
  smallest-surface option and it is *already documented as the mechanism* in the skill.

**(d) Cost/risk.** The first option is cheap and additive. The second is a small, mechanical change to
one skill line and one symlink. The third removes a moving part but re-introduces the gap the shim was
written to close. Also note: the shim's real value is not the metadata write — it is that it writes at
*the moment of the claim*, which is a genuine improvement over a poll.

**(e) Confidence.** **High** that the shim is at a stock path and that no documented mechanism protects
it, and **high** that this is a real upgrade hazard. **Medium** on *which* installer would be used
here — I did not determine whether this machine has Homebrew, and I could not check the historical
install method without acting. `bd upgrade` is a *review* command (`status` / `review` / `ack`), not a
self-replacing updater, so it is not itself the hazard. Treat "an upgrade silently breaks the join" as
the claim to verify before any upgrade, not as a certainty about how the upgrade will be performed.

---

### R5 — We run 1.3.2, and the docs are the 1.3.2 docs — but one migration step may never have been run

This answers the brief's question 4. The headline is good news, so keep it short.

**(a) What we do now.** `bd 1.3.2 (9b65b9e19)`, `dolt 2.6.0`. No upgrade needed, none proposed.

**(b) What the docs say.** The site is versioned to 1.3.2 — *"These docs are for the 1.3.2 release of
beads"* — so the docs describe exactly what we run; there is no feature gap to report and no changed
behaviour to reconcile. Two version-adjacent items do apply:

- **`bd recompute-blocked`, once per workspace, after upgrading from 1.3.0 or earlier.** Our
  `migration-plan-20261029.md` records spaces being attached on 2026-10-29 with a 1.3.2 binary; I
  found no record that this command was run. If blocked-state flags were computed under 1.3.0 they can
  be stale, and stale `is_blocked` silently hides work from `bd ready` — the one query the whole
  fleet design rests on.
- `bd upgrade review` exists to show what changed since the last version, and version tracking is
  automatic (`bd` updates `metadata.json` on every run).
Sources: https://beads.gascity.com/index.md, https://beads.gascity.com/getting-started/upgrading.md

**(c) The concrete change.** Verify blocked-state freshness once
(`bd blocked` vs `bd list --status=blocked`), and run `bd recompute-blocked` in each space if they
disagree. This is a one-time, idempotent repair. I deliberately did **not** run it — it is a write.

**(d) Cost/risk.** Minimal. It rewrites a derived flag, not user data. The only risk is doing it
during a concurrent write, which the docs' own maintenance gate is designed to handle.

**(e) Confidence.** **High** that we are on 1.3.2 and the docs match. **Low** on whether
`recompute-blocked` is actually needed here — it is a *may*, contingent on whether 1.3.0 ever touched
the database. Cheap enough to check rather than reason about.

---

### R6 — `bd setup` has no recipe for `pi`, so our hand-written integration is necessitated — but we leave three documented mechanisms unused

**(a) What we do now.** Beads instructions reach lanes through `~/AGENTS.md`, four space
`AGENTS.md` files, eight mode files, and `~/.agents/skills/beads/SKILL.md` — all hand-written and
hand-maintained. No `bd setup` recipe runs. `~/Code/synomone/AGENTS.md` *does* carry a
`<!-- BEGIN BEADS CODEX SETUP … -->` block from a past `bd setup codex` run.

**(b) What the docs say.** `bd setup` covers claude, cursor, gemini, copilot, codex, factory, mux,
opencode, aider, junie, windsurf, cody, kilocode, kiro — **`pi` is not among them**, so the absence of
a recipe is not our mistake. The docs do offer three things we do not use:

- **`bd setup --add <name> <path>`** — a *custom recipe*, stored in `.beads/recipes.toml`, with
  `--check` to report `missing` / `stale` / `current`. This is the documented way to bring an
  unlisted agent into the managed-section model.
- **Managed sections with `BEGIN/END … hash:…` markers**, so a re-install is idempotent and `--check`
  can tell you the prose is stale. Our hand-written text has no such marker, which is why "is this
  AGENTS.md section current?" is unanswerable today.
- **`bd onboard`** — "Display minimal snippet for agent instructions file" — and
  **`bd prime --hook-json`**, the SessionStart envelope. We use neither; our lanes are told to run
  `bd prime` by hand.
- **`.beads/PRIME.md`** to override `bd prime`'s workflow text per workspace (`bd prime --export`
  gives you the default to start from). This is the documented way to give a workspace custom
  workflow prose without editing a skill.

Also relevant to us: the docs note that `bd init` runs the project Claude Code, Codex and Cursor setup
automatically unless `--skip-agents` is passed, and that *"In worktree, shared, or `BEADS_DIR`
setups, use `bd where` to confirm the resolved workspace — these integrations do not require a local
`./.beads`."*
Sources: https://beads.gascity.com/getting-started/ide-setup.md,
https://beads.gascity.com/cli-reference/setup.md, https://beads.gascity.com/cli-reference/onboard.md,
https://beads.gascity.com/cli-reference/prime.md

**(c) The concrete change.** Optional, and lower value than R1–R4. If you want it: `bd setup --add pi
AGENTS.md` (or `-o` to a path), then wrap the beads section of each space's `AGENTS.md` in the managed
markers so `--check` works. Consider `.beads/PRIME.md` for anything workspace-specific that currently
lives in a mode file.

**(d) Cost/risk.** The docs warn that recipes are not always composable — `bd setup codex` uses its own
marker pair (`BEGIN/END BEADS CODEX SETUP`) and running it alongside `factory`/`mux` "leaves two
managed sections side by side"; each `--check` inspects only its own. Our synomone `AGENTS.md` already
shows one such block. Adding a second managed section to files that also carry hand-authored prose is
how you get the duplicates the fleet's own memory (`no-bd-setup`) warns about. And because `bd setup`
rewrites `AGENTS.md`, it *is* a source-of-truth edit — which is why this is a recommendation and not
something I touched.

**(e) Confidence.** **High** that `pi` has no recipe and that `--add` / managed markers / `onboard` /
`PRIME.md` exist as described. **Low** that adopting them is worth it: our mode-file composition model
is more capable than a flat `AGENTS.md` section, and the docs' model has no equivalent of
leader-vs-worker prompts.

---

### R7 — The events journal is the documented way to follow mutations; our tools poll instead

**(a) What we do now.** `bdi-reconcile.py` runs every 25 s: it calls `bd list --all --json
--has-metadata-key agent_pane`, then does one `bd show <id> --json` **per joined bead** to read the
metadata the list view omits. That is an N+1 query pattern against a live shared database, every 25 s,
forever. `beads-board.py` does one `bd list --all --json` per invocation (fine — I confirmed it gets
all 242).

**(b) What the docs say.** There is a purpose-built mechanism:

> **Events journal** — One workspace-wide, sequence-ordered stream of committed mutations, replayable
> from a checkpoint. For: a machine is keeping its own copy of the graph in step.

With `events-journal: true` (or `BD_EVENTS_JOURNAL=1`), `bd events tail --since 0`,
`bd events tail --since 4211 --follow` ("polls once a second"), `--limit`, `--exit-on-stdin-eof`, plus
`events-journal-retain-days` (7) / `events-journal-retain-rows` (100000) and auto-prune. The docs also
name the anti-pattern I think our reconciler is in: *"Polling `bd list` for that means diffing whole
snapshots."*
Sources: https://beads.gascity.com/reference/events-journal.md,
https://beads.gascity.com/cli-reference/events.md

**(c) The concrete change.** Enable the journal and have the reconciler consume
`bd events tail --since <checkpoint> --follow` instead of re-reading the whole joined set. This does
**not** remove the need to poll herdr for pane liveness — the journal only covers bead mutations, and
the reconciler's actual job is reconciling two sources, one of which is herdr. So the honest framing:
it would replace *one half* of the reconciler's work with a cheap stream.

**(d) Cost/risk.** Real risk: `events-journal` is currently `false`, and enabling it starts writing a
new durable stream into the database — a schema-level change to turn on casually, and one that will
need pruning discipline (the defaults already handle 7 days / 100k rows). Also, changing the
reconciler's input means re-proving the join logic, which today is verified (the migration plan and
`EXECUTION-RECORD.md` §23 record real proof: planted `agent_pane=wZZ:p9` cleared by the timer). I would
not rewrite a proven reconciler for a perf win on a 242-bead database.

**(e) Confidence.** **High** that the journal exists, is documented as the right mechanism for this
job, and is currently off. **Low-medium** that it is worth changing now — this is a scaling
optimisation on a dataset that is not currently straining, and the N+1 is bounded by the number of
beads carrying a join, which is small. Filed as "know it exists", not "do it".

---

### R8 — Our own additions, assessed against idiomatic use (question 5, item by item)

A short verdict per tool, since the brief asks for each explicitly.

| Tool | Verdict |
|---|---|
| `bin/bd` shim | **Not reinventing anything** — no documented claim-intercept hook exists, and the docs' extension points (`bd setup` templates, `bd serve`, metadata) do not cover it. **Genuinely at risk** from upgrades (R4). Its metadata keys are non-standard but idiomatic in *kind*: the Metadata page calls metadata "the extension point for integrations and execution hints" and gives `execution_agent_type`, `execution_suggested_model` as precedents, noting "Parent/orchestrator agents must consume these keys before spawning subagents." |
| `tools/bdi-reconcile.py` (25 s timer) | **Half reinventing**: the journal (R7) is the documented way to follow mutations. The other half — reconciling against *herdr pane liveness* — has no documented equivalent, because the docs' coordination model is `bd assign` / `bd update --claim` with assignees as "plain strings" and no agent registry ("Beads has no agent registry — assignees are plain strings"). So the *concept* is ours by necessity; the *transport* could be documented. |
| `tools/beads-board.py` | **Not reinventing** — the docs have no cross-project portfolio view because their model is one database per project, which is exactly the view D1 traded away. Grouping by a namespaced `project:` label is documented-idiomatic (Labels page, Team/Ownership). Read-only, one query. Keep. |
| `tools/beady-eye-config` | **Not ours to judge against beads docs** — it generates *beady-eye's* config schema, and beady-eye is a listed community tool. The one thing to note: its "one `[[projects]]` block per tracker, never per checkout" rule is a consequence of our one-database design, not of anything upstream. If R2 ever flips to shared-server, this generator inverts. Also, `bd dolt show` reports `Mode: per-project` and `bdi` partitions by *configured* project — two different notions of "project" in the same fleet. That naming collision is worth a line in the record. |

---

### R9 — `project_id` is undocumented, and our whole isolation model rests on it

**(a) What we do now.** All 20 spaces carry the same `project_id:
07b8230e-d7cf-4f22-a338-ef727894a4c1` in their `metadata.json`. This is the fingerprint that makes
them one project. It is set in a 217-byte file, in three spaces I read, byte-identically.

**(b) What the docs say.** Searching every page I fetched — the whole configuration reference, the
Dolt page, the worktrees page, the sync setup page, the JSON schema page — `project_id` appears
**zero times**. `dolt_database` appears once, in the sync-setup guide, as "your `<dbname>` (typically
the repo name)". `metadata.json` is discussed only in troubleshooting, as a place to look
(`cat .beads/metadata.json | grep -E "dolt_mode|dolt_server_port"`).

So: the field we depend on most is the field with the least documented contract. The binary reads it
— `bd config show` lists `project_id = 07b8230e-… (metadata)` alongside `dolt_database`, `dolt_mode`,
`dolt_server_host`, `dolt_server_port`, citing `metadata` as the source — so the behaviour is real;
it is the *stability guarantee* that is missing.

**(c) The concrete change.** Two cheap guards: (1) keep a copy of a known-good `metadata.json` in
`pi-fleet-model/` so a divergence is diffable rather than remembered; (2) after any upgrade or any
migration, re-verify identity with `bd dolt show` (which reports `Database: swarm`) and a
`metadata.json` comparison across spaces — a one-line loop. Optionally add to the fleet's own
verification list: *"all `/home/bitnom/**/.beads/metadata.json` carry the same `dolt_database` and
`project_id`."*

**(d) Cost/risk.** Negligible; it is a read.

**(e) Confidence.** **High** that `project_id` is undocumented (I grepped every downloaded page, and
zero hits is a strong signal). **Caveat on scope:** I did not fetch all ~150 CLI reference pages, so I
cannot claim it appears nowhere on the site — only that it appears nowhere in the conceptual and
reference pages, which is where a contract would live.

---

### R10 — Small hygiene: the deprecated port key, shadow `.beads/dolt` dirs, and a stale molecule

Three low-value items. Listed so they are not rediscovered.

**(a)/(b) facts.**

- `metadata.json` carries `dolt_server_port: 3307`, which `bd dolt show` itself labels **"(deprecated
  fallback)"**, ranked *fifth* in port precedence — behind the env var, `.beads/dolt-server.port`
  (present, contains `3307`), the server's own `config.yaml`, and `bd`'s config. So the key is
  redundant. **But do not remove it casually:** the docs state that an explicit `dolt_server_port`
  is one of the things that makes bd treat the server as **externally managed** and *disable
  auto-start*. Removing it "to clean up" would let bd try to start its own server over `.beads/dolt`
  — the shadow-database failure the troubleshooting page documents at length. **Recommendation:
  leave it, and write down why.** This is the rare case where the deprecated key is doing real work.
- `~/.beads/dolt/` and `~/.overlord/.beads/dolt/` exist and are **empty**. The troubleshooting page
  warns: *"If a stale `.beads/dolt/` directory exists alongside an external-server configuration, it
  can shadow the real database — confirm your real data lives on the server before removing the stale
  directory."* Ours are 0 bytes, so benign — but they are the documented shadow shape, and an empty
  directory is one `bd` mistake away from becoming a real one.
- `bd doctor` flags one complete-but-unclosed molecule, `swarm-0zr` (`personal-leader — durable work`,
  3/3), and one uncommitted working-set change (`config: modified`). `bd mol stale` is the documented
  review step; `bd vc commit` the documented fix.
- `~/.beads/config.yaml` is 17 bytes (`no-git-ops: true`); `~/.overlord/.beads/config.yaml` is the
  full 2,872-byte commented default. Harmless inconsistency, but it means "what is configured?" has a
  different answer per space.
Sources: https://beads.gascity.com/reference/troubleshooting.md,
https://beads.gascity.com/reference/configuration.md, https://beads.gascity.com/cli-reference/dolt.md

**(c) Change.** Commit the pending working-set change and close the stale molecule when convenient;
leave the port key; leave the empty dirs but note them.

**(d) Cost/risk.** Trivial. **Do not** "clean up" the port key — see above.

**(e) Confidence.** **High** on all of it, since each is a direct read.

---

### R11 — Things the docs say we are doing **right** (recorded so nobody "fixes" them)

The brief asks what we get wrong. This is the other half, and it is short because most of the
integration is sound.

- **`no-git-ops: true` is a real, documented key**, not a stray — "Disable git ops in `bd prime` close
  protocol. Does not affect Dolt remote sync or auto-push; set `dolt.local-only` to stop those." Our
  use is correct and our reasoning (we do not want bd committing for us) matches the docs'.
- **`project:<w-id>` labels** are the documented namespaced-label idiom.
- **`agent_pane` / `agent_session` metadata** is the documented extension point used as intended.
- **`bd update <id> --claim`** is the documented atomic claim; `--claim` is idempotent by design, which
  is why the shim re-claiming is safe.
- **One epic per space, closed beads carrying evidence in the close reason** — not a beads rule, but a
  sound convention, and `bd close --reason` is the documented field for it.
- **Not using `bd setup`** was the right call for *this* fleet, even though it looks like a gap: the
  docs' managed-section model has no leader/worker split, and our mode files do.
- **We are on the exact documented version** (1.3.2) and the exact pinned Dolt (2.6.0). Many of the
  upgrade/compat warnings on the site simply do not apply to us.

---

## 3. Explicitly not verified / open questions

Stated plainly rather than papered over:

1. **`project_id` in CLI reference pages.** I grepped every page I downloaded (zero hits) but did not
   fetch all ~150 generated CLI pages. "Undocumented" here means "absent from the conceptual and
   reference docs", not "absent from the site".
2. **Which installer would upgrade `bd` here.** R4's hazard is certain in mechanism; the specific
   installer is not. I did not check for Homebrew, and the historical install method is not recorded
   in the files I was given.
3. **Whether `bd recompute-blocked` was run** during the 2026-10-29 migration. No record either way;
   the recommendation is to check rather than to assume.
4. **Free disk space.** A stored memory says the machine was at 100% on `/home`. That bears directly
   on R3's backup destination and I did not re-measure it (the brief's read-only spirit, plus
   `df` is not in the allowed inspection list).
5. **Whether the auto-commit default is actually different in server mode.** The configuration
   reference says auto-commit defaults **off** in server mode ("Firing `DOLT_COMMIT` after every
   write under concurrent load causes 'database is read only' errors"), but our `bd config show`
   reports `dolt.auto-commit = on (default)`. Either `config show` prints the key's global default
   without applying the mode adjustment, or our server-mode default is not what the docs describe.
   **This is worth checking before anyone relies on it** — 20 lanes writing to one database is exactly
   the concurrent load the docs warn about. I could not resolve it read-only; I did not want to
   assert either way.
6. **The `[[projects]]` / `Mode: per-project` naming collision** (bdi's notion of project vs `bd`'s
   `bd dolt show` mode string). I noted it in R8; I do not know whether `bd`'s string is derived from
   `metadata.json` or from `dolt_mode`.

## 4. Is anything urgent?

Two things, and neither is urgent enough to justify acting without you:

- **R3 (no backup)** is the one I would fix first, because it is the only finding whose downside is
  irreversible data loss rather than wasted tokens or a stale join. It is not burning today; it is
  the absence of a safety net on the fleet's single durable record.
- **R4 (the shim at the stock path)** is the one most likely to bite silently. It will not bite until
  the next upgrade — which is why R5's "we are on the documented version, no upgrade pending" is
  genuinely good news: you have time to place the guard.

Everything else can wait for your review.

---

*Read-only throughout. No config edited, no `bd` write issued, no mode file or service touched, no
`bd init`, `bd setup`, `bd remember`, `bd dolt` write, or `bd create/update/close/delete/comment` run.
The only file I wrote is this one.*

*Two side effects I did not author, recorded so the mtimes do not look like edits on review:*

- *`bd`'s own read path updated `~/.beads/last-touched` (now `swarm-l7o`). That is bd's bookkeeping on
the permitted inspection commands, not a mutation I issued.*
- *`EXECUTION-RECORD.md` and `Documents/Fleet/AGENTS.md` in my read set were modified at 10:21 by a
live lane in this fleet (the rooms registry shows `self-improvement-leader` active), not by this
job. If their content differs from what I quoted, re-read them; my claims about them are drawn from
the copies I read.*