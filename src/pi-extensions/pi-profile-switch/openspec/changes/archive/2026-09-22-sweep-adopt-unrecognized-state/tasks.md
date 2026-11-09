# Tasks

## 1. Sweep routing implementation

- [x] 1.1 Implement the content-scan predicate for unrecognized entries in `src/launcher/runtime-cleanup.ts`: read the entry's byte content (directories recursed over all members, with size/count limit constants, over-limit counts as undecidable) and search for the absolute path of the containing instance directory. Verification: new unit tests cover "content contains the instance path → judged keep" and "directory over limit → judged keep"
- [x] 1.2 Change `unrecognizedEntries` to produce a disposition per entry (adopt / delete / keep-warn); `sweepEntry` executes: scan negative and no same-named entry in the real agentDir → rename-move into the real agentDir with a notice; same-named entry exists → delete the instance copy (no content comparison) with a notice; otherwise → keep with the original warning. When kept entries exist the directory is kept as a whole, otherwise reclaimed. Entries inside `extensions/` only take the warning branch. Verification: `npm test` passes
- [x] 1.3 Add integration tests for the four new scenarios of the delta spec in `test/launcher.integration.test.ts` (path-referencing kept with warning, conflict-free adoption, same-name conflict deletion with notice, `extensions/` interior warn-only). Verification: the new cases in `npm test` pass

## 2. Validation

- [x] 2.1 Run `npm run check` and `npm test`; all pass

## 3. Documentation sync

- [x] 3.1 Add `docs/adr/0012-conditional-sweep-adoption.md`: records scan-gated conditional adoption and real-wins conflict deletion, explaining why it does not overturn ADR-0010's "absorb on reclaim" rejection. Verification: the file exists and references ADR-0010 per the ADR numbering convention
- [x] 3.2 Update the instance sweep section of `docs/architecture/overview.md`, syncing the routing criteria and destinations (link ADR-0012, do not restate the reasoning). Verification: the section is consistent with `openspec/specs/launcher/spec.md` (post-archive)
- [x] 3.3 Add an "adoption" entry to the internal glossary of `CONTEXT.md`. Verification: the glossary contains the entry and no avoid-words
