# Why the setup looks like this

Most of the shape here is forced by one of four constraints. Knowing which
constraint applies keeps you from "fixing" something that is load-bearing.

## 1. Two harnesses, one set of skills

herdr has a skill file. pi has a skill system. Both read `~/.agents/skills`.

That is why skills are symlinked from this repo rather than copied into each
tool: one `git pull` updates every agent on the machine, and an agent that
reads the skills sees exactly what the repo says. It is also why the installer
is careful about replacing a real directory at that path — that directory might
be a checkout of someone else's skill, and moving it without asking would be
destroying another project's work.

## 2. One owner per tool name in pi

pi allows exactly one extension to own a given tool name, and the check runs
after every extension has loaded — so the loser fails as a whole, and a
`try`/`catch` around `pi.registerTool` cannot recover it.

This single rule is responsible for our `pi-pretty-tui` fork. `bizzy` owns
`bash` so it can background long commands; pretty-tui used to register `bash`
to render it. Neither extension is wrong; they just cannot both claim the name.
Our fork uses `pi.registerToolRenderer`, which composes instead of competing, so
rendering and behaviour are decoupled.

**Consequence for you:** any extension that registers a tool pretty-tui
renders is a potential conflict. If a future install fails with "tool X
conflicts with Y", the fix is usually to find the renderer registration, not to
disable the other extension.

## 3. Credentials are commands, not values

pi resolves `apiKey` as a literal, an environment interpolation, or a command
prefixed with `!`. Yellowstone always uses the command form:

```json
"apiKey": "!cat ${HOME}/.pi/agent/secrets/relayfast"
```

Three things follow, and all three are deliberate:

- The committed `models.json` is portable and contains no secrets, so it can be
  reviewed in a pull request and copied between machines.
- Rotating a key is a file write, with no config edit and no restart.
- `${HOME}` is expanded by the shell pi runs the command through, so the file
  does not hard-code a username.

The cost is that a missing key is a runtime failure rather than an install
failure. `scripts/doctor.sh` closes that gap by checking each referenced file for
non-empty content and then calling `pi auth check` on the default provider.

## 4. State you cannot reconstruct stays out of the repo

Some files describe a machine rather than a configuration:

| File | Why it is not committed |
|---|---|
| `~/.pi/agent/auth.json` | OAuth credentials |
| `~/.pi/agent/sessions/` | conversations |
| `~/.config/herdr/session.json` | live pane layout |
| `~/.pi/agent/secrets/` | the operator's provider keys, one file each |
| `~/.pi-profile-switch/instances/<id>/` | the generated profile instance tree (auth, sessions, npm, modes) |

Three files are a mix, and the mix is what the installer encodes: a *default*
that a fresh machine needs is committed under `home/`, and the live file is
installed only when absent, so the choice a human made by using the tool is
never overwritten. That is `~/.pi/agent/model-picker.json` (MRU order),
`~/.pi/agent/web-search.json` (browser profile) and `~/.pi/agent/pi-persist.json`
(the trailing reminders a person wrote). `docs/trust.example.json` is documented
rather than installed, because blanket project trust is a judgement about whose
code you run.

## 5. Components are subrepos, not copies

Every fork and owned repository this setup depends on lives under `src/` as a
**git subrepo**, not a submodule, not a vendored copy, and not a second checkout
that happens to be next to this one.

| | Why not the alternative |
|---|---|
| Not a submodule | a submodule is a pointer in `.gitmodules` plus a nested `.git`; a fresh clone has empty directories until someone runs `--recursive`, and half the fleet has run instead of read that |
| Not a vendored copy | a copy has no version `pi list` can report and nobody rebases it; the delta becomes invisible, then stale, then wrong |
| Not a sibling checkout | that is what this replaced: twelve directories under `~/Code` and `tooling/`, each with its own branch conventions, discoverable only by remembering |

