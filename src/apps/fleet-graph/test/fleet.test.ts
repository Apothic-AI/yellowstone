import test from "node:test";
import assert from "node:assert/strict";
import { buildFleet, type BeholdDoc, type HerdrSnapshot } from "../src/server/fleet.ts";
import type { RoleRecord } from "../src/server/roles.ts";

const snapshot: HerdrSnapshot = {
  protocol: 22,
  workspaces: [
    { workspace_id: "w1", label: "One", number: 1, agent_status: "idle", tab_count: 3, pane_count: 3 },
    { workspace_id: "w2", label: "Two", number: 2, agent_status: "idle", tab_count: 1, pane_count: 1 }
  ],
  agents: [
    { pane_id: "w1:p1", name: "lead", workspace_id: "w1", tab_id: "w1:t1", agent_status: "idle", state_change_seq: 5 },
    { pane_id: "w1:p2", name: "worker-a", workspace_id: "w1", tab_id: "w1:t2", agent_status: "working" },
    { pane_id: "w1:p3", name: "worker-b", workspace_id: "w1", tab_id: "w1:t3", agent_status: "idle" },
    { pane_id: "w2:p1", name: "solo", workspace_id: "w2", tab_id: "w2:t1", agent_status: "idle" }
  ]
};

const behold: BeholdDoc = {
  lanes: [
    {
      key: "w1:p1",
      handles: { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", workspace_label: "One", name: "lead", agent_status: "idle" },
      admission: { admitted: true },
      identity: { state: "verified", session_id: "s1", pin_path: "/tmp/s1.jsonl", pil_record: { pid: 11, updatedAt: "2026-11-17T10:00:00Z" }, proc: { state: "S" } },
      fields: {
        "H-5": { value: { status: "idle", state_change_seq: 5, completion_seq: 4 } },
        "P-2": { value: { selected: "m", physical: "m" } },
        "T-3": { value: 12.5 },
        "L-1": { value: "leader" },
        "M-5": { value: { name: "lead" } },
        "P-7": { value: 1000 }
      }
    },
    {
      key: "w1:p2",
      handles: { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t2", workspace_label: "One", name: "worker-a", agent_status: "working" },
      identity: { state: "verified", session_id: "s2", pin_path: "/tmp/s2.jsonl", pil_record: { pid: 12 }, proc: { state: "R" } },
      fields: { "L-1": { value: "worker" }, "H-5": { value: { status: "working" } } }
    }
  ]
};

function role(lane: string, mode: string, spawnedBy: string | null): RoleRecord {
  return { lane, mode, profile: mode, confirmProject: "1", spawnedBy, file: "/roles/" + lane + ".env" };
}

test("leaders are roots and a recorded PI_SPAWNED_BY becomes the parent edge", () => {
  const roles = new Map<string, RoleRecord>([
    ["lead", role("lead", "leader", null)],
    ["worker-a", role("worker-a", "worker", "lead")]
  ]);
  const fleet = buildFleet(snapshot, behold, roles);
  const lead = fleet.lanes.find((l) => l.name === "lead")!;
  const a = fleet.lanes.find((l) => l.name === "worker-a")!;
  assert.equal(lead.parent, null);
  assert.equal(lead.role, "leader");
  assert.equal(a.parent, "lead");
  assert.equal(a.parent_source, "record");
  assert.equal(a.spawned_by, "lead");
  assert.equal(a.role_source, "record", "the launcher's record outranks the behold field");
  assert.equal(a.model, null);
});

test("a worker with no spawn record and one workspace leader gets a derived edge", () => {
  const roles = new Map<string, RoleRecord>([
    ["lead", role("lead", "leader", null)],
    ["worker-b", role("worker-b", "worker", null)]
  ]);
  const fleet = buildFleet(snapshot, null, roles);
  const b = fleet.lanes.find((l) => l.name === "worker-b")!;
  assert.equal(b.parent, "lead");
  assert.equal(b.parent_source, "derived");
});

test("a spawn record naming a lane that is not present does not invent a parent", () => {
  const roles = new Map<string, RoleRecord>([
    ["worker-a", role("worker-a", "worker", "retired-leader")],
    ["lead", role("lead", "leader", null)]
  ]);
  const fleet = buildFleet(snapshot, null, roles);
  const a = fleet.lanes.find((l) => l.name === "worker-a")!;
  assert.equal(a.spawned_by, "retired-leader");
  assert.equal(a.parent, "lead", "falls back to the single leader, but as a derived edge");
  assert.equal(a.parent_source, "derived");
});

test("workspaces keep lanes and report unknown workspaces too", () => {
  const fleet = buildFleet(snapshot, null, new Map());
  const one = fleet.workspaces.find((w) => w.workspace_id === "w1")!;
  assert.deepEqual(one.lane_names, ["lead", "worker-a", "worker-b"]);
  assert.equal(fleet.workspaces.length, 2);
});
