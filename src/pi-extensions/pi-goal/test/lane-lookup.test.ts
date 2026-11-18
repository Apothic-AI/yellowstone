import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";

import { createLaneLookup } from "../src/lane-lookup.js";

/**
 * FT-89: the adapter that turns the fleet's records into the caller's identity.
 * The interesting cases are the absences — a missing record, a malformed file, a
 * lane with no role record — because each of them must leave the caller
 * unresolved rather than resolved as something convenient.
 */

let base = "";

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ft89-lane-lookup-"));
  mkdirSync(join(base, "sessions"), { recursive: true });
  mkdirSync(join(base, "roles"), { recursive: true });
  writeFileSync(
    join(base, "sessions", "yellowstone-leader.json"),
    JSON.stringify({ lane: "yellowstone-leader", sessionId: "s-1", workspaceId: "w17" }),
  );
  writeFileSync(join(base, "roles", "yellowstone-leader.env"), "PI_MODE=leader PI_PROFILE=leader\n");
  writeFileSync(
    join(base, "sessions", "yellowstone-worker.json"),
    JSON.stringify({ lane: "yellowstone-worker", sessionId: "s-2", workspaceId: "w17" }),
  );
  writeFileSync(join(base, "roles", "yellowstone-worker.env"), "PI_MODE=worker\n");
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("reading a caller out of the fleet records", () => {
  test("a session id resolves to its lane and workspace", () => {
    const lookup = createLaneLookup(base);
    assert.deepEqual(lookup.bySessionId("s-1"), {
      lane: "yellowstone-leader",
      sessionId: "s-1",
      workspaceId: "w17",
    });
  });

  test("an unknown session id is null, not a nearest match", () => {
    assert.equal(createLaneLookup(base).bySessionId("s-unknown"), null);
  });

  test("the mode comes from the lane's own role record", () => {
    const lookup = createLaneLookup(base);
    assert.equal(lookup.modeOf("yellowstone-leader"), "leader");
    assert.equal(lookup.modeOf("yellowstone-worker"), "worker");
  });

  test("a lane with no role record has no mode, so the caller stays unresolved", () => {
    assert.equal(createLaneLookup(base).modeOf("ghost-lane"), null);
  });

  test("a malformed session record is skipped rather than guessed at", () => {
    writeFileSync(join(base, "sessions", "broken.json"), "{ not json");
    const lookup = createLaneLookup(base);
    assert.equal(lookup.bySessionId("s-broken"), null);
    assert.ok(lookup.bySessionId("s-1"), "the good records still resolve");
  });

  test("a missing records directory is an absence, not a throw", () => {
    const empty = mkdtempSync(join(tmpdir(), "ft89-empty-"));
    try {
      assert.equal(createLaneLookup(empty).bySessionId("s-1"), null);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