A subrepo keeps the component's files **in this repository's history**. A clone
is complete — no recursion, no subcommand to remember — and `git subrepo pull`
lands one ordinary commit that reviews and reverts like any other. The `.gitrepo`
file inside each directory records remote, branch, commit and pull parent; that
file is the record, and hand-editing it is how a pull later fails in a way that
looks like a corrupted checkout.

### Pin the branch the install resolves to

Clone from the **remote at a named ref**, never from the local checkout. Two
reasons, both measured rather than argued:

- a local checkout carries per-lane scaffolding — `.pi/`, a rewritten `AGENTS.md`,
  a launch file — that must never enter this repo, and in a jj workspace it sits
  at a detached `HEAD` with no branch name to read;
- the branch an install *resolves to* is not always the merge branch. `pi-pretty-tui`
  installs from `test/composer-selection-on-apothic`, not `apothic`, and pinning
  the tidier-looking `apothic` would reproduce a machine nobody runs.

So the rule is: read `pi list` (or the plugin install record), pin what it names,
and only then ask whether that branch should be the merge branch too.

### Membership is "does anything resolve against it"

Not "is it a pi package". `mycord` installs nothing as a package and appears in
no manifest, but it owns nine skills the fleet links — so a conversion without it
leaves those skills with no checkout to resolve against. Conversely, a pinned
upstream herdr plugin is *not* a subrepo: a pinned ref is already a complete
record of something we do not patch, and a subrepo of an unmodified upstream is a
clone with no delta to review.

`src/libs` is empty and stays empty. The layout names four categories; inventing
a member so the outline looks balanced would be the same mistake as bundling a
skill that has an installable home.

### The gate

A subrepo tree is only converted if it reproduces from its own history and the
remotes. `test/verify-subrepo-roundtrip.sh` clones this repo into a throwaway
directory and asserts, for every `src/**/.gitrepo`, that `git subrepo status`
resolves, that the pulled commit and branch equal the recorded ones, that the
directory has content, and that `git subrepo pull` is a no-op — plus a hard
count, so a subrepo deleted to make the rest pass fails instead of shrinking the
gate. It runs on the host, needs network, and refuses a dirty tree: it clones
what is committed, and a gate that can be run over uncommitted work is not
describing what ships.

## Design decisions worth knowing

### `home/` is a literal mirror, so the destination of a file is a path

Every file the installer puts in `$HOME` lives at the same path underneath
`home/`. `home/.pi/agent/settings.json` is installed to `~/.pi/agent/settings.json`
because of its name, not because a table beside it says so.

The rule is what makes the layout mechanical: `home/` contains exactly the files
`install.sh` writes, and nothing else. A file the installer does not write has no
home under `home/`; a file it writes must have exactly one. That is why
`home/.pi/agent/` ships `settings.json` but not `auth.json`, `sessions/` or the
profile instance tree — those are machine state, not shipped content — and why
`skills/skills.tsv` and the installer's own `scripts/`, `docs/` and `test/` stay at
the top level. They are bookkeeping and tooling, not installed content.

Three things follow, and they are the reason the layout is worth the move:

1. **A new file needs no new code.** Drop it under `home/.pi/agent/` and
   `./install.sh pi` installs it, because the stage installs a subtree rather
   than a hand-maintained list.
2. **The destination is overridable where it must be.** The four roots
   (`~/.config/herdr`, `~/.pi/agent`, `~/.agents/skills`, `~/.local/bin`) plus
   `~/AGENTS.md`, `~/.overlord` and `~/.sysops` keep their environment variables,
   which is how the test suite installs into a throwaway `HOME`. The path
   *below* a root is never remapped.
3. **The mirror is checkable.** `scripts/doctor.sh` compares every mirrored file
   with its destination and names the path that differs, and `test/run-tests.sh`
   fails if a file has no destination or a documented destination has no file.

