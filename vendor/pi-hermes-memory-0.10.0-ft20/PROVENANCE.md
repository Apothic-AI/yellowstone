# Provenance — imported 0.10.0 base

This directory is an **auditable import** of a published third-party package, not a Yellowstone
component and not a git-subrepo. It exists so that a fix diff can be reviewed against the exact
bytes that are running, and it must not be published as if it were canonical here.

| Field | Value |
|---|---|
| Package | `pi-hermes-memory` |
| Version | `0.10.0` |
| Source installed at | `/home/bitnom/.pi/agent/npm/node_modules/pi-hermes-memory` |
| Registry ref | `npm:pi-hermes-memory` (declared in `/home/bitnom/.pi/agent/settings.json`) |
| Resolved tarball | `https://registry.npmjs.org/pi-hermes-memory/-/pi-hermes-memory-0.10.0.tgz` |
| npm integrity | `sha512-H0q2jTsyBcp0Q85eZFABke2gFId646pHkkgp2YqSMCumyTWxndsTtmdX1e97OW5nh+mu/SMRYLnxNlO9zLfutw==` |
| Declared in | `/home/bitnom/.pi/agent/npm/package.json` (dependency `pi-hermes-memory: ^0.10.0`) |
| Upstream repository | `git+https://github.com/chandra447/pi-hermes-memory.git` (per `package.json`) |
| Files imported | 92 |
| Byte-identity check | `diff -r <installed> <this directory>` → identical at import time |
| Per-file digests | `BASE-MANIFEST.sha256` (92 entries, `sha256sum` format, relative paths) |
| Licence | `LICENSE` imported verbatim, unchanged |

## What was NOT imported

* No tests — the published tarball does not ship them (`package.json` `files` omits `tests/`).
* No `tsconfig.json` — not shipped either, which is why `scripts/ensure-dev.mjs` refuses to run the
  upstream `check` script from an installed package (its own words: *"The published tarball
  intentionally omits tests/ and TypeScript (devDependency)"*).
* **No memory data.** `MEMORY.md`, `USER.md`, `failures.md`, `projects-memory/**`, `sessions.db`,
  `STANDING.md`, skills and any session content are private store state and are deliberately absent.
  This directory contains public package source only.

## Identity of the fix on top

The pristine import is commit A on this branch. The fix is commit B and touches only files listed by
`git show --stat B`. Because the base is hash-pinned in `BASE-MANIFEST.sha256`, "imported base" and
"fix diff" are separately verifiable rather than inferred:

```bash
git show --stat <A>                 # the import
git show --stat <B>                 # the fix
sha256sum -c BASE-MANIFEST.sha256    # every untouched base file still matches upstream 0.10.0
```

The second command is the important one: any base file that the fix did **not** intend to touch must
still hash-match the published package. Files the fix does touch will report `FAILED` — that set must
equal `git show --name-only <B>`.
