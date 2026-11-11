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
rather than guessed from a prefix — **and membership is not enough on its own**: an exemption is
granted only when the file's `sha256` still equals the hash the manifest records for it. A path
alone would exempt whatever someone appended to an accepted file.

| Half | What decides the exemption | Style lint (Markdown shape, skill frontmatter) | Developer-path lint | Credential scan |
|---|---|---|---|---|
| Accepted payload `pi-hermes-memory-0.10.0-ft20/` | the path is listed in `ft20-provenance/ACCEPTED-13ce3cc6a.sha256` (106 files) **and** the file's sha256 matches the recorded hash | not applied — we did not write it | not applied — one accepted script carries its author's `TSC_BIN` default, which `ft20-portable/` overrides | **applied** |
| Provenance records (exactly four) | `BASE-MANIFEST.sha256`, `ft20-provenance/ACCEPTED-13ce3cc6a.sha256`, `…-tested-bytes.json` and `REBUILD.md`, each pinned by its own sha256 in `test/lib-vendor.sh` | applied unless the file is also an exact accepted payload member | not applied | **applied within the scan's scope** |
| Recorded diffs `…/ft20-provenance/patches/` | **one** patch, named with its hash: the one that quotes the accepted `TSC_BIN` line. `patches/` is *not* a blanket exemption — a new patch inherits nothing until it is named | applied unless the file is also an exact accepted payload member | not applied for that one patch | **applied within the scan's scope** |
| Yellowstone tooling `ft20-portable/` | everything else, including every file not listed above | applied | applied | **applied** |

The four provenance records are the **oracle**, and pinning them is what makes the hash column
mean anything: without it, editing a payload file and regenerating the manifest would make the
check agree with itself. `test/verify-vendor-provenance.sh` (a host gate, because the oracle is
git) asserts that all 106 members match **both** the working tree and the committed blob, that the
four pinned artifacts are the committed bytes, and that a doctored manifest or a new patch is
rejected. It only reads — it never regenerates the 106-line list, and it asserts its own manifest
hash is unchanged at the end of the run.

The provenance records and the named patch are exempt only from developer-path lint; their
provenance does not exempt them from style lint. The credential column has no vendor exemption
by path within the scan's existing scope: the scan excludes `src/` and `.git`, so it does not
establish that those excluded trees contain no credentials. The vendor fixtures use one literal
synthetic token (`sk-SYNTHETICCREDENT1AL…`) to stand in for a credential, and the scan exempts
that **exact token** wherever it appears — so a real secret written into a fixture, into the
payload, or into a file added under `vendor/` later is still a finding, and a blanket exclusion
is not needed to keep the fixtures quiet. Changing even one character of that sentinel makes the
fixture a finding; `test/run-tests.sh` asserts exactly that. The scan reports paths and counts
only; it never prints the matched text, because in the failing case that text is the credential.

Three consequences worth stating plainly, because all three are load-bearing:

* A file added under `vendor/` that the accepted manifest does not list is **source**, and is
  linted like source. The manifest is what makes the payload exempt, not the directory it sits in.
* A listed file whose bytes have changed is **also** source, because the exemption needs the
  matching hash. That is the difference between "this is the reviewed byte" and "this has this
  path".
* Nothing here exempts the payload from the credential scan. If a future accepted commit brings a
  real key with it, the scan is the thing that must fail, and it will.
