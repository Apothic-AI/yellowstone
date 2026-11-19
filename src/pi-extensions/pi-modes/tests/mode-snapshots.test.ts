import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { definitionOf, ensureSnapshot, readSnapshot, snapshotPath } from "../src/mode-snapshots.ts";
import { modeDefinitionFingerprint, type ResolvedMode } from "../src/mode-definitions.ts";

function mode(overrides: Partial<ResolvedMode> = {}): ResolvedMode {
  return {
    schemaVersion: 2,
    key: "leader",
    label: "Leader",
    description: "the approved one",
    promptStrategy: "replace_base",
    systemPrompt: "the approved text",
    requires: [],
    conflictsWith: [],
    before: [],
    after: [],
    scope: "global",
    path: "/tmp/modes/leader.json",
    ...overrides,
  } as ResolvedMode;
}

function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-modes-snap-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

test("a clean composition is kept under its own digest, idempotently", () => {
  agentDir();
  const approved = mode();
  const first = ensureSnapshot(approved, "2026-11-19T00:00:00.000Z");
  const second = ensureSnapshot(approved, "2026-11-20T00:00:00.000Z");
  assert.ok(first);
  assert.equal(first, second, "the same composition writes once and then only stats");
  const stat = statSync(first as string);
  assert.equal(stat.mode & 0o777, 0o600, "a snapshot is private to the user");
});

test("a snapshot proves itself: the recorded digest is recomputed from the stored bytes", () => {
  agentDir();
  const approved = mode();
  const digest = modeDefinitionFingerprint({
    schemaVersion: 2, key: approved.key, label: approved.label, description: approved.description,
    promptStrategy: approved.promptStrategy, systemPrompt: approved.systemPrompt,
    requires: [], conflictsWith: [], before: [], after: [],
    scope: approved.scope, path: approved.path,
  }).digest;
  ensureSnapshot(approved, "2026-11-19T00:00:00.000Z");
  const read = readSnapshot("leader", digest);
  assert.equal(read?.definition.systemPrompt, "the approved text");
  assert.equal(read?.firstSeenAt, "2026-11-19T00:00:00.000Z");
});

test("a tampered snapshot is ignored, never used", () => {
  agentDir();
  const approved = mode();
  const path = ensureSnapshot(approved, "2026-11-19T00:00:00.000Z") as string;
  const payload = JSON.parse(readFileSync(path, "utf8"));
  const digest = payload.digest;
  payload.definition.systemPrompt = "something else entirely";
  writeFileSync(path, JSON.stringify(payload));
  assert.equal(readSnapshot("leader", digest), null,
    "text that does not hash to the recorded digest is not the approved composition");
});

test("an unknown digest or missing file is an absence, not a guess", () => {
  agentDir();
  assert.equal(readSnapshot("leader", "0".repeat(64)), null);
  assert.equal(snapshotPath("leader", "abc").includes(".snapshots"), true);
});
