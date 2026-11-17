/** Fleet topology: herdr's snapshot for the physical tree, behold's roster for
 * the validated per-lane document, and the launcher's role records for the two
 * facts neither of the first two can prove — the role and the parent.
 *
 * Parentage (gap G1 in the FT-74 investigation) is recorded by \`pil\` at spawn
 * as \`PI_SPAWNED_BY\` in the lane's role record. Lanes that predate that record
 * have no parent; when their workspace has exactly one recorded leader the edge
 * is drawn to that leader and marked \`derived\` in the UI, never presented as a
 * record. */

import type { LaneRecord, LaneRole, WorkspaceRecord } from "../shared/types.ts";
import type { RoleRecord } from "./roles.ts";

export interface SnapshotAgent {
  pane_id: string;
  name?: string | null;
  workspace_id?: string | null;
  tab_id?: string | null;
  agent_status?: string | null;
  state_change_seq?: number | null;
  completion_seq?: number | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  agent_session?: { value?: string | null } | null;
}

export interface SnapshotWorkspace {
  workspace_id: string;
  label?: string | null;
  number?: number | null;
  agent_status?: string | null;
  tab_count?: number | null;
  pane_count?: number | null;
}

export interface HerdrSnapshot {
  protocol?: number;
  workspaces?: SnapshotWorkspace[];
  agents?: SnapshotAgent[];
  tabs?: { tab_id: string; label?: string | null; workspace_id: string }[];
}

export interface BeholdField {
  state?: string;
  value?: unknown;
}

export interface BeholdLane {
  key: string;
  handles: {
    pane_id?: string | null;
    workspace_id?: string | null;
    tab_id?: string | null;
    workspace_label?: string | null;
    name?: string | null;
    agent_status?: string | null;
  };
  admission?: { admitted?: boolean };
  identity?: {
    state?: string | null;
    session_id?: string | null;
    pin_path?: string | null;
    pil_record?: { pid?: number | null; updatedAt?: string | null; session?: string | null } | null;
    proc?: { state?: string | null; available?: boolean } | null;
  } | null;
  fields?: Record<string, BeholdField | undefined>;
}

export interface BeholdDoc {
  lanes?: BeholdLane[];
}

function field(lane: BeholdLane, key: string): BeholdField | undefined {
  return lane.fields?.[key];
}

