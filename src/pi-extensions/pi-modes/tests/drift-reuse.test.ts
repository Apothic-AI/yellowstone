import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fingerprintsForKeys, loadModes, resolveModeSelection } from "../src/modes.ts";
import { createModeState } from "../src/mode-state.ts";
import { projectApprovalDigest } from "../src/project-mode-approvals.ts";

const PROJECT_V1 = "the approved project half";
const PROJECT_V2 = "an edited project half that was never approved";

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

test("a drifted project half reuses its snapshot even though its approval no longer matches", () => {
  // The live proof found this, and this test is the mechanism written down: editing a project mode
  // file makes isProjectModeApproved false, because the digest it was approved under has changed.
  // The degrade path then replaces the project half with the global fallback and marks the key
  // `substituted` -- and the drift loop skips those keys, so `reuse` was never consulted and the
  // lane silently ran the shallower definition alone. Drift has to be judged before the fallback,
  // because a changed digest is exactly what drift is.
  const f = fixture();
  writeMode(join(f.globalDir, "leader.json"), modeFile(APPROVED));
  const projectFile = join(f.projectDir, "leader.json");
  writeMode(projectFile, overlayFile("leader", PROJECT_V1));
  const composed = load(f);
  const projectMode = composed.find((mode) => mode.scope === "project");
  assert.ok(projectMode, "the project half composes onto the global one");

  const state = createModeState({ baseKey: "leader", overlayKeys: [] }, composed, "command", {
    driftPolicy: "reuse",
  });
  const approvals = new Map([[projectFile, projectApprovalDigest(projectMode)]]);

  const clean = resolveModeSelection({ baseKey: "leader", overlayKeys: [] }, composed, {
    fingerprints: state.fingerprints,
    driftPolicy: "reuse",
    projectApprovals: approvals,
  });
  assert.equal(clean.blocked, false);
  assert.ok(
    clean.base?.systemPrompt?.includes(PROJECT_V1),
    "a clean composition carries the approved project text",
  );

  writeFileSync(projectFile, overlayFile("leader", PROJECT_V2));
  const drifted = load(f);
  const reused = resolveModeSelection({ baseKey: "leader", overlayKeys: [] }, drifted, {
    fingerprints: state.fingerprints,
    driftPolicy: "reuse",
    projectApprovals: approvals,
  });
  assert.equal(reused.blocked, false, "the composition is never dropped");
  assert.ok(
    reused.base?.systemPrompt?.includes(PROJECT_V1),
    "the pre-drift project text survives an edit, approved or not",
  );
  assert.ok(
    !reused.base?.systemPrompt?.includes(PROJECT_V2),
    "and the unapproved text is never composed",
  );
});

test("an unconfirmed project overlay is withheld, not fatal to the whole composition", () => {
  // The same principle as drift, on the neighbouring path: one unapproved file must not cost the
  // lane its role contract. The security property is unchanged -- the unapproved text is never
  // composed -- but the cost is the key that was not confirmed, nothing else.
  const f = fixture();
  writeMode(join(f.globalDir, "leader.json"), modeFile(APPROVED));
  writeMode(join(f.projectDir, "extra.json"), overlayFile("extra", "unapproved project text"));
  const modes = load(f);
  const result = resolveModeSelection({ baseKey: "leader", overlayKeys: ["extra"] }, modes, {
    driftPolicy: "reuse",
    projectApprovals: new Map(),
  });
  assert.equal(result.blocked, false, "one unapproved file cannot drop the whole composition");
  assert.equal(result.base?.systemPrompt, APPROVED, "the base still composes");
  assert.deepEqual(result.overlays, [], "the unconfirmed key is the part withheld");
  assert.ok(
    result.diagnostics.some((d) => (d.message ?? "").includes("is not confirmed")),
    "and the reason names the file",
  );
});

test("a restored snapshot is confirmed by construction, so a reload keeps the approved text", () => {
  // Overlord's reload found this: PI_MODE_CONFIRM_PROJECT=1 approves the project half at launch only,
  // and that approval does not survive a reload. The restored definition then failed the confirmation
  // check, was withheld, and the composed base went with it -- the lane fell to `mode:native`. The
  // digest-verified snapshot *is* the approval record, so a restored key cannot be unconfirmed.
  const f = fixture();
  writeMode(join(f.globalDir, "leader.json"), modeFile(APPROVED));
  const projectFile = join(f.projectDir, "leader.json");
  writeMode(projectFile, overlayFile("leader", PROJECT_V1));
  const composed = load(f);
  const projectMode = composed.find((mode) => mode.scope === "project");
  assert.ok(projectMode, "the project half composes onto the global one");

  const state = createModeState({ baseKey: "leader", overlayKeys: [] }, composed, "command", {
    driftPolicy: "reuse",
  });
  // The clean composition seeds the snapshot, with the launch-time confirmation present.
  const clean = resolveModeSelection({ baseKey: "leader", overlayKeys: [] }, composed, {
    fingerprints: state.fingerprints,
    driftPolicy: "reuse",
    projectApprovals: new Map([[projectFile, projectApprovalDigest(projectMode)]]),
  });
  assert.equal(clean.blocked, false);

  writeFileSync(projectFile, overlayFile("leader", PROJECT_V2));
  const drifted = load(f);
  const afterReload = resolveModeSelection({ baseKey: "leader", overlayKeys: [] }, drifted, {
    fingerprints: state.fingerprints,
    driftPolicy: "reuse",
    projectApprovals: new Map(), // a reload has forgotten the runtime confirmation
  });
  assert.equal(afterReload.blocked, false, "the composition survives a reload without runtime approvals");
  assert.ok(
    afterReload.base?.systemPrompt?.includes(PROJECT_V1),
    "and the approved text is still what composes",
  );
  assert.ok(
    !afterReload.base?.systemPrompt?.includes(PROJECT_V2),
    "never the unapproved edit",
  );
});