Not every row is a copy, and flattening them would be a data-loss bug. A file's
`home_policy` in `scripts/lib.sh` is one of: `copy` (the default), `copy-exec`,
`merge-settings` (owned keys and a package union), `merge-models` (providers are
added, never replaced), `keep` (install only when absent — the MRU list, the
search profile, the trailing reminders, the overlord index), `template`
(install once, then report drift and never replace) or `skill` (linked by
`scripts/skills-sync.sh`, so the manifest stays the single membership test).

### A name is not a property — test the thing itself

Three checks in this repo were green while the thing they named was false, and
all three failed the same way:

| Reported | Actually asked | What it should ask |
|---|---|---|
| `pi list` shows a package | is this source string in `settings.json`? | does the path exist on disk? |
| `grep` finds no `~/Code` paths | does the text contain that substring? | do the **resolved** paths leave the checkout? |
| a skill is `linked` | is this a symlink? | does its target still resolve? |
| no entry leaves `~/Code` | does the string contain `/home/<user>/Code/`? | does the **resolved** path leave the checkout, relative forms included? |

Each was a truthful answer to the wrong question: a *name* standing in for a
*property*. The last one is the sharpest, because the checkout itself lives under
the prefix being searched — so a correctly migrated entry
(`…/Code/yellowstone/src/pi-extensions/bizzy`) matches the pattern for "still on a
loose checkout", and the migration signal could never have reached zero. `pi list` printed a nonexistent local path and exited 0; a grep for
`/home/<user>/Code/` never saw the one relative `../../Code/…` entry, and matched
its own replacement string; and `skills-sync status` reported `linked` for a
symlink into a directory that had moved, so a restructure stayed green until a
lane ran `readlink -f` by hand.

The fix is always the same shape and it is one line each: resolve, then test.
`readlink -f` before believing a link, `-e` before believing a path, and a
count of resolved paths rather than a text search for a prefix.

And print the per-item verdict for one item before trusting any total. Every
disagreement over a count in FT-01 was settled by dumping one file, one link or
one lane and reading it, never by re-arguing the aggregate — because a wrong
predicate and a stale reading produce totals that look equally plausible, and
only the per-item evidence tells them apart. This is the
cheapest durable lesson FT-01 produced, and it applies to any check written
after it — including the ones that will one day police this page.

### Plugin refs are pinned commits

`home/.config/herdr/plugins.toml` records a `ref` per plugin. Installing therefore produces
the same code on every machine, and upgrading is a commit that changes one line
— reviewable, attributable, and revertible. The alternative (track a branch)
would mean two machines with the same repo could run different plugin code.

The trade-off is that upstream fixes do not arrive on their own. That is the
intent: security-relevant fixes arrive via `pip`-style explicit action, not
silently.

### The installer merges, and only where it owns the key

`install.sh` does not overwrite `settings.json` or `models.json`. It copies a
defined set of keys and unions the `packages` array by source. A provider block
you already route yourself is never replaced.

This is why re-running the installer is safe on a machine that has been lived
in. The one file it replaces wholesale is `home/.config/herdr/config.toml`, because every
section of it is part of the setup and a partial merge of a TOML file with
`[theme.custom]` tables is a recipe for a broken config.

### `unblock` is linked, not installed

herdr refuses to install a plugin over a locally linked one, and the `unblock`
CLI and the `unblock` pane must be the same version. Both come from one
checkout, which is why the manifest uses `link_path` instead of an npm source.

### `herdr-agy.sh` exists because a state machine lied

For `agy` and `grok` agents, herdr can report `idle`/`done` mid-turn — measured
false-`done` phases of up to 50 seconds. A debounce does not fix it, because the
false state is longer than any reasonable debounce.

Rather than patch the host, the wrapper treats the pane's tail as ground truth:
if the last few lines carry a live-control marker (a braille spinner, `esc to
cancel`, a running task line), the agent is not settled regardless of what the
status field says. Markers are matched only in the tail, so a past tool call
mentioning "running" cannot make the pane look busy forever.

This is the general pattern for the whole repo: when a component's reported
state is untrustworthy, add an independent observation rather than removing the
component.

### The doctor is read-only and exit-coded

