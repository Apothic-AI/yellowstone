/** Beads: read \`bd list --json\` and turn it into the Work View's shape.
 *
 * The graph is derived here and merely positioned by the client:
 *   * project swimlanes come from the \`project:<workspace-id>\` label;
 *   * roots are beads with no parent inside their project (epics, milestones,
 *     and anything unparented);
 *   * x is dependency depth — the same "layer 0 / leftmost" idea \`bd graph\`
 *     documents — computed over parent-child and blocks edges;
 *   * y is left to the client, which sorts each parent group by \`updated_at\`
 *     descending so the most recent activity rises.
 */

import type { Bead, BeadDep, WorkEdge, WorkNode, WorkProject } from "../shared/types.ts";
import { runJson } from "./exec.ts";
import { ttl } from "./cache.ts";

export interface RawBead {
  id: string;
  title?: string;
  status?: string;
  issue_type?: string;
  priority?: number;
  labels?: string[];
  parent?: string | null;
  dependencies?: { id?: string; type?: string; depends_on_id?: string }[];
  updated_at?: string;
  created_at?: string;
  assignee?: string | null;
  dependency_count?: number;
}

export function normalizeBeads(raw: RawBead[]): Bead[] {
  return raw.map((b) => {
    const labels = Array.isArray(b.labels) ? b.labels : [];
    const projectLabel = labels.find((l) => l.startsWith("project:"));
    const subrepoLabel = labels.find((l) => l.startsWith("subrepo:"));
    const deps: BeadDep[] = (b.dependencies ?? [])
      .map((d) => ({ id: String(d?.id ?? d?.depends_on_id ?? ""), type: String(d?.type ?? "") }))
      .filter((d) => d.id.length > 0);
    return {
      id: b.id,
      title: b.title ?? "(untitled)",
      status: b.status ?? "open",
      issue_type: b.issue_type ?? "task",
      priority: typeof b.priority === "number" ? b.priority : 2,
      labels,
      project: projectLabel ? projectLabel.slice("project:".length) : null,
      subrepo: subrepoLabel ? subrepoLabel.slice("subrepo:".length) : null,
      parent: b.parent ?? null,
      dependencies: deps,
      updated_at: b.updated_at ?? null,
      created_at: b.created_at ?? null,
      assignee: b.assignee ?? null,
      dependency_count: typeof b.dependency_count === "number" ? b.dependency_count : deps.length,
      derived_lanes: []
    };
  });
}

const CLOSED = new Set(["closed", "done", "resolved"]);

/** Dependency depth over parent-child and blocks edges. Cycles are impossible in
 * a well-formed spine but a bead tracker is a shared mutable file, so the loop
 * is bounded rather than trusting the data. */
export function computeDepths(beads: Bead[]): { depth: Map<string, number>; edges: WorkEdge[] } {
  const ids = new Set(beads.map((b) => b.id));
  const edges: WorkEdge[] = [];
  for (const bead of beads) {
    const parent = bead.parent && ids.has(bead.parent) ? bead.parent : null;
    if (parent) edges.push({ from: parent, to: bead.id, kind: "parent" });
    for (const dep of bead.dependencies) {
      if (dep.type === "blocks" && ids.has(dep.id)) edges.push({ from: dep.id, to: bead.id, kind: "blocks" });
      if (dep.type === "parent-child") {
        const source = dep.id;
        if (ids.has(source) && source !== parent) edges.push({ from: source, to: bead.id, kind: "parent" });
      }
    }
  }
  const depth = new Map<string, number>();
  for (const bead of beads) depth.set(bead.id, 0);
  const maxPasses = Math.min(ids.size, 64);
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      const from = depth.get(edge.from) ?? 0;
      const to = depth.get(edge.to) ?? 0;
      if (from + 1 > to) {
        depth.set(edge.to, from + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { depth, edges };
}

export interface ComponentRecord {
  name: string;
  path: string;
}

export function buildWorkProjects(
  beads: Bead[],
  opts: { components?: ComponentRecord[]; workspaceLabels?: Record<string, string> } = {}
): WorkProject[] {
  // Path-compress every bead to its top-most ancestor inside the fetched set.
  const byId = new Map(beads.map((b) => [b.id, b]));
  const rootOf = (bead: Bead): string => {
    let current = bead;
    const seen = new Set<string>([current.id]);
    for (let i = 0; i < 64; i += 1) {
      const parent = current.parent && byId.get(current.parent) ? current.parent : null;
      if (!parent || seen.has(parent)) return current.id;
      seen.add(parent);
      current = byId.get(parent)!;
    }
    return current.id;
  };

  const byProject = new Map<string, Bead[]>();
  for (const bead of beads) {
    const key = bead.project ?? "misc";
    const list = byProject.get(key) ?? [];
    list.push(bead);
    byProject.set(key, list);
  }

  const projects: WorkProject[] = [];
  for (const [projectId, list] of byProject) {
    const ids = new Set(list.map((b) => b.id));
    const { depth, edges } = computeDepths(list);
    const nodes: WorkNode[] = list.map((bead) => ({
      ...bead,
      depth: depth.get(bead.id) ?? 0,
      root: rootOf(bead)
    }));
    const roots = [...new Set(nodes.map((n) => n.root))]
      .filter((id) => ids.has(id))
      .sort((a, b) => (byId.get(b)?.updated_at ?? "").localeCompare(byId.get(a)?.updated_at ?? ""));
    const counts = {
      total: list.length,
      open: list.filter((b) => b.status === "open").length,
      in_progress: list.filter((b) => b.status === "in_progress").length,
      blocked: list.filter((b) => b.status === "blocked").length,
      closed: list.filter((b) => CLOSED.has(b.status)).length
    };
    const updated = list
      .map((b) => b.updated_at ?? "")
      .filter(Boolean)
      .sort()
      .pop() ?? null;
    projects.push({
      id: projectId,
      label: opts.workspaceLabels?.[projectId] ?? projectId,
      workspace_id: projectId === "misc" ? null : projectId,
      workspace_label: opts.workspaceLabels?.[projectId] ?? null,
      nodes,
      edges,
      roots,
      counts,
      updated_at: updated
    });
  }
  projects.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  return projects;
}

export interface BeadsRead {
  beads: Bead[];
  ok: boolean;
  error: string | null;
  ms: number;
}

export async function readBeads(opts: { cwd?: string; ttlMs?: number; refresh?: boolean } = {}): Promise<BeadsRead> {
  const ran = await ttl(
    "beads:" + (opts.cwd ?? process.cwd()),
    opts.ttlMs ?? 15_000,
    () =>
      runJson<RawBead[]>("bd", ["list", "--json", "--all", "-n", "0", "--brief"], {
        timeoutMs: 30_000,
        cwd: opts.cwd
      }),
    opts.refresh
  );
  if (!ran.ok || !ran.data) {
    return { beads: [], ok: false, error: ran.error ?? "bd list returned no data", ms: ran.ms };
  }
  return { beads: normalizeBeads(ran.data), ok: true, error: null, ms: ran.ms };
}
