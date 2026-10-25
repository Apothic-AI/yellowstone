# pi configuration

What is here, and what the installer does with it.

| File | Installed to | How it is installed |
|---|---|---|
| `settings.json` | `~/.pi/agent/settings.json` | merged: only the keys Yellowstone owns, plus a package union |
| `models.json` | `~/.pi/agent/models.json` | merged: providers are added, never replaced |
| `pi-auto-compact.json` | `~/.pi/agent/pi-auto-compact.json` | copied |
| `model-picker.json` | `~/.pi/agent/model-picker.json` | copied **only if absent** — the MRU list is personal |
| `web-search.json` | `~/.pi/agent/web-search.json` | copied **only if absent** — names a browser profile |
| `extensions/transient-error-retry.ts` | `~/.pi/agent/extensions/` | copied |
| `trust.example.json` | nothing | a template to copy by hand |

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

## Why `trust.example.json` is not installed

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
Two entries are rewritten at install time:

- `@YELLOWSTONE_REPO@/plugins/pi-pretty-tui` becomes an absolute path inside
  your clone, so pi loads the vendored fork straight from this repository.
- Package sources are compared by *package name*, so a machine that already has
  `pi-pretty-tui` from a local path or `pi-cache-optimizer` from git does not
  end up with two copies of the same extension — which for a package that
  registers a tool would mean a load conflict, not just clutter.

If you delete a provider block from `models.json` and re-run the installer, the
provider comes back. To keep a different route, edit the existing block rather
than removing it.
