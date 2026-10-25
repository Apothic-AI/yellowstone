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

| Path | What it is |
|---|---|
| `yellowstone-skill/` | the install/configure/upgrade/repair guide, as an agent skill |
| `AGENTS.md` | the shared agent instructions this setup is built around |
| `herdr/config.toml` | theme, sidebar rows, keybindings |
| `herdr/plugins.toml` | the plugin manifest, with pinned refs |
| `herdr/skills/herdr/` | skill: how an agent drives herdr panes |
| `herdr/scripts/herdr-agy.sh` | reliable agent waits for `agy`/`grok` panes |
| `pi/settings.json` | pi settings and the package list |
| `pi/models.json` | provider routing — commands that read keys, never the keys |
| `pi/extensions/` | hand-written pi extensions |
| `skills/` | skills: `hotshot`, `dagr-producer`, `unblock` |
| `scripts/` | `install` helpers, plugin sync, `doctor`, `upgrade` |
| `docs/` | longer notes on the forks and the decisions behind them |

## The short version of how it fits together

herdr owns the terminals, the panes, and the sidebar that reports which agent is
working. Its plugins add the pieces we actually use: a live DAG of orchestrated
work (`herdr-dagr`), one queue for everything a human has to answer
(`unblock`), session handoff between agents (`catchup`), jj state in the sidebar,
and a theme picker.

pi owns the conversation. Its packages add background tasks, goals, todos,
sub-agents, web access, cache optimization, and the TUI. Two of those are our
forks rather than upstream releases, because upstream and our other extensions
conflict; both install from their own repositories, so this repo pins them
instead of copying them. See [`docs/forks.md`](docs/forks.md).

Both sides read `~/.agents/skills`, which is why the skills live here once
instead of being copied into each tool.

## Requirements

Node.js >= 22.19, git, python3. Rust only if you want `herdr-context` built from
source; `jj` only if you use the jj plugins. Full matrix in
[`yellowstone-skill/SKILL.md`](yellowstone-skill/SKILL.md#prerequisites).

## Safety

- Nothing in this repo contains a credential. `pi/models.json` stores shell
  commands that read key files from `~/.pi/agent/secrets/`.
- `install.sh` backs up every file it replaces (`.bak-yellowstone-<stamp>`) and
  never deletes anything.
- Plugin refs are pinned to commits, so an install is reproducible and an
  upgrade is a reviewable diff.

## License

MIT for the scripts, docs and skills in this repository. Nothing else is
redistributed here: our forks (including `pi-pretty-tui`, MIT © Kainan Yang) are
installed from their own repositories, and `herdr` is Apache-2.0.
