# FT-20 provenance — imported 0.10.0, plus the accepted patch series

This directory is not part of the upstream package. It is the record that makes the package
directory beside it falsifiable: where the bytes came from, and how to rebuild them from public
inputs with no git history and no network.

Read `../PROVENANCE.md` first. It is the upstream identity — package `pi-hermes-memory` 0.10.0,
resolved tarball `https://registry.npmjs.org/pi-hermes-memory/-/pi-hermes-memory-0.10.0.tgz`,
npm integrity `sha512-H0q2jTsyBcp0Q85eZFABke2gFId646pHkkgp2YqSMCumyTWxndsTtmdX1e97OW5nh+mu/SMRYLnxNlO9zLfutw==`,
92 files pinned by `BASE-MANIFEST.sha256`, `LICENSE` imported verbatim (MIT, unchanged) — and it
is byte-identical to what the accepted commit carries.

## What is in here

| File | What it is |
|---|---|
| `ACCEPTED-13ce3cc6a-tested-bytes.json` | Independent reacceptance fingerprint of `13ce3cc6a47c5dcf3ea2eef899ba04b9079f2fce`: 106 files, each with its git blob id and sha256. Byte-identical copy of `.local/state/ft20-reaccept/receipts-v2/exact-tested-bytes.json` (`cmp` verified). |
| `ACCEPTED-13ce3cc6a.sha256` | The same 106 sha256 digests in `sha256sum -c` form, package-relative. This is the oracle the rebuild proof compares against. |
| `patches/0001…0004` | The series from the imported base to the accepted bytes, one patch per commit, package-relative (`a/src/...`, `b/src/...`), applied with `git apply` from the package root. |

## The series

| Patch | Commit | Bytes | Diffs | What it does |
|---|---|---|---|---|
| `0001-fail-closed-parser-redacted-diagnostics.patch` | `5a1446c2a` → `6ba1a0bfc` | 43,613 | 9 | Fail closed on invalid memory operation plans; add the typed parse outcome, the bounded/redacted diagnostics helper, the API-compat and parser test surfaces, `tsconfig*.json` and the two scripts. |
| `0002-host-sdk-strict-typecheck.patch` | `6ba1a0bfc` → `b71ccff28` | 22,727 | 8 | Clear the two host-SDK typing errors so the whole component type-checks strict at zero. |
| `0003-terminal-partial-apply-diagnostic-containment.patch` | `b71ccff28` → `7be3d3e99` | 36,630 | 9 | Stop retrying a plan that already applied operations (terminal partial outcome, truthful counts); allowlist `stopReason`, redact/bound provider-model identifiers, cap diagnostics before return and render. |
| `0004-child-failure-empty-consolidation-boundary.patch` | `7be3d3e99` → `13ce3cc6a` | 9,721 | 3 | Fixed `child_failed` / `child_exception` warning text with an exit code rendered only for integers 0–255; fixed empty-completion text for consolidation. |

`b71ccff28` and `7be3d3e99` were **rejected** by independent review (`.local/state/ft20-exact-review/acceptance.md`
and the R1/R2 findings). They are in the series because they are the ancestry of the accepted
commit, and a series that skipped them would not be a series from the import. The accepted state is
the *cumulative* result, and that is the only state this candidate vendors.

## Rebuild

```bash
FT20_WORK=/scratch/ft20 ./vendor/ft20-portable/rebuild-vendor.sh
```

Measured on this machine (receipt: `.local/state/ft20-vendor/…/rebuild-receipt.json`):

```
staged=106  base_after_reverse=94  base_manifest=92/92 OK  replayed=106  exact=106/106  mismatch=0  missing=0
```

Step by step, with no source worktree and no network:

1. Copy the 106 accepted files (the file list comes from `ACCEPTED-13ce3cc6a.sha256`).
2. `git apply -R` patches 0004→0001: 106 → 94 files.
3. `sha256sum -c BASE-MANIFEST.sha256` → **92/92 OK**, and the only files outside that manifest are
   `BASE-MANIFEST.sha256` and `PROVENANCE.md`. That is the "this really is upstream 0.10.0" half.
4. `git apply` patches 0001→0004: 94 → 106 files.
5. Compare all 106 sha256 against `ACCEPTED-13ce3cc6a.sha256` → **0 mismatch, 0 missing**.

## Limits, stated rather than implied

* This is **not** an upstream fix and claims no upstream acceptance. `package.json` keeps the
  upstream name and version (`pi-hermes-memory`, `0.10.0`), because it is that package plus a local
  patch series; renaming it would be the claim this candidate does not make.
* The upstream suite advertised in `package.json` (732 tests) is **not published in the tarball and
  was not run** by this candidate or by the acceptance it inherits. It pins nothing here.
* The tarball ships no tests and no `tsconfig.json`; the test and build surface in the series is
  this repo's own addition, reviewed on its own terms.
* No memory/session data of any kind is vendored. The store is private state and stays out.
