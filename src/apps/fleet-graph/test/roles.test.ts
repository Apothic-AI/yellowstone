import test from "node:test";
import assert from "node:assert/strict";
import { parseRoleFile } from "../src/server/roles.ts";

test("parses the launcher's role record including PI_SPAWNED_BY", () => {
  const record = parseRoleFile("worker-a", "/r/worker-a.env", "PI_MODE=worker PI_PROFILE=worker PI_MODE_CONFIRM_PROJECT=1 PI_SPAWNED_BY=lead\n");
  assert.equal(record.mode, "worker");
  assert.equal(record.profile, "worker");
  assert.equal(record.spawnedBy, "lead");
});

test("a hostile value is rejected and the safe key beside it still lands", () => {
  const record = parseRoleFile("x", "/r/x.env", "PI_MODE=$(rm -rf) PI_PROFILE=leader PI_SPAWNED_BY=a;b\n");
  assert.equal(record.mode, null);
  assert.equal(record.profile, "leader");
  assert.equal(record.spawnedBy, null);
});

test("reads the last token without a trailing newline", () => {
  const record = parseRoleFile("x", "/r/x.env", "PI_MODE=leader PI_PROFILE=leader PI_SPAWNED_BY=overlord");
  assert.equal(record.spawnedBy, "overlord");
});
