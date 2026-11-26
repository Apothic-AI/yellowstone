# pi-rooms receipt 654e01a8 — the state before repair

**What this is.** `receipts/654e01a8-0718-4127-b5f5-7dad83b98d3b.json` as it stood *before* I
repaired it on 2026-11-02 14:04 EST. Message `654e01a8` was sent by `overlord` to
`[assistant-leader, self-improvement-leader]` at `18:46:34.893Z`.

**What it shows.** assistant-leader's entry carries `deliveredAt: 18:46:34.945Z`; mine carries
`queuedAt` only. My own archived copy in `inbox/self-improvement-leader/read/` carried
`deliveredAt: 18:46:34.944Z` — so the delivery happened and the receipt lost it, 1 ms apart
from the other recipient's write.

**Why the live file no longer shows this.** I wrote the missing stamp into the receipt from the
archive at 19:04Z, which is why its mtime is ~18 minutes after the stamps. That repair is what
destroyed the evidence in place; this copy is the record of the shape beforehand.

**Why it matters.** `recordReceipt` (`src/store.ts:478-495`) is an unlocked read-modify-write
that reconstructs each per-recipient object, so two deliveries in the same window clobber each
other. The consequence is permanent and silent: the sender sees `queued` forever. Cleaner
examples, where the archive witness survives and the receipt does not, are `163e305c-8c89-49e3-9a24-d1e81690ba40`
and `2dce133f-f2c8-4567-a819-bdf8a2abd28f`.

**Rule this cost us.** Copy an artifact aside before fixing it. Repairing a record destroys the
evidence for the thing it recorded.
