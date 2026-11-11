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

## Which lint applies here, and why it is decided by provenance

A tree-wide lint cannot tell "bytes we wrote" from "bytes we imported for auditability", and
getting that split wrong does damage in both directions: pointing the style or path lint at the
payload would demand edits to files this directory forbids editing, and a blanket
`--exclude-dir=vendor` would stop the credential scan from looking at third-party bytes at all —
which is exactly where a real secret would be hardest to notice.

So the split is by **provenance, not directory name**, and membership is read from a manifest
rather than guessed from a prefix:

| Half | What decides membership | Style lint (Markdown shape, skill frontmatter) | Developer-path lint | Credential scan |
|---|---|---|---|---|
| Accepted payload `pi-hermes-memory-0.10.0-ft20/` | the exact path is listed in `ft20-provenance/ACCEPTED-13ce3cc6a.sha256` (106 files) | not applied — we did not write it | not applied — one accepted script carries its author's `TSC_BIN` default, which `ft20-portable/` overrides | **applied** |
| Recorded diffs `pi-hermes-memory-0.10.0-ft20/ft20-provenance/patches/` | the path is under that directory | not applied | not applied — a patch has to quote the accepted line it changes | **applied** |
| Yellowstone tooling `ft20-portable/` | everything else | applied | applied | **applied** |

The credential column has no exemption by path at all. The vendor fixtures use one literal
synthetic token (`sk-SYNTHETICCREDENT1AL…`) to stand in for a credential, and the scan exempts
that **exact token** wherever it appears — so a real secret written into a fixture, into the
payload, or into a file added under `vendor/` later is still a finding, and a blanket exclusion
is not needed to keep the fixtures quiet. The scan reports paths and counts only; it never prints
the matched text, because in the failing case that text is the credential.

Two consequences worth stating plainly, because both are load-bearing:

* A file added under `vendor/` that the accepted manifest does not list is **source**, and is
  linted like source. The manifest is what makes the payload exempt, not the directory it sits in.
* Nothing here exempts the payload from the credential scan. If a future accepted commit brings a
  real key with it, the scan is the thing that must fail, and it will.
