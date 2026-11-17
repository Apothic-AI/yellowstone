# Fleet Graph

A read-only flow graph of the Pi fleet: one **Fleet View** over herdr workspaces and lanes,
one **Work View** over beads, wired together by the lane→bead join.

Built for FT-74 (`Documents/Assistant/Fleet TODOs.md`) from the investigation at
`~/.local/state/si-ft74/REPORT.md`. Toolchain: SolidJS · Vike · Vite · pnpm.

## Run it

```sh
pnpm install
pnpm dev            # http://localhost:5174
pnpm test           # units for beads, layout, roles, rooms, fleet, sessions
pnpm typecheck
pnpm build && pnpm preview
pnpm verify:live    # starts the server, curls /api/state, renders both routes in headless Chrome
```

The app renders a shell immediately; the first data read walks every lane's session (behold) and
can take several seconds. A source that fails is reported in the top-bar health panel and the rest
of the document still renders.

## What it reads (and never writes)

| Source | Command / path | Used for |
|---|---|---|
| beads | `bd list --json --all -n 0 --brief` (cwd: `~/Documents/Fleet`) | work items, projects, dependencies, assignee |
| herdr | `herdr api snapshot` | workspaces, lanes, status, cwd |
| behold | `behold roster --json` | session id/path, pid, model, context %, rooms name, role fallback |
| pil role records | `~/.local/state/pil/roles/<lane>.env` | role (`PI_MODE`) and parent (`PI_SPAWNED_BY`) |
| pi-rooms | `~/.pi/agent/rooms/**` | operator ⇄ lane DM history and shared rooms (read-only) |
| yellowstone | `src/**/.gitrepo` | the 17+ subrepo components |

There is **no write route**. The HTTP surface is `GET /api/state`, `GET /api/lane/<name>/messages`,
`GET /api/health`, mounted as Vite middleware so dev and preview serve identical code.

## Views

**Fleet View** — one swimlane per herdr workspace. Each leader lane is a root; its workers branch
to the right. A recorded parent (`PI_SPAWNED_BY`) draws a solid edge; an inferred one draws a
dashed amber edge and the card says `derived edge`. Workers with no parent at all get a dotted
stub. Every lane card carries: role chip, status + sequence, model, context bar, last activity, and
three actions — open Work View for that lane, open the bead-card drawer, open the read-only DM
modal.

**Work View** — one swimlane per `project:<workspace-id>` label. Roots are epics, milestones and
unparented items; items branch right. x is dependency depth (parent and `blocks` edges), evenly
spaced. y is grouped under the owning root and sorted by `updated_at` descending, so the latest
activity rises to the top. Clicking a bead opens its detail panel; `?lane=<name>` from the Fleet
View highlights every bead joined to that lane.

## The three gaps FT-74 named, and how v1 handles them

1. **Worker → leader parentage (G1).** `pil` now records `PI_SPAWNED_BY=<leader-lane>` in the
   lane's role record at spawn (see `yellowstone: home/.overlord/bin/pil`), restores it on
   relaunch, and `spawn-lane --spawned-by` passes it (defaulting to the caller's own
   `PI_ROOMS_NAME`). Behold exposes it as **L-2**. Lanes that predate the record show a
   *derived* edge when their workspace has exactly one leader, and are never presented as a
   record. Backfill of history is impossible, by design.
2. **Bead → lane join (G2).** The authoritative join is `assignee` (`bd assign <id> <lane>`).
   Only nine beads carry one. For the rest, the app derives an attribution by scanning the tail
   of each lane's recorded session for `bd` commands naming a bead; those cards are labelled
   `derived` in both views and are never merged into `assignee`. The pending operator decision
   is whether claiming a bead *requires* `bd assign` (see FT-74 in the TODOs doc).
3. **Rooms reader (G5).** The app reads the pi-rooms store directly (registry, inbox, room
   metadata, `log.jsonl`) and renders the operator ⇄ lane thread plus shared-room speech.
   Read-only: sending stays with `rooms_dm` in a live lane; the modal shows a copyable send
   snippet instead of a second send path.

## Known limits

* Derive-on-demand, not live: the client polls every 5 s; nothing pushes.
* Beads without a `project:` label land in an `unlabelled` lane.
* `subrepo:<name>` labels do not exist yet, so the components list is informational, not graph
  roots — that mapping is an open FT-74 decision.
* Sessions older than the role-record change have no parent; the derived edge states that.
