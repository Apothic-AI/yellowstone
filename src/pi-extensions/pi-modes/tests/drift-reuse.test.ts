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

function overlayFile(key: string, prompt: string): string {
  return JSON.stringify({
    schemaVersion: 2, key, label: key, description: "o",
    promptStrategy: "append", systemPrompt: prompt,
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

test("a drifted key with no verified snapshot is withheld, and everything else still composes", () => {
  // The requirement changed: a drifted definition is *the part that drifted*, so drift may never
  // drop the whole composition and fall back to the native prompt. This assertion used to say
  // `blocked: true`, which was exactly the failure the operator rejected.
  const f = fixture();
  writeMode(f.file, modeFile(APPROVED));
  writeMode(join(f.globalDir, "extra.json"), overlayFile("extra", "the overlay text"));
  const approvedModes = load(f);
  const fingerprints = fingerprintsForKeys(["leader", "extra"], approvedModes);
  writeFileSync(f.file, modeFile(CHANGED));
  const driftedModes = load(f);
  const emptyAgent = mkdtempSync(join(tmpdir(), "pi-modes-noagent-"));
  process.env.PI_CODING_AGENT_DIR = emptyAgent; // no snapshot exists here
  const result = resolveModeSelection({ baseKey: "leader", overlayKeys: ["extra"] }, driftedModes, {
    fingerprints,
    driftPolicy: "reuse",
  });
  assert.equal(result.blocked, false, "drift never drops the whole composition");
  assert.equal(result.base, undefined, "the drifted definition is the only part withheld");
  assert.deepEqual(
    result.overlays.map((overlay) => overlay.key),
    ["extra"],
    "the rest of the composition is unaffected",
  );
  assert.ok(
    result.diagnostics.some((d) => (d.message ?? "").includes("no verified snapshot")),
    "and the reason is named rather than guessed",
  );
  rmSync(emptyAgent, { recursive: true, force: true });
});

test("block withholds only the drifted key; the rest of the composition is unaffected", () => {
  const f = fixture();
  writeMode(f.file, modeFile(APPROVED));
  const extraPath = join(f.globalDir, "extra.json");
  writeMode(extraPath, overlayFile("extra", "overlay v1"));
  const approvedModes = load(f);
  const fingerprints = fingerprintsForKeys(["leader", "extra"], approvedModes);
  writeFileSync(extraPath, overlayFile("extra", "overlay v2"));
  const driftedModes = load(f);
  const result = resolveModeSelection({ baseKey: "leader", overlayKeys: ["extra"] }, driftedModes, {
    fingerprints,
    driftPolicy: "block",
  });
  assert.equal(result.blocked, false, "block no longer drops the whole composition");
  assert.equal(result.base?.systemPrompt, APPROVED, "an overlay's drift cannot touch the base");
  assert.deepEqual(result.overlays, [], "the drifted overlay is the only part withheld");
  assert.ok(
    result.diagnostics.some((d) => (d.message ?? "").includes("withheld from the composition by the block policy")),
  );
});

test("reuse is the default, so an edited definition keeps the approved text unasked", () => {
  const f = fixture();
  writeMode(f.file, modeFile(APPROVED));
  const approvedModes = load(f);
  const fingerprints = fingerprintsForKeys(["leader"], approvedModes);
  // No driftPolicy: the default has to be the policy that keeps the contract.
  const clean = resolveModeSelection({ baseKey: "leader", overlayKeys: [] }, approvedModes, { fingerprints });
  assert.equal(clean.blocked, false);
  writeFileSync(f.file, modeFile(CHANGED));
  const driftedModes = load(f);
  const result = resolveModeSelection({ baseKey: "leader", overlayKeys: [] }, driftedModes, { fingerprints });
  assert.equal(result.blocked, false, "the default is not block");
  assert.equal(result.base?.systemPrompt, APPROVED, "the approved text, not the edited file");
});
