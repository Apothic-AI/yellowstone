/**
 * FT-20 base fail control.
 *
 * Proves the defect is real and that the fix changes it, by running the same
 * payload through two builds:
 *
 *   base       pi-hermes-memory 0.10.0 as published   -> []  (silent "nothing to save")
 *   candidate  this branch                             -> null (fail closed)
 *
 * Usage: node test/base-control.mjs <baseDistDir> <candidateDistDir>
 * Both directories are build outputs of src/handlers/review-memory-ops.ts.
 */

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

const [baseDir, candidateDir] = process.argv.slice(2);
if (!baseDir || !candidateDir) {
  console.error("usage: node test/base-control.mjs <baseDistDir> <candidateDistDir>");
  process.exit(2);
}

const load = async (dir) => {
  const file = join(resolve(dir), "src", "handlers", "review-memory-ops.js");
  return import(pathToFileURL(file).href);
};

const base = await load(baseDir);
const candidate = await load(candidateDir);

/** The payload that 0.10.0 silently turned into a successful no-op. */
const INVALID = '{"operations":[{"action":"delete","target":"memory"}]}';
const MIXED = JSON.stringify({
  operations: [
    { action: "add", target: "memory", content: "a durable fact" },
    { action: "remove", target: "memory" },
  ],
});

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, status: "PASS" });
  } catch (error) {
    results.push({ name, status: "FAIL", detail: error.message });
  }
};

// --- The defect, asserted as the base's actual behaviour -----------------
check("base: invalid non-empty operations are silently accepted as empty", () => {
  assert.deepEqual(base.parseReviewOperations(INVALID), []);
});

check("base: mixed valid+invalid array is passed through, so the applier silently skips half", () => {
  // 0.10.0 only validated `action` and `target`, so an operation missing
  // `old_text` survived the parser and was then dropped by the apply loop's
  // `skippedCount++ continue` — a partial write with no diagnostic.
  const ops = base.parseReviewOperations(MIXED);
  assert.equal(ops.length, 2, "both entries reach the applier in the base");
  assert.equal(ops[1].action, "remove");
  assert.equal(ops[1].old_text, undefined, "and the second one cannot be applied");
});

check("base: exposes no typed parse outcome and no diagnostics helper", () => {
  assert.equal(base.parseReviewOperationsDetailed, undefined);
  assert.equal(base.describeDiagnostics, undefined);
});

// --- The fix -------------------------------------------------------------
check("candidate: invalid non-empty operations fail closed", () => {
  assert.equal(candidate.parseReviewOperations(INVALID), null);
  assert.equal(candidate.parseReviewOperationsDetailed(INVALID).kind, "invalid_operations");
});

check("candidate: mixed array is refused whole", () => {
  assert.equal(candidate.parseReviewOperations(MIXED), null);
  const parsed = candidate.parseReviewOperationsDetailed(MIXED);
  assert.equal(parsed.kind, "invalid_operations");
  assert.deepEqual(parsed.reasonCodes, ["missing_old_text"]);
});

check("candidate: the canonical empty plan is still a true empty", () => {
  assert.deepEqual(candidate.parseReviewOperations('{"operations":[]}'), []);
  assert.equal(candidate.parseReviewOperationsDetailed('{"operations":[]}').kind, "empty_payload");
});

check("candidate: the explicit decline phrase is still a decline", () => {
  assert.deepEqual(candidate.parseReviewOperations("Nothing to save."), []);
  assert.equal(candidate.parseReviewOperationsDetailed("Nothing to save.").kind, "declined");
});

check("candidate: prose is still a failure, never a decline", () => {
  assert.equal(candidate.parseReviewOperations("Nothing new worth saving."), null);
});

// --- Report --------------------------------------------------------------
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`  ${r.status.padEnd(4)}  ${r.name.padEnd(width)}${r.detail ? `   ${r.detail}` : ""}`);
}
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`\nbase-control: ${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
