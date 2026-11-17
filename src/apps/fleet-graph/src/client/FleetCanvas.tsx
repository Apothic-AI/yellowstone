/** Fleet View: one swimlane per herdr workspace, a root node per leader lane,
 * its workers branching from it, and the three per-lane actions FT-74 asks for. */

import { For, Show, createMemo, createSignal, onMount, type JSX } from "solid-js";
import type { FleetState, LaneRecord, WorkspaceRecord } from "../shared/types.ts";
import { layoutWorkspace, FLEET_NODE } from "../shared/layout.ts";
import { useFleet } from "./store.ts";
import { TopBar } from "./components/Chrome.tsx";
import { LaneCard } from "./components/LaneCard.tsx";
import { BeadDrawer } from "./components/BeadDrawer.tsx";
import { ChatModal } from "./components/ChatModal.tsx";
import { ErrorState, LoadingState } from "./components/States.tsx";

export default function FleetCanvas(): JSX.Element {
  const { state, error, loading, fetchedAt, refresh } = useFleet();
  const [query, setQuery] = createSignal("");
  const [showEmpty, setShowEmpty] = createSignal(false);
  const [selected, setSelected] = createSignal<string | null>(null);
  const [drawerLane, setDrawerLane] = createSignal<LaneRecord | null>(null);
  const [chatLane, setChatLane] = createSignal<LaneRecord | null>(null);

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    const lane = params.get("lane");
    if (lane) setSelected(lane);
  });

  const bands = createMemo(() => {
    const s = state();
    if (!s) return [];
    const q = query().trim().toLowerCase();
    const workspaces = showEmpty() ? s.workspaces : s.workspaces.filter((ws) => ws.lane_names.length > 0);
    return workspaces.map((workspace) => {
      const lanes = s.lanes.filter((lane) => {
        if (lane.workspace_id !== workspace.workspace_id) return false;
        if (!q) return true;
        return [lane.name, workspace.label, lane.role, lane.model ?? "", lane.status]
          .join(" ")
          .toLowerCase()
          .includes(q);
      });
      return { workspace, lanes, layout: layoutWorkspace(lanes, workspace) };
    });
  });

  const beadCount = () => {
    const s = state();
    if (!s) return 0;
    return s.lanes.reduce((n, lane) => n + lane.beads_assigned.length + lane.beads_derived.length, 0);
  };

  return (
    <div class="page">
      <TopBar
        view="fleet"
        state={state()}
        fetchedAt={fetchedAt()}
        error={error()}
        onRefresh={() => void refresh()}
      >
        <input
          class="search"
          type="search"
          placeholder="filter lanes…"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          aria-label="Filter lanes"
        />
      </TopBar>

      <div class="toolbar">
        <div class="toolbar-left">
          <button class="toggle" classList={{ on: showEmpty() }} onClick={() => setShowEmpty(!showEmpty())}>
            {showEmpty() ? "showing" : "hide"} empty spaces
          </button>
          <span class="toolbar-note">
            {state()?.summary.leaders ?? 0} leaders · {state()?.summary.workers ?? 0} workers ·{" "}
            {state()?.summary.unknown_role ?? 0} without a role record · {beadCount()} bead joins
          </span>
        </div>
        <div class="legend">
          <span class="legend-item"><span class="legend-dot leader" /> leader</span>
          <span class="legend-item"><span class="legend-dot worker" /> worker</span>
          <span class="legend-item"><span class="legend-dot working" /> working</span>
          <span class="legend-item"><span class="legend-line recorded" /> recorded parent</span>
          <span class="legend-item"><span class="legend-line derived" /> derived parent</span>
        </div>
      </div>

      <Show when={!loading()} fallback={<LoadingState />}>
        <Show when={state()} fallback={<ErrorState message={error() ?? "no state"} onRetry={() => void refresh()} />}>
          {(s) => (
            <main class="board" data-graph-view="fleet" data-lane-count={s().lanes.length} data-workspace-count={s().workspaces.length}>
              <For each={bands()}>
                {(band) => (
                  <FleetBand
                    workspace={band.workspace}
                    lanes={band.lanes}
                    layout={band.layout}
                    state={s()}
                    selected={selected()}
                    onSelect={setSelected}
                    onWork={(lane) => {
                      window.location.href = "/work?lane=" + encodeURIComponent(lane.name);
                    }}
                    onBeads={setDrawerLane}
                    onChat={setChatLane}
                  />
                )}
              </For>
            </main>
          )}
        </Show>
      </Show>

      <Show when={drawerLane()}>
        {(lane) => (
          <BeadDrawer
            lane={lane()}
            beads={state()?.beads ?? []}
            onClose={() => setDrawerLane(null)}
          />
        )}
      </Show>
      <Show when={chatLane()}>{(lane) => <ChatModal lane={lane()} onClose={() => setChatLane(null)} />}</Show>
    </div>
  );
}

