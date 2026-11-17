/** One lane node in the Fleet View. */

import type { JSX } from "solid-js";
import { Show } from "solid-js";
import type { LaneRecord } from "../../shared/types.ts";
import { relativeTime, shortModel, statusClass } from "../../shared/format.ts";
import { IconBeads, IconChat, IconWork } from "../icons.tsx";

export function LaneCard(props: {
  lane: LaneRecord;
  rect: { x: number; y: number; w: number; h: number };
  selected: boolean;
  dimmed: boolean;
  onSelect: (name: string) => void;
  onWork: (lane: LaneRecord) => void;
  onBeads: (lane: LaneRecord) => void;
  onChat: (lane: LaneRecord) => void;
}): JSX.Element {
  const beadCount = () => props.lane.beads_assigned.length + props.lane.beads_derived.length;
  return (
    <article
      class="lane-card"
      classList={{
        leader: props.lane.role === "leader",
        worker: props.lane.role === "worker",
        selected: props.selected,
        dimmed: props.dimmed,
        working: props.lane.status === "working"
      }}
      style={{
        left: props.rect.x + "px",
        top: props.rect.y + "px",
        width: props.rect.w + "px",
        height: props.rect.h + "px"
      }}
      data-lane={props.lane.name}
      data-role={props.lane.role}
      data-status={props.lane.status}
      data-parent-source={props.lane.parent_source ?? "none"}
      onClick={() => props.onSelect(props.lane.name)}
      tabindex={0}
      aria-label={"Lane " + props.lane.name + " (" + props.lane.role + ", " + props.lane.status + ")"}
    >
      <div class="lane-card-head">
        <span class="lane-name" title={props.lane.name}>
          {props.lane.name}
        </span>
        <span class="role-chip" classList={{ leader: props.lane.role === "leader", worker: props.lane.role === "worker" }}>
          {props.lane.role === "unknown" ? "NO ROLE" : props.lane.role.toUpperCase()}
        </span>
      </div>
      <div class="lane-card-meta">
        <span class="status-pill" classList={{ [statusClass(props.lane.status)]: true }}>
          <span class="status-dot" />
          {props.lane.status}
          <Show when={props.lane.state_change_seq != null}>
            <span class="seq">#{props.lane.state_change_seq}</span>
          </Show>
        </span>
        <span class="lane-model" title={props.lane.model ?? "model unknown"}>
          {shortModel(props.lane.model)}
        </span>
        <Show when={props.lane.context_pct != null}>
          <span class="ctx" title="context used (behold T-3)">
            <span class="ctx-bar">
              <span
                class="ctx-fill"
                style={{ width: Math.min(100, Math.max(2, props.lane.context_pct ?? 0)) + "%" }}
                classList={{ hot: (props.lane.context_pct ?? 0) > 75 }}
              />
            </span>
            {Math.round(props.lane.context_pct ?? 0)}%
          </span>
        </Show>
      </div>
      <div class="lane-card-foot">
        <span class="lane-when" title={"lane record updated " + (props.lane.last_activity ?? "unknown")}>
          {relativeTime(props.lane.last_activity)}
        </span>
        <Show when={props.lane.parent_source === "derived" && props.lane.parent}>
          <span class="derived-chip" title={"parent inferred: " + props.lane.parent + " (no spawn record)"}>
            derived edge
          </span>
        </Show>
        <Show when={props.lane.spawned_by && props.lane.parent_source === "record"}>
          <span class="spawn-chip" title={"PI_SPAWNED_BY=" + props.lane.spawned_by}>
            spawned by record
          </span>
        </Show>
        <div class="lane-actions">
          <button
            class="icon-button small"
            title="Open Work View for this lane"
            aria-label={"Work view for " + props.lane.name}
            onClick={(e) => {
              e.stopPropagation();
              props.onWork(props.lane);
            }}
          >
            <IconWork />
          </button>
          <button
            class="icon-button small"
            classList={{ attention: beadCount() > 0 }}
            title={"Bead cards (" + beadCount() + ")"}
            aria-label={"Bead cards for " + props.lane.name}
            onClick={(e) => {
              e.stopPropagation();
              props.onBeads(props.lane);
            }}
          >
            <IconBeads />
            <Show when={beadCount() > 0}>
              <span class="badge">{beadCount()}</span>
            </Show>
          </button>
          <button
            class="icon-button small"
            title="Operator DM history (read-only)"
            aria-label={"Chat history with " + props.lane.name}
            onClick={(e) => {
              e.stopPropagation();
              props.onChat(props.lane);
            }}
          >
            <IconChat />
          </button>
        </div>
      </div>
    </article>
  );
}
