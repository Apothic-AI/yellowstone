/** Shared types for the fleet graph. Everything here is plain data so it can be
 * produced by the server, checked by tests, and rendered by the client without
 * importing anything platform-specific. */

export type SourceStatus = {
  name: string;
  ok: boolean;
  ms: number;
  detail: string | null;
};

export type LaneRole = "leader" | "worker" | "unknown";

export type ParentSource = "record" | "derived" | null;

export interface LaneRecord {
  key: string;
  name: string;
  workspace_id: string;
  workspace_label: string;
  tab_id: string | null;
  role: LaneRole;
  role_source: string | null;
  role_file: string | null;
  /** Lane name written by the launcher at spawn (PI_SPAWNED_BY). Null when the
   * lane predates parentage recording. */
  spawned_by: string | null;
  /** Resolved parent lane name, if any. */
  parent: string | null;
  parent_source: ParentSource;
  status: string;
  state_change_seq: number | null;
  completion_seq: number | null;
  model: string | null;
  provider: string | null;
  context_pct: number | null;
  session_id: string | null;
  session_path: string | null;
  pid: number | null;
  proc_state: string | null;
  session_age_s: number | null;
  identity_state: string | null;
  rooms_name: string | null;
  observed_at: string | null;
  last_activity: string | null;
  beads_assigned: string[];
  beads_derived: string[];
}

export interface WorkspaceRecord {
  workspace_id: string;
  label: string;
  number: number | null;
  agent_status: string;
  tab_count: number;
  pane_count: number;
  lane_names: string[];
}

export interface BeadDep {
  id: string;
  type: string;
}

export interface Bead {
  id: string;
  title: string;
  status: string;
  issue_type: string;
  priority: number;
  labels: string[];
  project: string | null;
  subrepo: string | null;
  parent: string | null;
  dependencies: BeadDep[];
  updated_at: string | null;
  created_at: string | null;
  assignee: string | null;
  dependency_count: number;
  /** Lanes whose recorded session references this bead, derived from session
   * records and always labelled as derived in the UI. */
  derived_lanes: string[];
}

export interface WorkNode extends Bead {
  depth: number;
  root: string;
}

export interface WorkEdge {
  from: string;
  to: string;
  kind: "parent" | "blocks";
}

export interface WorkProject {
  id: string;
  label: string;
  workspace_id: string | null;
  workspace_label: string | null;
  nodes: WorkNode[];
  edges: WorkEdge[];
  roots: string[];
  counts: { total: number; open: number; in_progress: number; blocked: number; closed: number };
  updated_at: string | null;
}

export interface RoomsMessage {
  id: string;
  from: string;
  to: string[];
  text: string;
  sentAt: string;
  queuedAt?: string;
  deliveredAt?: string;
  room?: string;
  roomSeq?: number;
  source: "dm" | "room";
}

export interface FleetState {
  generated_at: string;
  build_ms: number;
  sources: SourceStatus[];
  workspaces: WorkspaceRecord[];
  lanes: LaneRecord[];
  beads: Bead[];
  work: { projects: WorkProject[]; components: { name: string; path: string }[] };
  summary: Record<string, number>;
  rooms: { available: boolean; base: string; names: string[]; error: string | null };
}

export interface RoomsResponse {
  lane: string;
  operator: string;
  available: boolean;
  error: string | null;
  identity: string | null;
  rooms: string[];
  messages: RoomsMessage[];
}