function stringValue(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function numberValue(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export interface FleetBuild {
  lanes: LaneRecord[];
  workspaces: WorkspaceRecord[];
}

export function buildFleet(snapshot: HerdrSnapshot | null, behold: BeholdDoc | null, roles: Map<string, RoleRecord>): FleetBuild {
  const wsById = new Map<string, SnapshotWorkspace>();
  for (const ws of snapshot?.workspaces ?? []) wsById.set(ws.workspace_id, ws);

  const lanes = new Map<string, LaneRecord>();
  for (const agent of snapshot?.agents ?? []) {
    if (!agent.pane_id) continue;
    lanes.set(agent.pane_id, {
      key: agent.pane_id,
      name: agent.name ?? agent.pane_id,
      workspace_id: agent.workspace_id ?? "",
      workspace_label: wsById.get(agent.workspace_id ?? "")?.label ?? "",
      tab_id: agent.tab_id ?? null,
      role: "unknown",
      role_source: null,
      role_file: null,
      spawned_by: null,
      parent: null,
      parent_source: null,
      status: agent.agent_status ?? "unknown",
      state_change_seq: agent.state_change_seq ?? null,
      completion_seq: agent.completion_seq ?? null,
      model: null,
      provider: null,
      context_pct: null,
      session_id: null,
      session_path: agent.agent_session?.value ?? null,
      pid: null,
      proc_state: null,
      session_age_s: null,
      identity_state: null,
      rooms_name: null,
      observed_at: null,
      last_activity: null,
      beads_assigned: [],
      beads_derived: []
    });
  }

  // Behold is the admitted, validated lane document. It wins on every field it
  // publishes; the snapshot entry stays as the fallback for a lane behold holds
  // back for policy reasons.
  for (const bl of behold?.lanes ?? []) {
    const pane = bl.handles?.pane_id ?? bl.key;
    if (!pane) continue;
    const existing = lanes.get(pane);
    const name = bl.handles?.name ?? existing?.name ?? pane;
    const workspaceId = bl.handles?.workspace_id ?? existing?.workspace_id ?? "";
    const h5 = field(bl, "H-5")?.value as Record<string, unknown> | undefined;
    const p1 = field(bl, "P-1")?.value as { selected?: string; physical?: string } | undefined;
    const p2 = field(bl, "P-2")?.value as { selected?: string; physical?: string } | undefined;
    const p11 = field(bl, "P-11")?.value as { observed_at?: string } | undefined;
    const m5 = field(bl, "M-5")?.value as { name?: string } | undefined;
    const roleValue = stringValue(field(bl, "L-1")?.value);
    lanes.set(pane, {
      key: pane,
      name,
      workspace_id: workspaceId,
      workspace_label: bl.handles?.workspace_label ?? wsById.get(workspaceId)?.label ?? existing?.workspace_label ?? "",
      tab_id: bl.handles?.tab_id ?? existing?.tab_id ?? null,
      role: roleValue === "leader" || roleValue === "worker" ? (roleValue as LaneRole) : "unknown",
      role_source: roleValue ? "behold" : null,
      role_file: null,
      spawned_by: null,
      parent: null,
      parent_source: null,
      status: stringValue(h5?.status) ?? bl.handles?.agent_status ?? existing?.status ?? "unknown",
      state_change_seq: numberValue(h5?.state_change_seq) ?? existing?.state_change_seq ?? null,
      completion_seq: numberValue(h5?.completion_seq) ?? existing?.completion_seq ?? null,
      model: stringValue(p2?.physical) ?? stringValue(p2?.selected) ?? null,
      provider: stringValue(p1?.physical) ?? stringValue(p1?.selected) ?? null,
      context_pct: numberValue(field(bl, "T-3")?.value),
      session_id: bl.identity?.session_id ?? null,
      session_path: bl.identity?.pin_path ?? bl.identity?.pil_record?.session ?? existing?.session_path ?? null,
      pid: bl.identity?.pil_record?.pid ?? existing?.pid ?? null,
      proc_state: bl.identity?.proc?.state ?? null,
      session_age_s: numberValue(field(bl, "P-7")?.value),
      identity_state: bl.identity?.state ?? null,
      rooms_name: stringValue(m5?.name) ?? null,
      observed_at: stringValue(p11?.observed_at) ?? null,
      last_activity: bl.identity?.pil_record?.updatedAt ?? existing?.last_activity ?? null,
      beads_assigned: [],
      beads_derived: []
    });
  }

  // Role records are the launcher's own statement. They outrank the derived
  // behold field because the record is the input to the launch, not an
  // observation of it.
  for (const lane of lanes.values()) {
    const record = roles.get(lane.name);
    if (!record) continue;
    lane.role_file = record.file;
    lane.spawned_by = record.spawnedBy;
    if (record.mode === "leader" || record.mode === "worker") {
      lane.role = record.mode;
      lane.role_source = "record";
    }
  }

  // Parentage. Leaders are roots of the Fleet View by definition; a worker is
  // attached to its recorded spawner, else to the workspace's only leader and
  // marked derived, else it stays a root with no parent.
  for (const lane of lanes.values()) {
    if (lane.role === "leader") {
      lane.parent = null;
      lane.parent_source = null;
      continue;
    }
    if (lane.spawned_by && lane.spawned_by !== lane.name) {
      const parent = [...lanes.values()].find((c) => c.name === lane.spawned_by);
      if (parent) {
        lane.parent = parent.name;
        lane.parent_source = "record";
        continue;
      }
    }
    const leaders = [...lanes.values()].filter(
      (c) => c.workspace_id === lane.workspace_id && c.role === "leader"
    );
    if (leaders.length === 1) {
      lane.parent = leaders[0].name;
      lane.parent_source = "derived";
    }
  }

  // Workspaces: every snapshot workspace, plus any workspace only behold knows.
  const workspaces = new Map<string, WorkspaceRecord>();
  for (const ws of snapshot?.workspaces ?? []) {
    workspaces.set(ws.workspace_id, {
      workspace_id: ws.workspace_id,
      label: ws.label ?? ws.workspace_id,
      number: ws.number ?? null,
      agent_status: ws.agent_status ?? "unknown",
      tab_count: ws.tab_count ?? 0,
      pane_count: ws.pane_count ?? 0,
      lane_names: []
    });
  }
  for (const lane of lanes.values()) {
    if (!lane.workspace_id) continue;
    const ws = workspaces.get(lane.workspace_id) ?? {
      workspace_id: lane.workspace_id,
      label: lane.workspace_label || lane.workspace_id,
      number: null,
      agent_status: "unknown",
      tab_count: 0,
      pane_count: 0,
      lane_names: []
    };
    if (!ws.lane_names.includes(lane.name)) ws.lane_names.push(lane.name);
    workspaces.set(lane.workspace_id, ws);
  }
  const sortedWorkspaces = [...workspaces.values()].sort((a, b) => {
    const an = a.number ?? 9999;
    const bn = b.number ?? 9999;
    return an - bn || a.label.localeCompare(b.label);
  });
  for (const ws of sortedWorkspaces) ws.lane_names.sort();

  return { lanes: [...lanes.values()], workspaces: sortedWorkspaces };
}