`scripts/doctor.sh` never fixes anything. Fixing is `install.sh`'s job, and
keeping them separate means "what is wrong" and "what did the tool do about it"
are different questions with different failure modes. The exit code makes it
usable as a gate in a cron job or a provisioning step without parsing output.

## What does not belong in this repo

A component belongs here when it is **reproducible configuration for a fleet**:
the same file should be right on a second machine. Something that encodes one
operator's live state — reservations, per-lane history, a curated roster — is
theirs, and copying it here makes the repo a second writer of a source of truth.

The current case: two Python helpers under `~/.overlord/tools/` (`leader-board.py`,
`watch-leaders.py`, ~530 lines together) render the leader roster and emit wake
events. They are genuinely portable — only stdlib, no machine paths, and the
"leader lane" rule is a single regex (`(^|-)leader$`) rather than a hardcoded
list. They still should not be copied in, for three reasons:

1. **They read live state, not configuration.** The board's value is the current
   roster; shipping a copy here would mean two producers of the same answer.
2. **The repo cannot test them.** They assert against herdr panes and real goal
   footers; the container has no server and no goal-bearing lanes, so a vendored
   copy would ship untested and the test suite would silently skip it.
3. **Goal-state parsing is the fragile part.** `leader-board.py` recognizes footer
   phrases (`Pursuing goal`, `Goal needs attention`, …) by regex. That knowledge
   belongs with whoever maintains the panes — and the day the extension changes
   its wording, a copy here would be confidently wrong.

**What this repo should do instead** is what it does: document the durable rules
that the tools encode — footer-only goal state, `working` is not health, recover
goal-degraded lanes before asking, refresh the board on change not on a calendar,
a closed run must move off `.dagr/run.json`. Those rules survive a rewrite of the
tools; a copy of the tools would not survive a change to them.

The one thing that *would* justify packaging: if a second operator ever needs this
shape. Then it should become a herdr plugin (a `[[panes]]` entry plus actions, like
`herdr-dagr`) so it is versioned, installable, and testable in the same way the
plugins are — not a file copied between repos.

## How to add something

1. **A herdr plugin** — add a `[[plugin]]` table to `home/.config/herdr/plugins.toml` with a
   pinned `ref` and a one-line `why`; run `scripts/herdr-plugins.sh install`.
2. **A pi package** — add its source to the `packages` array in
   `home/.pi/agent/settings.json`; run `install.sh pi`. If it is a git source, the pin lives
   in the git ref itself.
3. **A pi extension you wrote** — drop it in `home/.pi/agent/extensions/` and add it to the
   installer's file list. Pin nothing: it moves with the repo.
4. **A skill** — add one row to `skills/skills.tsv` and nothing else. The `kind`
   decides where it installs from, and that file is the only thing that has to
   change:
   - `repo` when a repository owns it (usually our fork) — linked from a checkout
     when one exists, so its updates are a `git pull`.
   - `dagr` for a skill a pinned herdr plugin generates; `scripts/skills-sync.sh`
     runs `dagr --skill` so the text always matches the binary that validates it.
   - `bundle` only when no installable home exists — and then say in `why` what
     would retire it, because a bundle is debt, not a design.
   Never copy a skill another tree already ships: the copy drifts, and the
   version an agent runs becomes invisible to the thing that owns it.
5. **A fork** — record it in `docs/forks.md` with its upstream, the reason, and
   how it updates. A fork without a stated reason is a bug.
6. **A default herdr space** — add it to `scripts/overlord.sh`'s space spec
   (label, cwd, tabs) and to `home/.overlord/README.md`. `herdr workspace create` does
   not deduplicate, so the lookup-then-create path there is not optional.

In every case: no credentials, no absolute home paths, and update
`scripts/doctor.sh` so the next person finds out when it breaks. Prefer a
mechanically-derived list over a hand-maintained one — several `doctor` and test
checks were later rewritten to count from `skills/skills.tsv` or
`home/.config/herdr/plugins.toml` after a hardcoded list went stale.
