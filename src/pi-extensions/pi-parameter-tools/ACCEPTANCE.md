# FT-89 acceptance — resolved source snapshot

This acceptance record is committed with the FT-89 source snapshot carried by this tree.
It makes the provenance reproducible from a fresh Yellowstone clone; the earlier acceptance
record lived only under `~/.local/state` and was not sufficient for the landing gate.

## Accepted source

- Landing base: `bcd33c755`
- Receiver/action-registry fixes: `0d8ab3c6b`, `8348c0552`
- `src/index.ts` SHA-256: `e8e96de0f7f358ce771efe66fbf030fea06f0addfb83cecccb3a4869211cd112`
- `src/receiver.ts` SHA-256: `11ff6ca771b6db967d9883128c9c1f0952a8a80c813eb29582e9ba73d9ffd7ea`

## Measured acceptance

The two-lane run recorded in the owner acceptance evidence measured:

- `goal.read` answered from the worker runtime with active goal and queue order.
- Mid-turn writes deferred to `agent_settled`, then applied and visible in the worker's own session record.
- Idle direct writes appended to the queue tail without reordering.
- Stale conflicting writes refused with `stale_queue` and `{expected: 9, current: 1}`.
- Cross-workspace writes refused with `not_my_worker` and caller/target workspace details.
- Idle `defer:true` writes applied immediately with the explicit idle note.
- Queue order returned on every successful mutation.

The owner acceptance run recorded `npm run check` as **114 pass, 0 fail** for this FT-89
snapshot. Live target-gone expiry and one end-to-end refused deferred outcome remain covered by
unit tests rather than claimed as live evidence.

## Future snapshots

FT-89 is accepted for this source snapshot only. Future `goal.write` work must receive a new
reviewed acceptance and update these digests and the landing gate again; this record does not
pre-approve later changes.