function FleetBand(props: {
  workspace: WorkspaceRecord;
  lanes: LaneRecord[];
  layout: ReturnType<typeof layoutWorkspace>;
  state: FleetState;
  selected: string | null;
  onSelect: (name: string) => void;
  onWork: (lane: LaneRecord) => void;
  onBeads: (lane: LaneRecord) => void;
  onChat: (lane: LaneRecord) => void;
}): JSX.Element {
  const leaders = () => props.lanes.filter((l) => l.role === "leader").length;
  const workers = () => props.lanes.filter((l) => l.role === "worker").length;
  const orphans = () => props.lanes.filter((l) => l.role !== "leader" && !l.parent).length;
  return (
    <section
      class="swimlane"
      classList={{ empty: props.lanes.length === 0 }}
      data-workspace={props.workspace.workspace_id}
      aria-label={"Workspace " + props.workspace.label}
    >
      <div class="lane-rail">
        <div class="rail-top">
          <span class="rail-number">{props.workspace.number ?? "·"}</span>
          <span class="rail-status" classList={{ [props.workspace.agent_status]: true }} title={"workspace status: " + props.workspace.agent_status} />
        </div>
        <h2 class="rail-label">{props.workspace.label}</h2>
        <div class="rail-meta mono">{props.workspace.workspace_id}</div>
        <div class="rail-counts">
          <Show when={props.lanes.length > 0} fallback={<span class="rail-empty">no admitted lanes</span>}>
            <span><b>{props.lanes.length}</b> lanes</span>
            <span><b>{leaders()}</b> leaders</span>
            <span><b>{workers()}</b> workers</span>
            <Show when={orphans() > 0}>
              <span class="rail-warn" title="workers with no recorded or derivable parent">{orphans()} unattached</span>
            </Show>
          </Show>
        </div>
      </div>
      <div class="lane-canvas" style={{ width: props.layout.width + "px", height: props.layout.height + "px" }}>
        <svg class="edges" width={props.layout.width} height={props.layout.height} aria-hidden="true">
          <defs>
            <marker id="arrow-record" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" class="arrow-record" />
            </marker>
            <marker id="arrow-derived" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" class="arrow-derived" />
            </marker>
          </defs>
          <For each={props.lanes.filter((lane) => lane.parent)}>
            {(lane) => {
              const from = props.layout.nodes.get(lane.parent ?? "");
              const to = props.layout.nodes.get(lane.name);
              if (!from || !to) return null;
              const x1 = from.x + from.w;
              const y1 = from.y + from.h / 2;
              const x2 = to.x - 8;
              const y2 = to.y + to.h / 2;
              const mx = (x1 + x2) / 2;
              const d = "M " + x1 + " " + y1 + " C " + mx + " " + y1 + ", " + mx + " " + y2 + ", " + x2 + " " + y2;
              const derived = lane.parent_source === "derived";
              return (
                <path
                  d={d}
                  class={"edge " + (derived ? "derived" : "recorded")}
                  marker-end={derived ? "url(#arrow-derived)" : "url(#arrow-record)"}
                />
              );
            }}
          </For>
          <For each={props.lanes.filter((lane) => lane.role !== "leader" && !lane.parent)}>
            {(lane) => {
              const to = props.layout.nodes.get(lane.name);
              if (!to) return null;
              const y = to.y + to.h / 2;
              return <path d={"M " + (to.x - 30) + " " + y + " L " + (to.x - 6) + " " + y} class="edge unattached" />;
            }}
          </For>
        </svg>
        <Show when={props.lanes.length > 0} fallback={<div class="empty-space">no lane admitted in this workspace</div>}>
          <For each={props.lanes}>
            {(lane) => {
              const rect = props.layout.nodes.get(lane.name);
              if (!rect) return null;
              return (
                <LaneCard
                  lane={lane}
                  rect={rect}
                  selected={props.selected === lane.name}
                  dimmed={false}
                  onSelect={props.onSelect}
                  onWork={props.onWork}
                  onBeads={props.onBeads}
                  onChat={props.onChat}
                />
              );
            }}
          </For>
        </Show>
        <Show when={props.layout.groups.some((g) => g.derived)}>
          <div class="unattached-note" style={{ top: props.layout.height - 18 + "px" }}>
            dashed line = worker with no recorded parent (lane predates PI_SPAWNED_BY)
          </div>
        </Show>
      </div>
    </section>
  );
}
