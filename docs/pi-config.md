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

Placeholders: no entry in this template names a checkout any more, but
`json-edit.js` still understands two kinds of placeholder, because a settings
file can be older than the tree it is installed from.

- **`@YELLOWSTONE_REPO@/<path>`** — the live mechanism. Rewritten to
  `<checkout>/<path>` at install time. Nine entries use it, pointing at the
  subrepos under `src/`; see below.
- **`@PI_EXTENSIONS_APOTHIC@`, `@PI_EXTENSIONS_1@`, `@PI_FLEET_HOOKS@`** — the
  older, checkout-based form, resolved from those three environment variables
  (defaulted in `install.sh` and `scripts/lib.sh`). **Inert with this tree**:
  nothing in `home/.pi/agent/settings.json` names them since the subrepos became the source,
  so setting the variables has no effect today. They survive for a settings file
  that still carries one, and for a machine whose components live outside a
  monorepo checkout — a path that no longer exists in this repo's own
  deployment. An entry whose variable is unset is *dropped* rather than written
  as an unloadable path, and `json-edit.js` says which one it skipped: a missing
  fork reported is better than a package entry pointing at a directory that
  `pi list` will cheerfully list and never load.

Package sources are compared by *package name*, so a machine that already has
`pi-pretty-tui` from a local path or `pi-cache-optimizer` from git does not end
up with two copies of the same extension — which for a package that registers a
tool would mean a load conflict, not just clutter.

**Nine of the entries point into this repository.** Each is written as
`@YELLOWSTONE_REPO@/src/…` and `json-edit.js` renders it to the checkout at
install time, so what `pi` loads and what this repo pins are the same files. The
consequence is deliberate and easy to mistake for a bug: `pi update --extensions`
reconciles the npm packages and **does nothing** to those nine. Their upgrade
path is `git subrepo pull <dir>` followed by `./test/verify-subrepo-roundtrip.sh`,
and `.gitrepo` is the record of what each one is synced to. The remaining
entries are upstream npm releases, and `pi update` is still what moves them.

A rendered `@YELLOWSTONE_REPO@` path is only useful if the file is there, and
`./test/verify-monorepo-install.sh` is what holds that: it installs into a
throwaway `HOME` with `herdr` stubbed and asserts every package and skill
resolves inside the checkout, because `pi list` will report a nonexistent local
path as an installed package and exit 0.

If you delete a provider block from `models.json` and re-run the installer, the
provider comes back. To keep a different route, edit the existing block rather
than removing it.
