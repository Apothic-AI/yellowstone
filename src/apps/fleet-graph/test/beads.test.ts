import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkProjects, computeDepths, normalizeBeads, type RawBead } from "../src/server/beads.ts";

const raw: RawBead[] = [
  {
    id: "epic-a",
    title: "Epic A",
    status: "open",
    issue_type: "epic",
    labels: ["project:w1", "ft-queue"],
    parent: null,
    updated_at: "2026-11-17T10:00:00Z"
  },
  {
    id: "task-a1",
    title: "Task A1",
    status: "in_progress",
    issue_type: "task",
    labels: ["project:w1"],
    parent: "epic-a",
    updated_at: "2026-11-17T12:00:00Z"
  },
  {
    id: "task-a2",
    title: "Task A2",
    status: "open",
    issue_type: "task",
    labels: ["project:w1"],
    parent: "epic-a",
    dependencies: [{ id: "task-a1", type: "blocks" }],
    updated_at: "2026-11-16T09:00:00Z"
  },
  {
    id: "loose",
    title: "Loose item",
    status: "closed",
    issue_type: "bug",
    labels: ["project:w2", "subrepo:yellowstone"],
    updated_at: "2026-11-15T09:00:00Z"
  }
];

test("normalizeBeads keeps project, subrepo, parent and dependencies", () => {
  const beads = normalizeBeads(raw);
  assert.equal(beads.length, 4);
  const epic = beads.find((b) => b.id === "epic-a")!;
  assert.equal(epic.project, "w1");
  assert.equal(epic.parent, null);
  const loose = beads.find((b) => b.id === "loose")!;
  assert.equal(loose.project, "w2");
  assert.equal(loose.subrepo, "yellowstone");
  assert.equal(loose.status, "closed");
  const a2 = beads.find((b) => b.id === "task-a2")!;
  assert.deepEqual(a2.dependencies, [{ id: "task-a1", type: "blocks" }]);
});

test("computeDepths layers a parent chain and a blocks edge", () => {
  const beads = normalizeBeads(raw);
  const { depth, edges } = computeDepths(beads);
  assert.equal(depth.get("epic-a"), 0);
  assert.equal(depth.get("task-a1"), 1);
  assert.equal(depth.get("task-a2"), 2, "task-a2 is blocked by task-a1, so it is one layer right of it");
  assert.ok(edges.some((e) => e.kind === "parent" && e.from === "epic-a" && e.to === "task-a1"));
  assert.ok(edges.some((e) => e.kind === "blocks" && e.from === "task-a1" && e.to === "task-a2"));
});

test("buildWorkProjects groups by project label and keeps roots sorted by activity", () => {
  const beads = normalizeBeads(raw);
  const projects = buildWorkProjects(beads, { workspaceLabels: { w1: "Workspace One" } });
  const w1 = projects.find((p) => p.id === "w1")!;
  assert.equal(w1.label, "Workspace One");
  assert.deepEqual(w1.roots, ["epic-a"]);
  assert.equal(w1.counts.total, 3);
  assert.equal(w1.counts.open, 2);
  assert.equal(w1.counts.in_progress, 1);
  assert.equal(w1.counts.closed, 0);
  const w2 = projects.find((p) => p.id === "w2")!;
  assert.deepEqual(w2.roots, ["loose"], "an unparented bead is its own root");
  assert.equal(w2.counts.closed, 1);
});

test("a parent outside the fetched set does not become a dangling root reference", () => {
  const beads = normalizeBeads([
    { id: "child", title: "child", status: "open", issue_type: "task", labels: ["project:w9"], parent: "missing" }
  ]);
  const projects = buildWorkProjects(beads);
  assert.deepEqual(projects[0].roots, ["child"]);
  assert.equal(projects[0].nodes[0].root, "child");
});
