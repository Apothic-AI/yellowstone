import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { createWriteAuthorizer, type LaneIdentity } from "../src/write-authorization.js";

/**
 * FT-89, authorization: who may command whose queue. Each case asserts the exact
 * refusal code, because "refused" without a reason is what makes a leader retry
 * something that will never succeed or blame itself for a rule it did not break.
 */

const worker: LaneIdentity = {
  sessionId: "s-worker",
  sessionPath: "/tmp/w.jsonl",
  lane: "yellowstone-worker",
  mode: "worker",
  workspaceId: "w17",
};

function authorizer(caller: LaneIdentity | null, target: LaneIdentity = worker) {
  return createWriteAuthorizer({ target, source: { resolveCaller: () => caller } });
}

function codeOf(a: { authorize(r: Record<string, unknown>): unknown }) {
  const decision = a.authorize({ op: "remove", id: "g1" }) as { ok: boolean; refusal?: { code: string } };
  return decision.ok ? "ALLOWED" : decision.refusal?.code;
}

describe("who may write a worker's queue", () => {
  test("a leader in the same workspace is allowed", () => {
    assert.equal(
      codeOf(authorizer({ ...worker, sessionId: "s-leader", lane: "yellowstone-leader", mode: "leader" })),
      "ALLOWED",
    );
  });

  test("an unresolvable caller is refused, and the code says so", () => {
    assert.equal(codeOf(authorizer(null)), "caller_unresolved");
  });

  test("a worker may not command another worker", () => {
    assert.equal(codeOf(authorizer({ ...worker, sessionId: "s-other" })), "caller_role_not_leader");
  });

  test("a leader in another workspace is not this worker's leader", () => {
    assert.equal(
      codeOf(
        authorizer({
          ...worker,
          sessionId: "s-leader",
          lane: "other-leader",
          mode: "leader",
          workspaceId: "w25",
        }),
      ),
      "not_my_worker",
    );
  });

  test("a leader with no workspace record cannot claim a worker by omission", () => {
    assert.equal(
      codeOf(authorizer({ ...worker, sessionId: "s-leader", lane: "l", mode: "leader", workspaceId: null })),
      "not_my_worker",
    );
  });

  test("a lane addressing itself is allowed — its own queue is its own business", () => {
    assert.equal(codeOf(authorizer({ ...worker, mode: "worker" })), "ALLOWED");
  });

  test("a worker target whose record says leader is not writable from outside", () => {
    assert.equal(
      codeOf(
        authorizer(
          { ...worker, sessionId: "s-leader", lane: "l", mode: "leader" },
          { ...worker, mode: "leader" },
        ),
      ),
      "target_role_not_worker",
    );
  });
});
