# Conditional adoption with scan gating and real-wins conflict deletion

For the instance lifecycle, see [ADR-0010](0010-per-launch-instance-lifecycle.md); this file records only the startup sweep's disposition of unrecognized entries.

## Context

ADR-0010 made the sweep uniformly "keep + warn" for unrecognized entries: not one byte of third-party state is touched, at the cost of dead directories and the burden of manual moves recurring on every launch. Extensions writing files inside the instance is an observed fact (pi-mcp-adapter's `mcp-cache.json`), and records such as pi-subagents' ledger embedding instance absolute paths (`recordPath`, `ownerSessionId`, artifact paths) are also facts — moving them makes them stale, which is why ADR-0010 rejected "absorb on reclaim". But that rejection targeted the *unconditional* version: it objected to moving without looking at content, not to moving itself. "Does an entry care where it lives" is mechanically detectable — a byte scan decides it.

## Decision

For each unrecognized entry at the first level of a reclaimable instance directory, the sweep routes by content scan (files and directories share one state machine; directories are recursed over all members):

- The entry's content references the absolute path of its own instance directory, the scan exceeds size/count limits and cannot decide, or the entry is not a regular file/directory → keep + warn, byte-for-byte identical to the status quo.
- Scan negative (content does not reference the instance path, i.e. location-agnostic) and no same-named entry in the real agentDir → rename-move into the real agentDir, with a one-line notice to stderr naming the entry and its destination. After adoption, the next launch turns it into a symlink via mirroring; subsequent writes pass through into the real agentDir and no more warnings appear.
- Scan negative but a same-named entry exists in the real agentDir → delete the instance copy (real wins), with a one-line notice to stderr, without comparing content.

Routing rationale: the mirror's link direction itself expresses "the instance is temporary, the real agentDir is authoritative"; the conflict branch merely extends that hierarchy to the adoption path. Same-name conflicts by construction only trigger in the race window where "the real entry appeared after that instance launched", and the loss cost in that window is explicitly accepted. Both adoption and deletion print a notice to stderr — automatic but visible, staying within ADR-0010's red line of "no silent destruction".

The implementation lives in `src/launcher/runtime-cleanup.ts`: scan limits are internal implementation constants (over-limit means "cannot decide") and never enter user configuration. Unrecognized entries inside the managed `extensions/` directory only take the keep + warn branch and never participate in adoption or deletion.

## Rejected alternatives

**Expanding the seed list.** The list is a prediction of the future and fails silently when an extension changes paths (ADR-0010 rejected the same design). Content scanning holds for all future extensions without prior knowledge.

**Unconditional "absorb on reclaim".** The very design ADR-0010 rejected: records embedding instance paths go stale when moved, and it requires a conflict-merge strategy. This decision does not overturn that rejection — the scan gate preserves exactly what the rejection protected.

**Comparing content on both sides before deciding adoption or deletion.** A byte comparison answers "are the two copies identical", while adoption safety depends on "does the entry care where it lives" — a different question; identical content deleted is no loss, and divergent cases only fall in the race window above.

**Keep + warn on divergence.** Returning a branch with an explicit trade-off rule to manual handling would make the warning recur on every launch — precisely the annoyance this change eliminates.

## Consequences

- Scan false negatives (paths hidden by gzip, URL encoding, etc.) can wrongly adopt path-embedding records. The consequence ceiling equals the user manually running `mv` per the current warning text — not a new category of harm; mitigation is full byte scanning within limits plus keep-on-overflow.
- The conflict window is wider than "two instances launching simultaneously": for any instance launched before the real entry appeared, its private copy is deleted at the next sweep after its death.
- Recursive directory scanning adds startup I/O: it applies only to dead directories that would have been warned about anyway (a rare path), and limits keep it bounded.
- Adoption rename can fail across devices: the instance root and the real agentDir both live under `$HOME`, so it works normally; failure degrades best-effort into keep + warn and does not block startup.

## Related

Behavior contract: "Stale instance sweep" in `openspec/specs/launcher/spec.md`; implementation mechanism: "Instance sweep" in `docs/architecture/overview.md`.
