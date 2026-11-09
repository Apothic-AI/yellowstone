# Yellowstone docs

Longer-form notes that would bloat the README or the skill. The install,
configure, upgrade and repair instructions live in
[`yellowstone-skill/SKILL.md`](../yellowstone-skill/SKILL.md) — read that first.

| Document | Read it when |
|---|---|
| [`forks.md`](forks.md) | you want to know why a component is a fork or bundled, and whether it still needs to be |
| [`design.md`](design.md) | you are changing the setup and want the reasoning behind the current shape |
| [`pi-config.md`](pi-config.md) | you are editing the pi files under `home/.pi/agent/` and want to know which ones merge, copy, or install only once |
| [`operations.md`](operations.md) | you are running this on a machine day to day: routines, failure modes, what to check |
| [`testing.md`](testing.md) | you are changing the installer and want to prove it on a clean machine |

## The one-paragraph version

herdr manages terminals and reports agent state; pi is the agent. This repo pins
the herdr config, the herdr plugin set, pi's settings and model routing, the
hand-written and forked extensions, and the skills both harnesses read. It
contains no credentials — pi reads keys from `~/.pi/agent/secrets/` through
shell commands stored in `models.json`. `install.sh` reconciles a machine,
`scripts/doctor.sh` reports drift, `scripts/upgrade.sh` moves components forward
in dependency order.

## What is not documented here

- **herdr itself.** `herdr --help`, `herdr --skill`, and
  <https://herdr.dev/docs/> are the authority, and the binary's own skill file
  tracks the version you actually have.
- **pi itself.** The package ships `docs/` beside the installed binary — start
  at `configuration.md`, `models.md`, `packages.md`, `extensions.md`.
- **Each plugin's own behaviour.** `home/.config/herdr/plugins.toml` records why a plugin is
  installed and what it needs; the plugin's upstream README records the rest.
