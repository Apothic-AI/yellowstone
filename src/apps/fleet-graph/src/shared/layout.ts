/** Pure geometry. The server delivers facts; this module decides where a node
 * sits, so the layout rules from FT-74 are testable without a browser.
 *
 * Work View
 *   x = dependency depth (the \`bd graph\` layer idea), evenly spaced.
 *   y = grouped under the root the node belongs to, each group sorted by
 *       \`updated_at\` descending so the latest activity rises to the top.
 *
 * Fleet View
 *   x = tree depth: leader at column 0, its workers at column 1.
 *   y = stacked groups inside one workspace swimlane, leader first.
 */

import type { LaneRecord, WorkProject, WorkspaceRecord } from "./types.ts";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WorkLayout {
  nodes: Map<string, Rect & { group: string; row: number; col: number }>;
  groups: { root: string; y: number; h: number; count: number }[];
  width: number;
  height: number;
}

export const WORK_NODE = { w: 244, h: 78, colGap: 34, rowGap: 14, padX: 26, padY: 22, groupGap: 20 };

export function layoutWorkProject(project: WorkProject, opts: { includeClosed?: boolean } = {}): WorkLayout {
  const includeClosed = opts.includeClosed ?? true;
  const visible = project.nodes.filter((n) => includeClosed || !["closed", "done"].includes(n.status));
  const visibleIds = new Set(visible.map((n) => n.id));
  const byRoot = new Map<string, typeof visible>();
  for (const node of visible) {
    const root = visibleIds.has(node.root) ? node.root : node.id;
    const list = byRoot.get(root) ?? [];
    list.push(node);
    byRoot.set(root, list);
  }
  const updated = (id: string) => visible.find((n) => n.id === id)?.updated_at ?? "";
  const roots = [...byRoot.keys()].sort((a, b) => updated(b).localeCompare(updated(a)));

  const nodes = new Map<string, Rect & { group: string; row: number; col: number }>();
  const groups: WorkLayout["groups"] = [];
  let cursorY = WORK_NODE.padY;
  let maxX = 0;
  for (const root of roots) {
    const list = byRoot.get(root)!;
    // The root leads its group; the rest follow by recency. Depth then decides x.
    const ordered = [list.find((n) => n.id === root) ?? list[0], ...list.filter((n) => n.id !== root).sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))];
    const rows = ordered.length;
    const groupHeight = rows * WORK_NODE.h + (rows - 1) * WORK_NODE.rowGap;
    ordered.forEach((node, row) => {
      const x = WORK_NODE.padX + node.depth * (WORK_NODE.w + WORK_NODE.colGap);
      const y = cursorY + row * (WORK_NODE.h + WORK_NODE.rowGap);
      nodes.set(node.id, { x, y, w: WORK_NODE.w, h: WORK_NODE.h, group: root, row, col: node.depth });
      maxX = Math.max(maxX, x + WORK_NODE.w);
    });
    groups.push({ root, y: cursorY, h: groupHeight, count: rows });
    cursorY += groupHeight + WORK_NODE.groupGap;
  }
  return {
    nodes,
    groups,
    width: maxX + WORK_NODE.padX,
    height: Math.max(cursorY - WORK_NODE.groupGap + WORK_NODE.padY, WORK_NODE.padY * 2)
  };
}

export const FLEET_NODE = { w: 250, h: 84, colGap: 46, rowGap: 16, padX: 24, padY: 20, groupGap: 26 };

export interface FleetLayout {
  nodes: Map<string, Rect & { group: string; col: number }>;
  groups: { anchor: string; y: number; h: number; count: number; derived: boolean }[];
  width: number;
  height: number;
}

export function layoutWorkspace(lanes: LaneRecord[], workspace: WorkspaceRecord): FleetLayout {
  const inWs = lanes.filter((lane) => lane.workspace_id === workspace.workspace_id);
  const leaders = inWs.filter((lane) => lane.role === "leader").sort((a, b) => a.name.localeCompare(b.name));
  const byName = new Map(inWs.map((lane) => [lane.name, lane]));
  const claimed = new Set<string>();
  const groups: { anchor: string; lanes: LaneRecord[]; derived: boolean }[] = [];

  for (const leader of leaders) {
    const children = inWs.filter((lane) => lane.parent === leader.name && lane.name !== leader.name);
    children.forEach((c) => claimed.add(c.name));
    groups.push({ anchor: leader.name, lanes: [leader, ...children], derived: false });
  }
  const orphans = inWs
    .filter((lane) => lane.role !== "leader" && !claimed.has(lane.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (orphans.length > 0) {
    groups.push({ anchor: "", lanes: orphans, derived: true });
  }
  if (inWs.length === 0) {
    // A workspace with no admitted lane still gets a strip so the fleet's empty
    // rooms are visible as empty, not missing.
    return { nodes: new Map(), groups: [], width: FLEET_NODE.padX * 2, height: 64 };
  }

  const nodes = new Map<string, Rect & { group: string; col: number }>();
  const outGroups: FleetLayout["groups"] = [];
  let cursorY = FLEET_NODE.padY;
  let maxX = 0;
  for (const group of groups) {
    const isDerived = group.anchor === "";
    // A derived group has no leader anchor, so every member is placed in column 0
    // with a dotted stub instead of an invented parent node.
    const members = isDerived ? group.lanes : group.lanes.slice(1);
    const rows = Math.max(members.length, 1);
    const height = rows * FLEET_NODE.h + (rows - 1) * FLEET_NODE.rowGap;
    const anchorLane = group.lanes[0];
    if (!isDerived) {
      const anchorY = cursorY + Math.max(0, (height - FLEET_NODE.h) / 2);
      nodes.set(anchorLane.name, { x: FLEET_NODE.padX, y: anchorY, w: FLEET_NODE.w, h: FLEET_NODE.h, group: group.anchor, col: 0 });
      maxX = Math.max(maxX, FLEET_NODE.padX + FLEET_NODE.w);
    }
    members.forEach((child, index) => {
      const x = isDerived ? FLEET_NODE.padX : FLEET_NODE.padX + FLEET_NODE.w + FLEET_NODE.colGap;
      const y = cursorY + index * (FLEET_NODE.h + FLEET_NODE.rowGap);
      nodes.set(child.name, { x, y, w: FLEET_NODE.w, h: FLEET_NODE.h, group: group.anchor, col: isDerived ? 0 : 1 });
      maxX = Math.max(maxX, x + FLEET_NODE.w);
    });
    outGroups.push({ anchor: group.anchor, y: cursorY, h: height, count: group.lanes.length, derived: group.derived });
    cursorY += height + FLEET_NODE.groupGap;
  }
  return {
    nodes,
    groups: outGroups,
    width: maxX + FLEET_NODE.padX,
    height: Math.max(cursorY - FLEET_NODE.groupGap + FLEET_NODE.padY, FLEET_NODE.padY * 2)
  };
}

export interface FleetLanePosition {
  lane: LaneRecord;
  rect: Rect;
  group: string;
}

export function layoutFleet(lanes: LaneRecord[], workspaces: WorkspaceRecord[]): Map<string, FleetLanePosition> {
  const out = new Map<string, FleetLanePosition>();
  for (const workspace of workspaces) {
    const layout = layoutWorkspace(lanes, workspace);
    for (const lane of lanes.filter((l) => l.workspace_id === workspace.workspace_id)) {
      const rect = layout.nodes.get(lane.name);
      if (rect) out.set(lane.name, { lane, rect, group: rect.group });
    }
  }
  return out;
}
