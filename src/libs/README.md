# src/libs is empty, and that is a measurement

FT-01's layout names `src/libs` for shared libraries. There is nothing to put in it, and this
file exists so the absence reads as a decision rather than an unfinished directory.

Measured 2026-11-08 across **all 90 `package.json` files under `src/`**:

- **13** dependencies use an unpublished spec (`file:`, `workspace:`, `link:`, `portal:`, `git+`).
  Every one of them resolves to a **sibling inside its own subrepo** — for example
  `@tryinget/pi-little-helpers@file:../pi-little-helpers`, declared by
  `src/pi-extensions/tryinget/packages/pi-agent-registry`. Nothing crosses a repo boundary.
- Every cross-repo scoped dependency (`@signalridge/pi-ui`, `@signalridge/pi-approval-core`,
  `@signalridge/pi-subagents-protocol`, `@tryinget/pi-peer-messaging`, …) is a **published
  version range**, which is a declared ref, not a subrepo.

So no library qualifies today. The test for a future member is the same one that was applied
here: **a dependency that no registry can serve and that more than one subrepo needs.** A
dependency inside a single subrepo belongs to that subrepo, and a published package belongs to
the registry — neither belongs here.

Decision record: `~/Documents/Fleet/pi-fleet-model/FT-01-LEAD-DECISIONS.md` (D8, and the
"`src/libs` is empty by measurement" entry).
