// write-deferrals.ts — FT-89: a write that cannot land yet, and the record of what happened to it.
//
// A leader may edit a queue while the worker is mid-turn. Applying that mid-turn would
// move the queue under a running turn; refusing outright loses a legitimate edit. So the
// request is deferred to the worker's settled boundary, and the caller gets a token it can
// look up.
//
// Three properties make a deferral honest rather than a silent drop: it is queryable (a
// token and an answer for it); it is bounded (a worker killed mid-turn never settles, so a
// deferral expires to target_gone instead of sitting at "deferred" forever); and it carries
// observations rather than inferences (the last-seen queue and when that reading was taken,
// so a caller reading an outcome later can tell expired from applied).

export type DeferralState = "deferred" | "applied" | "target_gone";

export interface DeferralRecord {
  token: string;
  state: DeferralState;
  requestedAt: number;
  updatedAt: number;
  /** The queue as the receiver last saw it, and when that reading was taken. */
  lastSeenOrder: string[] | null;
  lastSeenAt: number | null;
  op: string;
  targetId: string | null;
  /** The rest of the write, so it can be replayed at the boundary exactly as it
   *  was asked for. A record that stores only the op cannot apply an edit. */
  objective?: string;
  index?: number;
}

export interface DeferralStore {
  defer(input: {
    token: string;
    op: string;
    targetId: string | null;
    objective?: string;
    index?: number;
    order: string[];
    now: number;
  }): DeferralRecord;
  status(token: string): DeferralRecord | null;
  settle(token: string, now: number): DeferralRecord | null;
  expire(now: number): DeferralRecord[];
  pending(): DeferralRecord[];
}

export const DEFAULT_DEFERRAL_TTL_MS = 15 * 60 * 1000;

export function createDeferralStore(ttlMs: number = DEFAULT_DEFERRAL_TTL_MS): DeferralStore {
  const records = new Map<string, DeferralRecord>();
  return {
    defer(input) {
      const record: DeferralRecord = {
        token: input.token,
        state: "deferred",
        requestedAt: input.now,
        updatedAt: input.now,
        lastSeenOrder: [...input.order],
        lastSeenAt: input.now,
        op: input.op,
        targetId: input.targetId,
        objective: input.objective,
        index: input.index,
      };
      records.set(input.token, record);
      return record;
    },
    status(token) {
      return records.get(token) ?? null;
    },
    settle(token, now) {
      const record = records.get(token);
      if (!record || record.state !== "deferred") return record ?? null;
      record.state = "applied";
      record.updatedAt = now;
      return record;
    },
    expire(now) {
      const expired: DeferralRecord[] = [];
      for (const record of records.values()) {
        if (record.state !== "deferred") continue;
        if (now - record.requestedAt < ttlMs) continue;
        record.state = "target_gone";
        record.updatedAt = now;
        expired.push(record);
      }
      return expired;
    },
    pending() {
      return [...records.values()].filter((record) => record.state === "deferred");
    },
  };
}
