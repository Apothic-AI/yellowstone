/** Right-side bead cards for one lane. */

import { For, Show, type JSX } from "solid-js";
import type { Bead, LaneRecord } from "../../shared/types.ts";
import { relativeTime } from "../../shared/format.ts";
import { IconClose } from "../icons.tsx";

export function BeadDrawer(props: {
  lane: LaneRecord;
  beads: Bead[];
  onClose: () => void;
}): JSX.Element {
  const assigned = () => props.beads.filter((b) => b.assignee === props.lane.name);
  const derived = () => props.beads.filter((b) => b.assignee !== props.lane.name && b.derived_lanes.includes(props.lane.name));
  return (
    <aside class="drawer" aria-label={"Bead cards for " + props.lane.name}>
      <header class="drawer-head">
        <div>
          <h2>{props.lane.name}</h2>
          <p class="drawer-sub">
            {props.lane.role} · {props.lane.workspace_label} · <span class="mono">{props.lane.key}</span>
          </p>
        </div>
        <button class="icon-button" onClick={props.onClose} aria-label="Close bead panel">
          <IconClose />
        </button>
      </header>
      <div class="drawer-body">
        <Show
          when={assigned().length + derived().length > 0}
          fallback={
            <div class="empty-note">
              <p>No bead names this lane as <span class="mono">assignee</span>, and no recorded session command was derived.</p>
              <p>
                The authoritative join is <span class="mono">bd assign &lt;id&gt; {props.lane.name}</span> at claim time. The derived
                column appears when this lane's own session record mentions a bead in a <span class="mono">bd</span> command.
              </p>
            </div>
          }
        >
          <Show when={assigned().length > 0}>
            <h3 class="drawer-section">Assigned ({assigned().length})</h3>
            <For each={assigned()}>{(bead) => <BeadCard bead={bead} kind="assigned" />}</For>
          </Show>
          <Show when={derived().length > 0}>
            <h3 class="drawer-section">Derived from this lane's session ({derived().length})</h3>
            <For each={derived()}>{(bead) => <BeadCard bead={bead} kind="derived" />}</For>
          </Show>
        </Show>
      </div>
      <footer class="drawer-foot">
        <a class="link-button" href={"/work?lane=" + encodeURIComponent(props.lane.name)}>
          Open in Work View →
        </a>
      </footer>
    </aside>
  );
}

function BeadCard(props: { bead: Bead; kind: "assigned" | "derived" }): JSX.Element {
  return (
    <a class="bead-card" href={"/work?bead=" + encodeURIComponent(props.bead.id)} data-bead-id={props.bead.id}>
      <div class="bead-card-top">
        <span class="bead-id mono">{props.bead.id}</span>
        <span class="bead-status" classList={{ [props.bead.status]: true }}>
          {props.bead.status}
        </span>
      </div>
      <p class="bead-title">{props.bead.title}</p>
      <div class="bead-card-foot">
        <span class="bead-type">{props.bead.issue_type}</span>
        <span class="bead-project">{props.bead.project ? "project:" + props.bead.project : "no project"}</span>
        <span class="bead-when">{relativeTime(props.bead.updated_at)}</span>
        <span class="join-chip" classList={{ derived: props.kind === "derived" }}>
          {props.kind === "derived" ? "derived" : "assignee"}
        </span>
      </div>
    </a>
  );
}
