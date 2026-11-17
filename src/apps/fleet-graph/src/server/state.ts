/** Assemble the one document the UI renders.
 *
 * Every source is read through \`ttl()\` so a polling browser is cheap and a
 * failing source degrades to a labelled gap instead of an empty screen. The
 * document is read-only: no command here writes to beads, herdr, pi-rooms or a
 * session.
 */

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Bead, FleetState, LaneRecord, SourceStatus, WorkProject } from "../shared/types.ts";
import { runJson } from "./exec.ts";
import { ttl } from "./cache.ts";
import { readRoleRecords } from "./roles.ts";
import { buildWorkProjects, readBeads, type ComponentRecord } from "./beads.ts";
import { buildFleet, type BeholdDoc, type HerdrSnapshot } from "./fleet.ts";
import { readRoomsIndex } from "./rooms.ts";
import { scanLaneSessions } from "./sessions.ts";

const REPO_ROOT = process.env.FLEET_GRAPH_REPO ?? join(homedir(), "Code", "yellowstone");
const BEADS_CWD = process.env.FLEET_GRAPH_BEADS_CWD ?? join(homedir(), "Documents", "Fleet");

export function listComponents(root: string = REPO_ROOT, maxDepth = 5): ComponentRecord[] {
  const out: ComponentRecord[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || out.length >= 200) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.name === ".gitrepo") {
        const path = dir.slice(root.length + 1) || ".";
        out.push({ name: path.split("/").pop() ?? path, path });
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

interface BuiltState {
  state: FleetState;
}

let lastState: { at: number; state: FleetState } | null = null;
let inflight: Promise<FleetState> | null = null;

export async function getState(opts: { refresh?: boolean; maxAgeMs?: number } = {}): Promise<FleetState> {
  const maxAgeMs = opts.maxAgeMs ?? 2_000;
  if (!opts.refresh && lastState && Date.now() - lastState.at < maxAgeMs) return lastState.state;
  if (!opts.refresh && inflight) return inflight;
  inflight = buildState(opts.refresh ?? false)
    .then((state) => {
      lastState = { at: Date.now(), state };
      return state;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function buildState(refresh: boolean): Promise<FleetState> {
  const started = Date.now();
  const sources: SourceStatus[] = [];

  const snapshotPromise = ttl(
    "herdr-snapshot",
    4_000,
    () => runJson<{ result?: { snapshot?: HerdrSnapshot } }>("herdr", ["api", "snapshot"], { timeoutMs: 15_000 }),
    refresh
  );
  // Behold walks every lane's session and is the slowest source; it is also the
  // one that fails transiently when two callers read it at once. One retry, and
  // the snapshot alone is enough to keep the Fleet View populated.
  const beholdPromise = ttl(
    "behold-roster",
    30_000,
    async () => {
      const first = await runJson<BeholdDoc>("behold", ["roster", "--json"], { timeoutMs: 90_000 });
      if (first.ok || !first.error?.includes("invalid JSON")) return first;
      return runJson<BeholdDoc>("behold", ["roster", "--json"], { timeoutMs: 90_000 });
    },
    refresh
  );

  const [snapshotRun, beholdRun, beadsRead, rolesResult, roomsIndex] = await Promise.all([
    snapshotPromise,
    beholdPromise,
    readBeads({ cwd: BEADS_CWD, ttlMs: 15_000, refresh }).catch((error) => ({
      beads: [] as Bead[],
      ok: false,
      error: String(error),
      ms: 0
    })),
    (async () => {
      const t0 = Date.now();
      const roles = readRoleRecords();
      return { roles, ms: Date.now() - t0 };
    })(),
    (async () => {
      const t0 = Date.now();
      const index = readRoomsIndex();
      return { index, ms: Date.now() - t0 };
    })()
  ]);

  sources.push({
    name: "herdr snapshot",
    ok: snapshotRun.ok,
    ms: snapshotRun.ms,
    detail: snapshotRun.ok ? "protocol " + (snapshotRun.data?.result?.snapshot?.protocol ?? "?") : snapshotRun.error
  });
  sources.push({
    name: "behold roster",
    ok: beholdRun.ok,
    ms: beholdRun.ms,
    detail: beholdRun.ok ? (beholdRun.data?.lanes?.length ?? 0) + " lanes" : beholdRun.error
  });
  sources.push({
    name: "bd list",
    ok: beadsRead.ok,
    ms: beadsRead.ms,
    detail: beadsRead.ok ? beadsRead.beads.length + " beads" : beadsRead.error
  });
  sources.push({ name: "pil role records", ok: rolesResult.roles.size > 0, ms: rolesResult.ms, detail: rolesResult.roles.size + " records" });
  sources.push({
    name: "pi-rooms store",
    ok: roomsIndex.index.available,
    ms: roomsIndex.ms,
    detail: roomsIndex.index.available ? roomsIndex.index.rooms.length + " rooms" : roomsIndex.index.error
  });

  const fleet = buildFleet(
    snapshotRun.ok ? snapshotRun.data?.result?.snapshot ?? null : null,
    beholdRun.ok ? beholdRun.data ?? null : null,
    rolesResult.roles
  );

  const beadIds = new Set(beadsRead.beads.map((b) => b.id));
  const assignedByLane = new Map<string, string[]>();
  for (const bead of beadsRead.beads) {
    if (!bead.assignee) continue;
    const list = assignedByLane.get(bead.assignee) ?? [];
    list.push(bead.id);
    assignedByLane.set(bead.assignee, list);
  }

  let derived = { byLane: new Map<string, Map<string, number>>(), scanned: 0, skipped: 0 };
  if (beadIds.size > 0) {
    derived = await ttl(
      "session-bead-joins",
      120_000,
      () => scanLaneSessions(fleet.lanes, beadIds),
      refresh
    );
    sources.push({
      name: "session bead scan",
      ok: true,
      ms: 0,
      detail: derived.scanned + " sessions scanned, " + derived.skipped + " skipped"
    });
  }

  for (const lane of fleet.lanes) {
    lane.beads_assigned = (assignedByLane.get(lane.name) ?? []).slice().sort();
    const mentions = derived.byLane.get(lane.name);
    lane.beads_derived = mentions
      ? [...mentions.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([id]) => id)
          .filter((id) => !lane.beads_assigned.includes(id))
      : [];
  }

  for (const bead of beadsRead.beads) {
    const lanes: string[] = [];
    for (const [lane, mentions] of derived.byLane) {
      if (mentions.has(bead.id) && !lanes.includes(lane)) lanes.push(lane);
    }
    bead.derived_lanes = lanes.sort();
  }

  const workspaceLabels: Record<string, string> = {};
  for (const ws of fleet.workspaces) workspaceLabels[ws.workspace_id] = ws.label;
  const components = listComponents(REPO_ROOT);
  const projects = buildWorkProjects(beadsRead.beads, { components, workspaceLabels });

  const counts = {
    workspaces: fleet.workspaces.length,
    lanes: fleet.lanes.length,
    leaders: fleet.lanes.filter((l) => l.role === "leader").length,
    workers: fleet.lanes.filter((l) => l.role === "worker").length,
    unknown_role: fleet.lanes.filter((l) => l.role === "unknown").length,
    working: fleet.lanes.filter((l) => l.status === "working").length,
    idle: fleet.lanes.filter((l) => l.status === "idle").length,
    beads_total: beadsRead.beads.length,
    beads_open: beadsRead.beads.filter((b) => b.status === "open").length,
    beads_in_progress: beadsRead.beads.filter((b) => b.status === "in_progress").length,
    beads_closed: beadsRead.beads.filter((b) => b.status === "closed" || b.status === "done").length,
    assigned: beadsRead.beads.filter((b) => b.assignee).length,
    derived_joins: beadsRead.beads.filter((b) => b.derived_lanes.length > 0).length,
    projects: projects.length,
    components: components.length
  };

  const state: FleetState = {
    generated_at: new Date().toISOString(),
    build_ms: Date.now() - started,
    sources,
    workspaces: fleet.workspaces,
    lanes: fleet.lanes,
    beads: beadsRead.beads,
    work: { projects, components },
    summary: counts,
    rooms: {
      available: roomsIndex.index.available,
      base: roomsIndex.index.base,
      names: roomsIndex.index.names,
      error: roomsIndex.index.error
    }
  };
  return state;
}

export function summarizeProjects(projects: WorkProject[]): { id: string; total: number }[] {
  return projects.map((p) => ({ id: p.id, total: p.counts.total }));
}

export type { BuiltState };
