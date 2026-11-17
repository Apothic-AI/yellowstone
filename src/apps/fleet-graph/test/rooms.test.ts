import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLaneMessages, readRoomsIndex } from "../src/server/rooms.ts";

function fixture(): string {
  const base = mkdtempSync(join(tmpdir(), "fleet-graph-rooms-"));
  mkdirSync(join(base, "registry"), { recursive: true });
  mkdirSync(join(base, "rooms", "r1"), { recursive: true });
  mkdirSync(join(base, "inbox", "alpha", "read"), { recursive: true });
  mkdirSync(join(base, "inbox", "operator"), { recursive: true });
  writeFileSync(join(base, "names.json"), JSON.stringify({ pins: { "pane:w1:p1": { name: "alpha" } } }));
  writeFileSync(join(base, "registry", "alpha.json"), JSON.stringify({ name: "alpha" }));
  writeFileSync(join(base, "registry", "operator.json"), JSON.stringify({ name: "operator" }));
  writeFileSync(join(base, "rooms", "r1", "room.json"), JSON.stringify({ name: "r1", members: ["alpha", "operator"], createdAt: "2026-01-01T00:00:00Z" }));
  writeFileSync(
    join(base, "rooms", "r1", "log.jsonl"),
    [
      JSON.stringify({ id: "room-1", from: "alpha", text: "room hello", sentAt: "2026-01-01T00:00:03Z", recipients: ["operator"] }),
      JSON.stringify({ id: "room-2", from: "beta", text: "not involved", sentAt: "2026-01-01T00:00:04Z", recipients: ["operator"] })
    ].join("\n")
  );
  writeFileSync(
    join(base, "inbox", "alpha", "read", "1.json"),
    JSON.stringify({ id: "dm-1", from: "operator", to: ["alpha"], text: "hello alpha", sentAt: "2026-01-01T00:00:01Z" })
  );
  writeFileSync(
    join(base, "inbox", "operator", "2.json"),
    JSON.stringify({ id: "dm-2", from: "alpha", to: ["operator"], text: "hello operator", sentAt: "2026-01-01T00:00:02Z" })
  );
  writeFileSync(
    join(base, "inbox", "operator", "3.json"),
    JSON.stringify({ id: "dm-3", from: "beta", to: ["operator"], text: "noise", sentAt: "2026-01-01T00:00:05Z" })
  );
  return base;
}

test("the index reads rooms, members and names", () => {
  const index = readRoomsIndex(fixture());
  assert.equal(index.available, true);
  assert.deepEqual(index.names, ["alpha", "operator"]);
  assert.equal(index.rooms.length, 1);
  assert.deepEqual(index.rooms[0].members, ["alpha", "operator"]);
});

test("lane messages are the operator thread plus shared-room speech, nothing else", () => {
  const base = fixture();
  const result = readLaneMessages("alpha", { base, operator: "operator" });
  assert.equal(result.available, true);
  assert.equal(result.identity, "pane:w1:p1");
  assert.deepEqual(result.rooms, ["r1"]);
  assert.deepEqual(result.messages.map((m) => m.id), ["dm-1", "dm-2", "room-1"]);
  assert.equal(result.messages[0].source, "dm");
  assert.equal(result.messages[2].source, "room");
  assert.equal(result.messages[2].room, "r1");
});

test("a missing store is reported, not thrown", () => {
  const result = readLaneMessages("alpha", { base: join(tmpdir(), "does-not-exist-fleet-graph"), operator: "operator" });
  assert.equal(result.available, false);
  assert.ok(result.error);
  assert.deepEqual(result.messages, []);
});
