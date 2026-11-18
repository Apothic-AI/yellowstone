import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { createDeferralStore, DEFAULT_DEFERRAL_TTL_MS } from "../src/write-deferrals.js";

/**
 * FT-89: a deferral that cannot be looked up is a silent drop, and one that never
 * expires hangs the caller question forever. Both are tested as behaviour.
 */

const T0 = 1_000_000;

function store(ttl = 1000) {
  return createDeferralStore(ttl);
}

describe("a deferral is queryable", () => {
  test("a token answers with its state and the observation it was based on", () => {
    const s = store();
    s.defer({ token: "t1", op: "edit", targetId: "g2", order: ["g1", "g2"], now: T0 });
    const record = s.status("t1");
    assert.equal(record?.state, "deferred");
    assert.deepEqual(record?.lastSeenOrder, ["g1", "g2"]);
    assert.equal(record?.lastSeenAt, T0, "the reading carries when it was taken");
  });

  test("an unknown token is null, not a fabricated pending state", () => {
    assert.equal(store().status("never-issued"), null);
  });

  test("settling moves it to applied exactly once", () => {
    const s = store();
    s.defer({ token: "t1", op: "add", targetId: null, order: [], now: T0 });
    assert.equal(s.settle("t1", T0 + 10)?.state, "applied");
    assert.equal(s.settle("t1", T0 + 20)?.state, "applied", "settling again does not rewrite history");
    assert.equal(s.pending().length, 0);
  });
});

describe("a deferral is bounded", () => {
  test("a worker that never settles expires to target_gone, keeping the last seen state", () => {
    const s = store(1000);
    s.defer({ token: "t1", op: "remove", targetId: "g1", order: ["g1", "g2"], now: T0 });
    assert.deepEqual(s.expire(T0 + 999), [], "not yet: the lifetime is the bound");
    assert.equal(s.expire(T0 + 1000).length, 1);
    const record = s.status("t1");
    assert.equal(record?.state, "target_gone");
    assert.deepEqual(record?.lastSeenOrder, ["g1", "g2"]);
    assert.equal(record?.lastSeenAt, T0, "when it was last seen, so expired is distinguishable from never seen");
  });

  test("an applied deferral is not expired later", () => {
    const s = store(1000);
    s.defer({ token: "t1", op: "add", targetId: null, order: [], now: T0 });
    s.settle("t1", T0 + 5);
    assert.deepEqual(s.expire(T0 + 5000), []);
    assert.equal(s.status("t1")?.state, "applied", "a landed write is never reported as a lost one");
  });

  test("the default lifetime is a stated number, not an accident", () => {
    assert.equal(DEFAULT_DEFERRAL_TTL_MS, 15 * 60 * 1000);
  });
});
