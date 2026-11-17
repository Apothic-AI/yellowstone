/** Print a one-screen summary of the live state, for humans and for the report. */

import { getState } from "../src/server/state.ts";

const state = await getState({ refresh: true });
const lanes = state.lanes;
const assigned = lanes.reduce((n, lane) => n + lane.beads_assigned.length, 0);
const derived = lanes.reduce((n, lane) => n + lane.beads_derived.length, 0);
const parents = lanes.filter((lane) => lane.parent && lane.parent_source === "record").length;
const derivedParents = lanes.filter((lane) => lane.parent && lane.parent_source === "derived").length;

console.log(JSON.stringify({
  generated_at: state.generated_at,
  build_ms: state.build_ms,
  summary: state.summary,
  lane_edges: {
    recorded_parents: parents,
    derived_parents: derivedParents,
    no_parent: lanes.length - parents - derivedParents
  },
  bead_joins: { assigned, derived },
  sources: state.sources,
  workspaces_with_lanes: state.workspaces
    .filter((workspace) => workspace.lane_names.length > 0)
    .map((workspace) => ({ id: workspace.workspace_id, label: workspace.label, lanes: workspace.lane_names.length })),
  rooms: { available: state.rooms.available, names: state.rooms.names.length },
  components: state.work.components.length,
  projects: state.work.projects.slice(0, 8).map((project) => ({
    id: project.id,
    label: project.label,
    total: project.counts.total,
    roots: project.roots.length
  }))
}, null, 2));
