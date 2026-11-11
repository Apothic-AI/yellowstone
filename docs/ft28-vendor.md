# FT-28 root-carried vendor candidate (prep only)

`vendor/pi-tps-stats-ft28/` is an MIT upstream-derived Fleet addon carried by
Yellowstone's root repository. It is **not a subrepo**, has no `.gitrepo`, remote,
new account or separately published package. Production `PI_EXTENSIONS_FROM=git`
continues pinning the existing subrepos; this addon needs no separate git-pi pin:
its nine files and version are pinned by the root commit. The ordinary `pi` stage
renders/merges the settings template and reconciles packages; no installer bypass
or replacement installer is introduced. Keep the root checkout available at runtime.

## Exact source mapping

All nine files are byte-identical to
`0f5d18b8e8729ebde4871661b22948b0e9f15c47:src/pi-extensions/pi-tps-stats/`,
relocated to `vendor/pi-tps-stats-ft28/`:

- `LICENSE`, `UPSTREAM.md`, `README.md`, `package.json`
- `index.ts`, `metrics.ts`, `storage.ts`
- `scripts/typecheck.mjs`, `test/stats.test.mjs`

`LICENSE` retains Copyright (c) 2026 arhen, MIT. `UPSTREAM.md` records the
upstream source URL, `@arhen/pi-core-tps-stats` 1.3.4 and inspected source hash.
The accepted derived package name/version remain
`@yellowstone/pi-tps-stats-candidate` 0.1.0 (private). Its README's isolated/not
installed wording describes the original accepted source and the still-uninstalled
candidate, not an instruction to create a second install. This document supplies
root-vendor framing without changing any accepted file, including provenance.

## Single replacement, never coexistence

The template replaces only `npm:@arhen/pi-core-tps-stats` with
`@YELLOWSTONE_REPO@/vendor/pi-tps-stats-ft28`. All other entries/filters stay intact.
`merge-packages` opts into targeted retirement only when that exact vendor path
is selected by the template. Normal/pinned npm specs, object entries and local
upstream manifests (including settings-relative paths) converge to one vendor
entry. Existing object resource filters/options survive. Repeated merges are
byte-idempotent; upstream+vendor duplicates collapse. Conflicting duplicate
filters fail before writing instead of silently widening access. An explicit
empty extension filter remains empty: installation does not override consent.
Other packages are governed by the existing merger, not a global retirement.

The old upstream and candidate both register `/tps-stats` and footer key `tps`.
They must never load together. No live adoption is authorized by this candidate.
Unknown direct loose-extension/CLI registrations and future profile-generated
settings require separate adoption review; this migration owns `packages` only.

## Rebuild and review

From the accepted source object, in an empty destination:

```sh
mkdir -p vendor/pi-tps-stats-ft28
git archive 0f5d18b8e8729ebde4871661b22948b0e9f15c47 src/pi-extensions/pi-tps-stats \
  | tar -x --strip-components=3 -C vendor/pi-tps-stats-ft28
node test/verify-ft28-vendor.mjs
(cd vendor/pi-tps-stats-ft28 && npm run check)
./test/run.sh gates
```

No dependency installation is needed for package checks when the existing host
SDK/TypeScript declarations are available. `verify-ft28-vendor.mjs` verifies all
nine blobs against the accepted object as well as fresh/warm settings, filters,
retirement, duplicate collapse and conflict refusal. Root gates retain their own
sandbox/network requirements and must not be reported passed unless all pass.

The review receipt and logs live under
`~/.local/state/ft28-vendor/`; they identify the exact root candidate, integration
diff, source/file hashes, gates and isolated full-package zero-provider proof.
These scratch proofs are not live consumer adoption or a provider smoke test.

## Rollback (plan, not executed on a consumer)

Before any separately authorized adoption, snapshot the consumer's exact settings
and launch plan. Restore those exact snapshots to return its original upstream
source/pin/filters; do not append upstream alongside vendor. Stop if both TPS
identities would remain. Preserve stats config/logs (do not delete or migrate data).
Only an explicitly released idle consumer may subsequently reload/relaunch.
For source rollback, revert the single root candidate commit as a new forward
commit; do not reset shared history, change subrepo pins or remove attribution.
No push/install/reload is performed by producing this candidate.
