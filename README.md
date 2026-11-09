# Yellowstone

A herdr + pi coding-agent setup, checked in so it can be reproduced, reviewed,
and upgraded like code.

[herdr](https://herdr.dev) is a terminal workspace manager for AI agents.
[pi](https://pi.dev) is the coding agent that runs inside its panes. This repo
is everything that makes the two behave as one system: herdr's config and
plugin set, pi's model routing and extension list, the agent skills both
harnesses read, and the forks we maintain to keep it working.

**New here? Start with [`yellowstone-skill/SKILL.md`](yellowstone-skill/SKILL.md).**
It is written as an agent skill — an install, configure, upgrade and repair
manual — and it is the only document you need in full.

```bash
git clone https://github.com/Apothic-AI/yellowstone.git
cd yellowstone
./install.sh --dry-run     # see the plan
./install.sh               # apply it
scripts/doctor.sh          # confirm it took
```

## What is in here

`home/` is a literal mirror of `$HOME`: every file the installer writes is stored at
the path it is installed to, so `home/.pi/agent/settings.json` *is*
`~/.pi/agent/settings.json`. There is no second table mapping one to the other, and
a new file needs only a path under `home/`.

| Path | What it is |
|---|---|
| `yellowstone-skill/` | the install/configure/upgrade/repair guide, as an agent skill |
| `home/AGENTS.md` | the fleet instruction core, installed to `~/AGENTS.md` |
| `AGENTS.md` | this repo's own instructions — a pointer to the global core, plus where role deltas go |
| `home/.config/herdr/config.toml` | theme, sidebar rows, keybindings (dictate, voice, bar, plugin manager, dagr, unblock, stash, beady-eye) |
| `herdr/plugins.toml` | the plugin manifest, with pinned refs |
| `home/.agents/skills/herdr/` | skill: how an agent drives herdr panes |
| `home/.local/bin/herdr-agy.sh` | reliable agent waits for `agy`/`grok` panes |
| `home/.pi/agent/settings.json` | pi settings and the package list |
| `home/.pi/agent/models.json` | provider routing — commands that read keys, never the keys |
| `home/.pi/agent/extensions/` | hand-written pi extensions (`transient-error-retry`, `nonblock`) |
| `home/.pi/agent/*.json` | extension configs: goal, pretty-tui, persist, auto-compact |
| `home/.overlord/` | instructions + index for the `overlord` orchestrator space |
| `home/.agents/skills/` | the skills this repo is the source of truth for |
| `skills/skills.tsv` | which tree owns each agent skill |
| `scripts/` | `install` helpers, plugin sync, `doctor`, `upgrade`, `overlord` |
| `test/` | Docker test environment for the installer |
| `docs/` | longer notes on the forks and the decisions behind them |

Two `$HOME` paths are deliberately **not** mirrored, and the installer says so:
`~/.pi/agent/secrets/` (empty credential files for you to fill in — a credential must
never be a checked-in file) and `~/.pi-profile-switch/instances/<id>`, the generated
profile instance tree. `home/.pi/agent/` is therefore the path pi uses **when no
profile is selected**, not a copy of what a profile-selected machine runs; on this
fleet the two differ today, and recording that is the point.

## The short version of how it fits together

herdr owns the terminals, the panes, and the sidebar that reports which agent is
working. Its plugins add the pieces we actually use: a live DAG of orchestrated
work (`herdr-dagr`), one queue for everything a human has to answer
(`unblock`), session handoff between agents (`catchup`), the project's bead
trees beside the pane with the agent working each one (`beady-eye`), parking a
whole workspace and getting it back (`stash`) or recovering the herd after a
crash (`resurrect`), jj state in the sidebar, a theme picker, and voice two ways
— transcription into the pane (`dictate`) and a spoken conversation that drives
the panes (`herdr-voice`).

pi owns the conversation. Its packages add background tasks, goals, todos,
sub-agents, web access, cache optimization, and the TUI. Two of those are our
forks rather than upstream releases, because upstream and our other extensions
conflict; both install from their own repositories, so this repo pins them
instead of copying them. See [`docs/forks.md`](docs/forks.md).

Both sides read `~/.agents/skills`, which is why skills are installed from the
tree that owns each one rather than copied here. On top of both sit two herdr
spaces that are not projects: `overlord` (cwd `~/.overlord`, tab `overlord`) for
coordinating project agents, and `sysops` (cwd `~/.sysops`, tab `sysop-leader`)
for machine and service operations. A comms space for the operator-facing channel
is a third surface of that kind, set up on its own: this installer does not create
it.

## Requirements

Node.js >= 22.19, git, python3. Rust only if you want `herdr-context` built from
source; `jj` only if you use the jj plugins. Full matrix in
[`yellowstone-skill/SKILL.md`](yellowstone-skill/SKILL.md#prerequisites).

## Safety

- Nothing in this repo contains a credential. `home/.pi/agent/models.json` stores shell
  commands that read key files from `~/.pi/agent/secrets/`.
- `install.sh` backs up every file it replaces (`.bak-yellowstone-<stamp>`) and
  never deletes anything.
- Plugin refs are pinned to commits, so an install is reproducible and an
  upgrade is a reviewable diff.

## License

MIT for the scripts, docs and skills in this repository. Nothing else is
redistributed here: our forks (including `pi-pretty-tui`, MIT © Kainan Yang) are
installed from their own repositories, and `herdr` is Apache-2.0.
