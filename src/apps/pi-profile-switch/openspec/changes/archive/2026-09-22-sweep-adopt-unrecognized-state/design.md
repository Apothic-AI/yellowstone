# Design

## Context

Status quo and motivation in proposal.md. Only the constraints shaping the design are listed here:

- ADR-0010 rejected unconditional "absorb on reclaim": third-party records such as pi-subagents' ledger embed instance absolute paths (`recordPath`, `ownerSessionId`, artifact paths), and moving them makes them stale. The rejection targeted "unconditional", not "moving".
- The observed case `mcp-cache.json` (pi-mcp-adapter's cross-session persistent cache, 7-day TTL) was confirmed by byte scan to not contain its own instance path — whether a path is embedded is mechanically detectable.
- Mirroring creates a symlink for every name already present in the real agentDir, so "the real agentDir has a same-named entry while the instance holds a physical one" can by construction only mean: the real entry appeared after that instance launched (concurrent instances, a native pi run, or an earlier sweep in the same run adopting a same-named entry from a sibling instance).
- The sweep runs on the startup path, best-effort; no failure may block startup.

## Goals / Non-Goals

**Goals:**

- Location-agnostic unrecognized state converges with zero manual work: adopted once, turned into a symlink by mirroring on the next launch, and subsequent writes pass through into the real agentDir — no more warnings.
- Records embedding instance paths keep ADR-0010's protection: keep + warn, not one byte touched.
- Files and directories share one routing state machine.

**Non-Goals:**

- No conflict merging: the trade-off rule between two trees/two contents is exactly "the real agentDir wins"; no merge strategy (ADR-0010's merge-strategy concern about absorption is explicitly landed here as "no merging").
- No content comparison between the two sides: the conflict branch deletes the instance copy directly.
- Unfamiliar entries inside the managed `extensions/` directory do not participate in adoption; warn-only stays.
- No changes to the seed list, mirroring logic, pid liveness determination, or the grace period.

## Decisions

### Routing criterion: whether the content references its own instance's path

For each unrecognized entry at the first level of a reclaimable directory (unconventional types such as socket/fifo are kept and warned about directly), read its byte content (directories recursed over all members) and search for the instance directory's absolute path string. Found → keep + warn; not found → route by whether the real agentDir has a same-named entry. The scan has size/count limits; over-limit counts as undecidable and goes to keep + warn — when it cannot be judged, it is not touched, consistent with ADR-0010's conservative stance.

Chosen over a list: a list is a prediction of the future and silently fails when an extension renames things (rejected by ADR-0010); content scanning holds for all future extensions without prior knowledge. Chosen over content comparison: a two-side diff answers "are the two copies identical", while adoption safety depends on "does the entry care where it lives" — a different question.

ADR required: conditional-sweep-adoption

### Conflict branch: real wins, direct deletion, no comparison

When the real agentDir already has a same-named entry, the instance copy is deleted. Basis: the instance is temporary and the real agentDir is authoritative — the mirror's link direction itself expresses that hierarchy, and the conflict branch merely extends it to the adoption path. The only thing a byte comparison buys is "peace of mind when identical", but identical content deleted is no loss; divergent cases are confined to the race window above, whose loss cost was explicitly accepted in the proposal.

Rejected alternative: keep + warn on divergence — returning a branch with an explicit trade-off rule to manual handling would make the warning recur on every launch, precisely the annoyance this change eliminates.

### One state machine for files and directories

Adoption is the same rename for both; the scan predicate is identical, directories just recurse (cost bounded by the limits). Keeping + warning on directory conflicts was considered (a directory conflict loses a member diff, not a version diff); conclusion: no forking — the conflict window is equally rare for both shapes, the loss cost is accepted, and one more branch would only leave a rare case to rot inside a warning.

### Visible automation, never silent

Adoption and deletion each print a one-line notice to stderr (naming the entry and its destination or deletion reason). ADR-0010's red line is "silent destruction"; automatic but visible disposition does not cross it.

### Implementation placement

`src/launcher/runtime-cleanup.ts`: `unrecognizedEntries` changes from "collect unfamiliar names" to "produce a disposition per entry (adopt / delete / keep-warn)", and `sweepEntry` executes the disposition and decides whether to reclaim the directory. Scan limits are internal implementation constants and never enter user configuration.

## Risks / Trade-offs

- Scan false negatives (paths hidden by gzip, URL encoding, etc.) → path-embedding records get wrongly adopted. The consequence ceiling equals the user manually running `mv` per the current warning text — not a new category of harm; mitigation is full byte scanning within limits plus keep-on-overflow.
- The conflict window is wider than "two instances launching simultaneously": for any instance launched before the real entry appeared, its private copy is deleted at the next sweep after its death. Recorded as an accepted cost.
- Recursive directory scanning adds startup I/O: applies only to dead directories that would have been warned about anyway (a rare path), and limits keep it bounded.
- Adoption moves can hit cross-device issues: the instance root and the real agentDir both live under `$HOME`, so rename works; failure degrades best-effort into a warning and does not block startup.

## Open Questions

- The concrete scan-limit values (total bytes / member file count) will be set at implementation time based on common extension-state sizes; the spec only stipulates "over-limit means undecidable, keep and warn" — the values affect neither the behavior contract nor the task breakdown.
