# Future replacement — intent only, not applied

`settings.future.diff` is the whole source change this candidate prepares:

```diff
-    "npm:pi-hermes-memory",
+    "@YELLOWSTONE_REPO@/vendor/pi-hermes-memory-0.10.0-ft20",
```

in `home/.pi/agent/settings.json`. It passes `git apply --check` and **has not been applied** —
`git status home/.pi/agent/settings.json` is empty in this candidate, by design. Applying it is a
separate release with its own acceptance, under the parent's authority.

## Why the placeholder and not a path

`home/.pi/agent/settings.json` is a template. `scripts/json-edit.js` rewrites `@YELLOWSTONE_REPO@/…`
to `<checkout>/…` at install time, and `docs/pi-config.md` records this as the live mechanism for the
nine `src/pi-extensions/…` entries. A local Pi package path must resolve from `~/.pi/agent/` in the
end, so an absolute render is what makes the entry loadable; writing a literal
`/home/<operator>/Code/…` would hard-code this machine and break every other install.

## What must be true before it is applied

1. **The runtime dependency link exists in the package directory.** Pi does not install or modify a
   local package — "their dependency tree remains the package author's responsibility" (`pi` docs,
   *Pi Packages*). The vendor tree therefore needs `node_modules/strip-ansi` (and `better-sqlite3`
   for SQLite features) linked at the *deployment* path, not only in the staged copy.
   `ft20-portable/link-deps.sh` is the mechanism; it is gitignored in the package, so it must be run
   after install, and `gate 9`-style `pi list` must show **no** load failure before anything else.
2. **`json-edit.js` still recognises the entry.** It compares package sources by *package name*, and
   a local directory has no registry name to compare. The merge must not duplicate
   `pi-hermes-memory` when a machine already has `npm:pi-hermes-memory` in its live settings, and the
   render must not drop the entry.
3. **`test/verify-monorepo-install.sh` passes.** It installs into a throwaway `HOME` and asserts
   every package and skill resolves inside the checkout — precisely because `pi list` will happily
   report a nonexistent local path as an installed package and exit 0. The vendor path must be inside
   the checkout and must exist.
4. **Rollback is literal.** `npm:pi-hermes-memory` on disk stays where it is, unreferenced, and the
   pre-change `settings.json` is copied aside rather than reconstructed. Restoring the line restores
   the previous behaviour without a reinstall.

## Explicitly out of scope here

No settings edit, no `pi install`, no `pi update`, no `/reload`, no install-script change, no
`json-edit.js` change, no store or profile edit. The candidate is source-only: the payload, the way
to rebuild it, the way to verify it, and this diff.

## The claim this does not make

The replacement makes the *reviewed local bytes* the loaded extension. It does not make them an
upstream release, does not change the package version (`0.10.0`), and does not assert that the
historical FT-20 warning cause is resolved in general.
