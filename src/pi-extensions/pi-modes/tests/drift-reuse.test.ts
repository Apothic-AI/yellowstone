import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fingerprintsForKeys, loadModes, resolveModeSelection } from "../src/modes.ts";

const APPROVED = "the fleet contract";
const CHANGED = "a different contract";

function modeFile(prompt: string): string {
  return JSON.stringify({
    schemaVersion: 2, key: "leader", label: "Leader", description: "d",
    promptStrategy: "replace_base", systemPrompt: prompt,
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-reuse-"));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const globalDir = join(root, "global");
  const projectDir = join(root, "space", ".pi", "modes");
  const file = join(globalDir, "leader.json");
  return { root, globalDir, projectDir, file };
}

function load(f: { globalDir: string; projectDir: string }) {
  return loadModes({ globalDir: f.globalDir, projectDir: f.projectDir, projectTrusted: true }).modes;
}

function writeMode(file: string, text: string): void {
  mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  writeFileSync(file, text);
}

test("reuse composes from the approved snapshot when the file drifts", () => {
  const f = fixture();
  writeMode(f.file, modeFile(APPROVED));
  const approvedModes = load(f);
  const selection = { baseKey: "leader", overlayKeys: [] as string[] };

  // The clean composition records the snapshot.
  const clean = resolveModeSelection(selection, approvedModes, {
    fingerprints: fingerprintsForKeys(["leader"], approvedModes),
    driftPolicy: "reuse",
  });
  assert.equal(clean.blocked, false);
  assert.equal(clean.base?.systemPrompt, APPROVED);

  // The file changes under the lane; the recorded digest stays the old one.
  writeFileSync(f.file, modeFile(CHANGED));
  const driftedModes = load(f);
  const reused = resolveModeSelection(selection, driftedModes, {
    fingerprints: fingerprintsForKeys(["leader"], approvedModes),
    driftPolicy: "reuse",
  });
  assert.equal(reused.blocked, false, "a verified snapshot is what reuse exists for");
  assert.equal(reused.base?.systemPrompt, APPROVED, "the approved text, not the changed file");
  const marker = reused.diagnostics.find((d) => (d.message ?? "").includes("first seen at"));
  assert.ok(marker, "the answer names when the composition was first seen clean");
  assert.ok(
    (marker?.message ?? "").includes(f.file),
    "and it names the file that changed, which is the fact a reader needs",
  );
});

test("reuse without a verified snapshot blocks with the reason, never the native prompt", () => {
  const f = fixture();
  writeMode(f.file, modeFile(APPROVED));
  const approvedModes = load(f);
  const fingerprints = fingerprintsForKeys(["leader"], approvedModes);
  writeFileSync(f.file, modeFile(CHANGED));
  const driftedModes = load(f);
  const emptyAgent = mkdtempSync(join(tmpdir(), "pi-modes-noagent-"));
  process.env.PI_CODING_AGENT_DIR = emptyAgent;
  const result = resolveModeSelection({ baseKey: "leader", overlayKeys: [] }, driftedModes, {
    fingerprints,
    driftPolicy: "reuse",
  });
  assert.equal(result.blocked, true);
  assert.ok(result.diagnostics.some((d) => (d.message ?? "").includes("no verified snapshot")));
  rmSync(emptyAgent, { recursive: true, force: true });
});
