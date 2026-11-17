import test from "node:test";
import assert from "node:assert/strict";
import { relativeTime, statusClass, titleClamp } from "../src/shared/format.ts";

test("relativeTime is stable against a fixed now", () => {
  const now = Date.parse("2026-11-17T12:00:00Z");
  assert.equal(relativeTime("2026-11-17T11:59:30Z", now), "30s ago");
  assert.equal(relativeTime("2026-11-17T11:30:00Z", now), "30m ago");
  assert.equal(relativeTime("2026-11-17T05:00:00Z", now), "7h ago");
  assert.equal(relativeTime("2026-11-10T12:00:00Z", now), "7d ago");
  assert.equal(relativeTime(null, now), "—");
  assert.equal(relativeTime("not-a-date", now), "—");
});

test("statusClass maps herdr statuses to the legend's vocabulary", () => {
  assert.equal(statusClass("working"), "working");
  assert.equal(statusClass("IDLE"), "idle");
  assert.equal(statusClass("done"), "done");
  assert.equal(statusClass("blocked"), "blocked");
  assert.equal(statusClass("weird"), "unknown");
  assert.equal(statusClass(null), "unknown");
});

test("titleClamp cuts on the boundary and marks the cut", () => {
  assert.equal(titleClamp("abc", 10), "abc");
  assert.equal(titleClamp("abcdefghij", 10), "abcdefghij");
  assert.equal(titleClamp("abcdefghijk", 10), "abcdefghi…");
});
