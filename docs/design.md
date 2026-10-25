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

This single rule is responsible for the vendored `pi-pretty-tui`. `bizzy` owns
`bash` so it can background long commands; pretty-tui used to register `bash`
to render it. Neither extension is wrong; they just cannot both claim the name.
The vendored copy uses `pi.registerToolRenderer`, which composes instead of
competing, so rendering and behaviour are decoupled.

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
| `~/.pi/agent/model-picker.json` | most-recently-used order is a habit, not a setting |
| `~/.pi/agent/web-search.json` | picks a browser profile, which is machine-specific |
| `~/.pi/agent/trust.json` | blanket project trust is a judgement about whose code you run |
| `~/.pi/agent/sessions/` | conversations |
| `~/.config/herdr/session.json` | live pane layout |

`model-picker.json` and `web-search.json` are installed only when absent, and
`trust.example.json` is documented rather than installed. That is the pattern:
ship a default that a fresh machine needs, never overwrite a choice a human
made by using the tool.

## Design decisions worth knowing

### Plugin refs are pinned commits

`herdr/plugins.toml` records a `ref` per plugin. Installing therefore produces
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
in. The one file it replaces wholesale is `herdr/config.toml`, because every
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

## How to add something

1. **A herdr plugin** — add a `[[plugin]]` table to `herdr/plugins.toml` with a
   pinned `ref` and a one-line `why`; run `scripts/herdr-plugins.sh install`.
2. **A pi package** — add its source to the `packages` array in
   `pi/settings.json`; run `install.sh pi`. If it is a git source, the pin lives
   in the git ref itself.
3. **A pi extension you wrote** — drop it in `pi/extensions/` and add it to the
   installer's file list. Pin nothing: it moves with the repo.
4. **A skill** — put it in `skills/<name>/SKILL.md` and add the name to the
   `install_skills` loop and to `scripts/doctor.sh`.
5. **A fork** — record it in `docs/forks.md` with its upstream, the reason, and
   how it updates. A fork without a stated reason is a bug.

In every case: no credentials, no absolute home paths, and update
`scripts/doctor.sh` so the next person finds out when it breaks.
