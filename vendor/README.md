# vendor — third-party bytes, not a Yellowstone component

Two directories, for two different jobs:

| Path | What it is | Ownership |
|---|---|---|
| `pi-hermes-memory-0.10.0-ft20/` | The upstream MIT package, at the bytes that are accepted for the FT-20 fix, plus an `ft20-provenance/` record beside the upstream files. | **Third-party.** Not Yellowstone source, not a git-subrepo, no `.gitrepo`. |
| `ft20-portable/` | The candidate's own tooling: rebuild proof, portable strict gate, the deferred integration diff, and the deferred loader canary. | Yellowstone repo tooling. |

## Why here and not under `src/pi-extensions/`

Everything under `src/pi-extensions/` is a git subrepo pointing at an `Apothic-AI` repository,
pinned by a `.gitrepo` file and upgraded with `git subrepo pull`. This package has no such
upstream copy: it is `npm:pi-hermes-memory` 0.10.0 plus a reviewed local fix. Putting it in the
subrepo directory would make it look like an owned component that forgot its `.gitrepo`, and the
first reader to run `git subrepo pull` would be right to wonder what they were pulling.

`vendor/` says what it is: bytes imported for auditability, with the licence kept verbatim and a
patch series that reconstructs them.

## What the package directory may and may not be used for

* It **may** be pointed at by `~/.pi/agent/settings.json` as a local package path — that is the
  deferred integration this candidate prepares, and it is not applied here.
* It **may not** be published, packaged or edited in place. There is no `npm install` in it, no
  `postinstall`, and no build output committed.
* Its 106 files are exactly the accepted commit `13ce3cc6a47c5dcf3ea2eef899ba04b9079f2fce`
  (`src/pi-extensions/pi-hermes-memory-review-fix`), modulo the provenance directory this repo
  adds beside them. `ft20-portable/rebuild-vendor.sh` re-proves that from the patch series alone.

Read `pi-hermes-memory-0.10.0-ft20/PROVENANCE.md` for the upstream identity (tarball, npm
integrity, 92-file manifest) and `ft20-portable/README.md` for how the candidate is verified and
what it does **not** claim.
