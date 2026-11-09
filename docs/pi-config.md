# pi configuration

What is in `home/.pi/agent/`, and what the installer does with it. The mirror rule
means the first column *is* the installed path: `home/.pi/agent/settings.json` is
`~/.pi/agent/settings.json`.

| File | How it is installed |
|---|---|
| `settings.json` | merged: only the keys Yellowstone owns, plus a package union. On a machine with no file yet it is written from the template with every `@PLACEHOLDER@` package source rendered |
| `models.json` | merged: providers are added, never replaced |
| `pi-auto-compact.json` | copied |
| `pi-goal.json`, `pretty-tui.json` | copied |
| `pi-persist.json` | copied **only if absent** — the trailing reminders are personal |
| `model-picker.json` | copied **only if absent** — the MRU list is personal |
| `web-search.json` | copied **only if absent** — names a browser profile |
| `extensions/nonblock.ts` | copied; disabled unless `PI_NONBLOCK=1` or `nonblock.json` enables it |
| `extensions/transient-error-retry.ts` | copied |
| `docs/trust.example.json` | nothing — a template to copy by hand |

## Credentials

`models.json` never contains a key. Each provider's `apiKey` is a shell command:

```json
"apiKey": "!cat ${HOME}/.pi/agent/secrets/relayfast"
```

pi runs that command at request time and caches the result for the process
lifetime, so rotating a key means writing the file — no config edit, no restart
of anything but the agent.

The installer creates an empty file for every `secrets/<name>` that
`models.json` references and prints the list. Fill each one:

```bash
printf '%s' 'sk-...' > ~/.pi/agent/secrets/relayfast
chmod 600 ~/.pi/agent/secrets/relayfast
```

`scripts/doctor.sh` fails the `pi-secrets` check for any referenced file that is
missing or empty, and then calls `pi auth check` on `defaultProvider` so a
present-but-wrong key is caught too.

## Why `docs/trust.example.json` is not installed

pi refuses a trust store containing anything other than `true`, `false` or
`null` per path, and a malformed file throws on startup. Blanket project trust
is also a judgement about whose code you are willing to run, so the repo ships
a shape and no decision:

```json
{ "/home/you/Code": true }
```

If you prefer per-project prompts, leave `trust.json` out entirely and set
`"defaultProjectTrust": "ask"` in `settings.json`.

## Notes on the merged files

`settings.json` in this directory is a **template**, not a copy of a live file.

Placeholders: three package entries name a checkout rather than a release —
`@PI_EXTENSIONS_APOTHIC@/packages/pi-goal`,
`@PI_EXTENSIONS_1@/packages/pi-modes` and `@PI_FLEET_HOOKS@`. The installer
rewrites them to the paths in `PI_EXTENSIONS_APOTHIC`, `PI_EXTENSIONS_1` and
`PI_FLEET_HOOKS`, and *drops* an entry whose checkout is not configured, saying
so. That is deliberate: a placeholder copied verbatim into a live
`settings.json` is a package entry pi cannot load, and the failure is silent
until the feature is missing.

Package sources are compared by *package name*, so a machine that already has
`pi-pretty-tui` from a local path or `pi-cache-optimizer` from git does not end
up with two copies of the same extension — which for a package that registers a
tool would mean a load conflict, not just clutter.

Nothing in `packages` points into this repository. Every entry is either an
upstream release or one of our forks, installed from its own repository, so an
upgrade is `pi update` rather than a `git pull` here. If you ever need to load a
package from a local path, `json-edit.js` still supports a `@YELLOWSTONE_REPO@`
prefix that it rewrites to the repo root at install time — but prefer a repo.

If you delete a provider block from `models.json` and re-run the installer, the
provider comes back. To keep a different route, edit the existing block rather
than removing it.
