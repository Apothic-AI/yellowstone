import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkProjects, normalizeBeads, type RawBead } from "../src/server/beads.ts";
import { FLEET_NODE, WORK_NODE, layoutFleet, layoutWorkProject, layoutWorkspace } from "../src/shared/layout.ts";
import type { LaneRecord, WorkspaceRecord } from "../src/shared/types.ts";

const raw: RawBead[] = [
  { id: "root", title: "root", status: "open", issue_type: "epic", labels: ["project:w1"], updated_at: "2026-11-17T09:00:00Z" },
  { id: "old", title: "old", status: "open", issue_type: "task", labels: ["project:w1"], parent: "root", updated_at: "2026-11-01T09:00:00Z" },
  { id: "new", title: "new", status: "open", issue_type: "task", labels: ["project:w1"], parent: "root", updated_at: "2026-11-17T11:00:00Z" },
  { id: "deep", title: "deep", status: "open", issue_type: "task", labels: ["project:w1"], parent: "new", updated_at: "2026-11-17T12:00:00Z" }
];

test("work layout puts the root first, sorts its group by recency, and spaces x by depth", () => {
  const project = buildWorkProjects(normalizeBeads(raw))[0];
  const layout = layoutWorkProject(project);
  const root = layout.nodes.get("root")!;
  const newest = layout.nodes.get("new")!;
  const oldest = layout.nodes.get("old")!;
  const deep = layout.nodes.get("deep")!;
  assert.equal(root.row, 0);
  assert.equal(root.col, 0);
  assert.ok(newest.row < oldest.row, "latest activity rises within the group");
  assert.equal(newest.col, 1);
  assert.equal(deep.col, 2);
  assert.equal(newest.x - root.x, WORK_NODE.w + WORK_NODE.colGap);
  assert.equal(deep.x - newest.x, WORK_NODE.w + WORK_NODE.colGap);
  assert.equal(layout.groups.length, 1);
  assert.equal(layout.groups[0].root, "root");
});

test("includeClosed=false removes closed nodes from the layout and group", () => {
  const beads = raw.map((b) => (b.id === "old" ? { ...b, status: "closed" } : b));
  const project = buildWorkProjects(normalizeBeads(beads))[0];
  const layout = layoutWorkProject(project, { includeClosed: false });
  assert.equal(layout.nodes.has("old"), false);
  assert.equal(layout.groups[0].count, 3);
});

function lane(name: string, role: LaneRecord["role"], parent: string | null, workspace_id = "w1"): LaneRecord {
  return {
    key: workspace_id + ":" + name,
    name,
    workspace_id,
    workspace_label: "One",
    tab_id: null,
    role,
    role_source: "record",
    role_file: null,
    spawned_by: role === "worker" ? parent : null,
    parent,
    parent_source: parent ? "record" : null,
    status: "idle",
    state_change_seq: null,
    completion_seq: null,
    model: null,
    provider: null,
    context_pct: null,
    session_id: null,
    session_path: null,
    pid: null,
    proc_state: null,
    session_age_s: null,
    identity_state: null,
    rooms_name: null,
    observed_at: null,
    last_activity: null,
    beads_assigned: [],
    beads_derived: []
  };
}

const workspace: WorkspaceRecord = {
  workspace_id: "w1",
  label: "One",
  number: 1,
  agent_status: "idle",
  tab_count: 3,
  pane_count: 3,
  lane_names: ["lead", "worker-a", "worker-b"]
};

test("fleet layout puts a leader in column 0 and its workers in column 1", () => {
  const lanes = [lane("lead", "leader", null), lane("worker-a", "worker", "lead"), lane("worker-b", "worker", "lead")];
  const layout = layoutWorkspace(lanes, workspace);
  const lead = layout.nodes.get("lead")!;
  const a = layout.nodes.get("worker-a")!;
  const b = layout.nodes.get("worker-b")!;
  assert.equal(lead.col, 0);
  assert.equal(a.col, 1);
  assert.equal(b.col, 1);
  assert.equal(a.x - lead.x, FLEET_NODE.w + FLEET_NODE.colGap);
  assert.notEqual(a.y, b.y);
});

test("an unparented worker gets the derived group rather than being dropped", () => {
  const lanes = [lane("lead", "leader", null), lane("orphan", "worker", null)];
  const layout = layoutWorkspace(lanes, workspace);
  assert.ok(layout.nodes.has("orphan"));
  assert.equal(layout.nodes.get("orphan")!.col, 0, "the orphan group has no leader anchor, so its member starts at the left");
  const fleet = layoutFleet(lanes, [workspace]);
  assert.equal(fleet.get("orphan")!.group, "");
});
