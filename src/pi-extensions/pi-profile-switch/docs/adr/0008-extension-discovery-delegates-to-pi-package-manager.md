# Extension discovery delegates entry enumeration to Pi's package manager

Refines [ADR-0007](0007-discovery-only-extension-filtering.md): discovery stays, but entry enumeration is no longer reimplemented.

## Context

ADR-0007 established "discover and filter" but did not settle **who owns the discovery rules**. `extension-discovery.ts` reimplemented them by hand: reading `package.json#pi.extensions`, `stat`-ing every declared entry, scanning `*.{ts,js}` in the extensions directory, deriving filename stems. Pi resolves the same facts in `package-manager.js` (`collectAutoExtensionEntries` → `resolveExtensionEntries` → `collectFilesFromPaths`, plus its own `+`/`-`/`!` filtering and ignore rules).

The two implementations drifted silently and repeatedly:

- **Directory entries were dropped.** `"extensions": ["./dist"]` is the convention for every compiled extension package, but the hand-rolled check required regular files, so `pi-web-access` resolved to empty and activation failed with `unknown extension: "pi-web-access"` — while Pi itself loaded the package fine. This was the bug that exposed the problem.
- **Ignore rules were missing.** `.gitignore`, dot-file, and `node_modules` exclusions and package-level include/exclude filters did not exist, so the referenceable-name list contained entries Pi would never load.
- **The gap was unmeasurable.** Every new Pi convention would have to be duplicated here, while tests only validated the hand-rolled rules against themselves and could never detect divergence from Pi.

The cost was 120+ lines of mirror logic that could only ever be verified as internally self-consistent, never as consistent with Pi.

## Decision

Keep discovery, delete the reimplemented rules. `ExtensionDiscovery` now calls Pi's own resolver and classifies its output:

1. **Entry enumeration goes to Pi.** `discoverImplicitExtensions` constructs a `DefaultPackageManager` (`SettingsManager.create(cwd, agentDir, { projectTrusted })`) and calls `resolve(async () => "skip")`. Package entries, loose files, precedence, and filtering all come from Pi's implementation.
2. **`"skip"` preserves the read-only contract.** `onMissing: "skip"` reports missing sources as absent instead of installing them — no installs, no network, no filesystem changes. Extension modules are still never imported.
3. **pi-profile keeps only its own concepts.** Referenceable IDs, project-over-global merging, `select()` resolution, and error wording. Package-sourced entries are grouped by configuration source; entries are always concrete files, because that is the output shape of Pi's resolver.
4. **Path references point at files.** A profile's absolute or `~/` reference must point at an extension file — no directory expansion: the loader imports the referenced path verbatim, and the generated package allowlist only matches file paths; accepting directories would only postpone the failure.

## Rejected alternatives

**Continuing to hand-implement the discovery rules** (ADR-0007's implementation). Rejected for the three drifts in Context.

## Consequences

- Coupling is to `resolve()` (a public `PackageManager` API), not to unexported internals. SDK changes fail at a well-defined location instead of drifting silently.
- `resolve()` also resolves skills, prompts, and themes — work that duplicates `SkillRegistry`. It is read-only, runs in parallel with skill discovery, and needs no subprocess or network, so we accept it rather than reimplement a narrower resolver Pi does not expose.
- Entries excluded by `.gitignore`, dot-file, `node_modules` rules, or a package's own filters no longer appear in the referenceable list. They could never be loaded anyway.
- Packages whose entries are all filtered out are still listed, with zero entries; selecting one reports `declares no extension entries` instead of `unknown extension`.
