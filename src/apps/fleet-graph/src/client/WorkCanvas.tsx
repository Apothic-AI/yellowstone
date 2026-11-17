/** Work View: one swimlane per project label, roots branching to their items,
 * x spaced by dependency depth, y grouped under the owning root and sorted by
 * last activity (newest first). */

import { For, Show, createMemo, createSignal, onMount, type JSX } from "solid-js";
import type { Bead, WorkNode, WorkProject } from "../shared/types.ts";
import { layoutWorkProject, WORK_NODE } from "../shared/layout.ts";
import { relativeTime, titleClamp } from "../shared/format.ts";
import { useFleet } from "./store.ts";
import { TopBar } from "./components/Chrome.tsx";
import { ErrorState, LoadingState } from "./components/States.tsx";
import { IconClose } from "./icons.tsx";

export default function WorkCanvas(): JSX.Element {
  const { state, error, loading, fetchedAt, refresh } = useFleet();
  const [query, setQuery] = createSignal("");
  const [includeClosed, setIncludeClosed] = createSignal(true);
  const [highlightLane, setHighlightLane] = createSignal<string | null>(null);
  const [focusBead, setFocusBead] = createSignal<string | null>(null);
  const [detail, setDetail] = createSignal<Bead | null>(null);
  const [showComponents, setShowComponents] = createSignal(false);

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    setHighlightLane(params.get("lane"));
    const bead = params.get("bead");
    if (bead) {
      setFocusBead(bead);
      const found = state()?.beads.find((b) => b.id === bead);
      if (found) setDetail(found);
    }
  });

  const highlightIds = createMemo(() => {
    const lane = highlightLane();
    if (!lane) return new Set<string>();
    const beads = state()?.beads ?? [];
    return new Set(beads.filter((b) => b.assignee === lane || b.derived_lanes.includes(lane)).map((b) => b.id));
  });

  const projects = createMemo(() => {
    const s = state();
    if (!s) return [];
    const q = query().trim().toLowerCase();
    return s.work.projects
      .map((project) => {
        const matchesProject = !q || project.label.toLowerCase().includes(q) || project.id.toLowerCase().includes(q);
        const nodes = project.nodes.filter((node) => {
          if (!includeClosed() && ["closed", "done"].includes(node.status)) return false;
          if (!q) return true;
          return (
            matchesProject ||
            node.id.toLowerCase().includes(q) ||
            node.title.toLowerCase().includes(q) ||
            node.status.toLowerCase().includes(q) ||
            node.issue_type.toLowerCase().includes(q)
          );
        });
        const ids = new Set(nodes.map((n) => n.id));
        const filtered: WorkProject = {
          ...project,
          nodes: nodes.map((n) => ({ ...n, root: ids.has(n.root) ? n.root : n.id })),
          edges: project.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
          roots: project.roots.filter((r) => ids.has(r))
        };
        return { project: filtered, layout: layoutWorkProject(filtered, { includeClosed: includeClosed() }) };
      })
      .filter((entry) => entry.project.nodes.length > 0);
  });

  const highlightCount = () => highlightIds().size;

  return (
    <div class="page">
      <TopBar view="work" state={state()} fetchedAt={fetchedAt()} error={error()} onRefresh={() => void refresh()}>
        <input
          class="search"
          type="search"
          placeholder="filter work…"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          aria-label="Filter work items"
        />
      </TopBar>

      <div class="toolbar work-toolbar">
        <div class="toolbar-left">
          <button class="toggle" classList={{ on: includeClosed() }} onClick={() => setIncludeClosed(!includeClosed())}>
            {includeClosed() ? "showing closed" : "open only"}
          </button>
          <button class="toggle" classList={{ on: showComponents() }} onClick={() => setShowComponents(!showComponents())}>
            components ({state()?.work.components.length ?? 0})
          </button>
          <span class="toolbar-note">
            {state()?.summary.projects ?? 0} project lanes · {state()?.summary.beads_total ?? 0} beads · x = dependency depth · y = group, newest first
          </span>
        </div>
        <div class="legend">
          <span class="legend-item"><span class="legend-line parent" /> parent</span>
          <span class="legend-item"><span class="legend-line blocks" /> blocks</span>
          <span class="legend-item"><span class="join-chip">assignee</span></span>
          <span class="legend-item"><span class="join-chip derived">derived</span></span>
        </div>
      </div>

      <Show when={highlightLane()}>
        {(lane) => (
          <div class="highlight-banner" data-highlight-lane={lane()}>
            <span>
              Highlighting <b>{highlightCount()}</b> work item(s) joined to <b>{lane()}</b> — join is{" "}
              <span class="mono">assignee</span> where present, session-derived otherwise.
            </span>
            <button
              class="link-button"
              onClick={() => {
                setHighlightLane(null);
                setQuery("");
                const url = new URL(window.location.href);
                url.searchParams.delete("lane");
                window.history.replaceState(null, "", url);
              }}
            >
              clear
            </button>
          </div>
        )}
      </Show>

      <Show when={showComponents()}>
        <div class="components-panel">
          <h3>Subrepo components ({state()?.work.components.length ?? 0})</h3>
          <p class="muted">
            Read from <span class="mono">.gitrepo</span> files. Beads do not yet carry a{" "}
            <span class="mono">subrepo:&lt;name&gt;</span> label, so these are components, not graph roots. That label is the pending
            decision recorded in FT-74.
          </p>
          <div class="component-grid">
            <For each={state()?.work.components ?? []}>
              {(component) => (
                <span class="component-chip" title={component.path}>
                  {component.name}
                </span>
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={!loading()} fallback={<LoadingState label="Reading beads, roles and sessions…" />}>
        <Show when={state()} fallback={<ErrorState message={error() ?? "no state"} onRetry={() => void refresh()} />}>
          {(s) => (
            <main class="board" data-graph-view="work" data-project-count={projects().length} data-bead-count={s().beads.length}>
              <For each={projects()}>
                {(entry) => (
                  <WorkBand
                    project={entry.project}
                    layout={entry.layout}
                    highlightIds={highlightIds()}
                    focusBead={focusBead()}
                    onSelect={setDetail}
                  />
                )}
              </For>
            </main>
          )}
        </Show>
      </Show>

      <Show when={detail()}>
        {(bead) => <BeadDetail bead={bead()} highlightLane={highlightLane()} onClose={() => setDetail(null)} />}
      </Show>
    </div>
  );
}

function WorkBand(props: {
  project: WorkProject;
  layout: ReturnType<typeof layoutWorkProject>;
  highlightIds: Set<string>;
  focusBead: string | null;
  onSelect: (bead: Bead) => void;
}): JSX.Element {
  return (
    <section class="swimlane work-lane" data-project={props.project.id} aria-label={"Project " + props.project.label}>
      <div class="lane-rail">
        <div class="rail-top">
          <span class="rail-number">{props.project.counts.total}</span>
          <span class="rail-status" classList={{ [props.project.counts.blocked > 0 ? "blocked" : "idle"]: true }} />
        </div>
        <h2 class="rail-label">{props.project.label}</h2>
        <div class="rail-meta mono">{props.project.workspace_id ? "project:" + props.project.workspace_id : "unlabelled"}</div>
        <div class="rail-counts">
          <span><b>{props.project.counts.open}</b> open</span>
          <span><b>{props.project.counts.in_progress}</b> active</span>
          <span><b>{props.project.counts.blocked}</b> blocked</span>
          <span><b>{props.project.counts.closed}</b> closed</span>
        </div>
        <div class="rail-when">{relativeTime(props.project.updated_at)}</div>
      </div>
      <div class="lane-canvas" style={{ width: props.layout.width + "px", height: props.layout.height + "px" }}>
        <svg class="edges" width={props.layout.width} height={props.layout.height} aria-hidden="true">
          <defs>
            <marker id={"w-arrow-" + props.project.id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" class="arrow-parent" />
            </marker>
          </defs>
          <For each={props.project.edges}>
            {(edge) => {
              const from = props.layout.nodes.get(edge.from);
              const to = props.layout.nodes.get(edge.to);
              if (!from || !to) return null;
              const x1 = from.x + from.w;
              const y1 = from.y + from.h / 2;
              const x2 = to.x - 6;
              const y2 = to.y + to.h / 2;
              const mx = (x1 + x2) / 2;
              const d = "M " + x1 + " " + y1 + " C " + mx + " " + y1 + ", " + mx + " " + y2 + ", " + x2 + " " + y2;
              return <path d={d} class={"edge " + edge.kind} marker-end={edge.kind === "parent" ? "url(#w-arrow-" + props.project.id + ")" : undefined} />;
            }}
          </For>
        </svg>
        <For each={props.project.nodes}>
          {(node) => {
            const rect = props.layout.nodes.get(node.id);
            if (!rect) return null;
            return (
              <WorkCard
                node={node}
                rect={rect}
                isRoot={props.project.roots.includes(node.id)}
                highlighted={props.highlightIds.has(node.id)}
                focused={props.focusBead === node.id}
                onSelect={props.onSelect}
              />
            );
          }}
        </For>
      </div>
    </section>
  );
}

function WorkCard(props: {
  node: WorkNode;
  rect: { x: number; y: number; w: number; h: number };
  isRoot: boolean;
  highlighted: boolean;
  focused: boolean;
  onSelect: (bead: Bead) => void;
}): JSX.Element {
  return (
    <article
      class="work-card"
      classList={{
        root: props.isRoot,
        highlighted: props.highlighted,
        focused: props.focused,
        closed: ["closed", "done"].includes(props.node.status)
      }}
      style={{
        left: props.rect.x + "px",
        top: props.rect.y + "px",
        width: props.rect.w + "px",
        height: props.rect.h + "px"
      }}
      data-bead-id={props.node.id}
      data-status={props.node.status}
      data-depth={props.node.depth}
      onClick={() => props.onSelect(props.node)}
      tabindex={0}
      aria-label={"Bead " + props.node.id + ": " + props.node.title}
    >
      <div class="work-card-top">
        <span class="bead-id mono">{props.node.id}</span>
        <Show when={props.isRoot}>
          <span class="root-chip">{props.node.issue_type}</span>
        </Show>
        <span class="bead-status" classList={{ [props.node.status]: true }}>{props.node.status}</span>
      </div>
      <p class="work-title">{titleClamp(props.node.title, 92)}</p>
      <div class="work-card-foot">
        <span class="bead-type">{props.node.issue_type}</span>
        <span class="bead-when">{relativeTime(props.node.updated_at)}</span>
        <Show when={props.node.assignee}>
          <span class="join-chip" title={"assignee: " + props.node.assignee}>{props.node.assignee}</span>
        </Show>
        <Show when={!props.node.assignee && props.node.derived_lanes.length > 0}>
          <span class="join-chip derived" title={"derived from session: " + props.node.derived_lanes.join(", ")}>
            derived: {props.node.derived_lanes[0]}
          </span>
        </Show>
      </div>
    </article>
  );
}

function BeadDetail(props: { bead: Bead; highlightLane: string | null; onClose: () => void }): JSX.Element {
  return (
    <aside class="drawer bead-detail" aria-label={"Bead " + props.bead.id}>
      <header class="drawer-head">
        <div>
          <h2 class="mono">{props.bead.id}</h2>
          <p class="drawer-sub">
            {props.bead.issue_type} · priority {props.bead.priority} · {props.bead.status}
          </p>
        </div>
        <button class="icon-button" onClick={props.onClose} aria-label="Close bead detail">
          <IconClose />
        </button>
      </header>
      <div class="drawer-body">
        <h3 class="detail-title">{props.bead.title}</h3>
        <dl class="detail-list">
          <dt>project</dt><dd>{props.bead.project ? "project:" + props.bead.project : "—"}</dd>
          <dt>parent</dt><dd class="mono">{props.bead.parent ?? "—"}</dd>
          <dt>assignee</dt><dd>{props.bead.assignee ?? "—"}</dd>
          <dt>derived from</dt><dd>{props.bead.derived_lanes.length ? props.bead.derived_lanes.join(", ") : "—"}</dd>
          <dt>updated</dt><dd>{relativeTime(props.bead.updated_at)}</dd>
          <dt>created</dt><dd>{relativeTime(props.bead.created_at)}</dd>
          <dt>labels</dt><dd>{props.bead.labels.length ? props.bead.labels.join(", ") : "—"}</dd>
          <dt>dependencies</dt>
          <dd>
            {props.bead.dependencies.length
              ? props.bead.dependencies.map((d) => d.type + ":" + d.id).join(", ")
              : "—"}
          </dd>
        </dl>
        <Show when={props.highlightLane && (props.bead.assignee === props.highlightLane || props.bead.derived_lanes.includes(props.highlightLane!))}>
          <p class="detail-join">
            joined to <b>{props.highlightLane}</b> via {props.bead.assignee === props.highlightLane ? "assignee" : "session record"}.
          </p>
        </Show>
      </div>
    </aside>
  );
}
