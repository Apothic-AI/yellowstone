# Tasks

This change produces no code. Each task checks a specification item back against the implementation, confirming no unimplemented behavior was written and no implemented behavior was missed.

## 1. Specification-to-implementation consistency check

- [x] 1.1 Check "Skill reference resolution": read `src/skill-registry.ts`; confirm all six points match the specification — read-only discovery, `noExtensions`, same-name precedence left to Pi, discovery re-run on every resolution, no scanning when the project is untrusted, and project-scope package skills excluded
- [x] 1.2 Check "Extension reference resolution": read the `DiscoveredExtensions` constructor and `select` in `src/extension-discovery.ts`; confirm the three selection forms and the loose-file ID derivation rules (including `index.<ext>` collapsing)
- [x] 1.3 Check "Failure behavior of extension references" and "Extension ID collisions": read `#unknownMessage`, the throwing branches of `select`, and construction-time collision detection in `src/extension-discovery.ts`; confirm the four failure conditions and warning wording item by item
- [x] 1.4 Check "MCP server reference resolution and the adapter dependency": read `src/mcp-config.ts`; confirm the six standard configuration locations, the role of `isShared`, the three configuration error paths, and `MissingMcpAdapterError`'s trigger condition
- [x] 1.5 Check "Tool reference resolution": read `src/switching/tool-references.ts` and the `literalMustExist: false` call in `src/profile-resolver.ts`; confirm only built-in tools are expanded before spawn, unmatched literals are reported rather than dropped, and no tools field enters the plan when `tools` is undeclared
- [x] 1.6 Check "Resolution and validation of profile-level settings fields": read the `VALID_THINKING_LEVELS` validation in `src/profile-resolver.ts`, the error when `validateModel` is missing, and the conditional spreading during plan assembly
- [x] 1.7 Check "Unified failure tiering for references": read `expandReferences` and `unmatched` collection (`skill:` / `extension:` / `mcp:` prefixes) in `src/profile-resolver.ts`; confirm neither tool case enters the failure surface

## 2. Specification quality validation

- [x] 2.1 `openspec validate spec-baseline-resource-reference --strict` passes
- [x] 2.2 Compare the specification against `docs/adr/0007-discovery-only-extension-filtering.md`, `docs/adr/0008-extension-discovery-delegates-to-pi-package-manager.md`, and `docs/adr/0009-reference-resolution-failure-tiering.md`; confirm it restates no reasoning or implementation history
- [x] 2.3 Compare the specification against the "Filtering model" table in `docs/architecture/overview.md`; confirm the specification only states behavior and does not restate the scope-to-Pi-mechanism mapping
- [x] 2.4 Check wording against `CONTEXT.md`; confirm no avoid-words are used and no implementation class or internal function names appear

## 3. Doc Impact follow-through

- [x] 3.1 Add a row to the "Known limitations" table of `docs/architecture/overview.md`: project-scope package skills are not referenceable because their packages live under the project `.pi/npm`, which generated global settings cannot reference
- [x] 3.2 Check `docs/prd.md`: confirmed no change to positioning, goals, or non-goals; no edit needed
- [x] 3.3 Check `CONTEXT.md`: confirmed no new terms and no changed meanings; no edit needed
- [x] 3.4 Check `docs/adr/`: confirmed no hard-to-reverse decision introduced; no new ADR needed
