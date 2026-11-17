/** Shared chrome: top bar, view tabs, freshness, source health, stat strip. */

import { For, Show, type JSX } from "solid-js";
import type { FleetState, SourceStatus } from "../../shared/types.ts";
import { relativeTime } from "../../shared/format.ts";
import { IconRefresh } from "../icons.tsx";

export function ViewTabs(props: { active: "fleet" | "work" }): JSX.Element {
  return (
    <nav class="view-tabs" aria-label="Graph views">
      <a class="view-tab" classList={{ active: props.active === "fleet" }} href="/">
        Fleet
      </a>
      <a class="view-tab" classList={{ active: props.active === "work" }} href="/work">
        Work
      </a>
    </nav>
  );
}

export function SourceHealth(props: { sources: SourceStatus[] | undefined }): JSX.Element {
  const failed = () => (props.sources ?? []).filter((s) => !s.ok);
  return (
    <details class="source-health" classList={{ bad: failed().length > 0 }}>
      <summary>
        <span class="health-dot" classList={{ ok: failed().length === 0 }} />
        <Show when={props.sources} fallback="reading sources…">
          {failed().length === 0 ? "sources ok" : failed().length + " source(s) failed"}
        </Show>
      </summary>
      <div class="source-health-body">
        <For each={props.sources ?? []}>
          {(source) => (
            <div class="source-row" classList={{ bad: !source.ok }}>
              <span class="source-name">{source.name}</span>
              <span class="source-ms">{source.ms}ms</span>
              <span class="source-detail" title={source.detail ?? ""}>
                {source.ok ? source.detail : "FAILED: " + (source.detail ?? "unknown error")}
              </span>
            </div>
          )}
        </For>
      </div>
    </details>
  );
}

export function TopBar(props: {
  view: "fleet" | "work";
  state: FleetState | null;
  fetchedAt: number;
  error: string | null;
  onRefresh: () => void;
  children?: JSX.Element;
}): JSX.Element {
  return (
    <header class="top-bar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true" />
        <span class="brand-name">FLEET<span class="brand-slash">//</span>GRAPH</span>
        <span class="brand-sub">read-only v1</span>
      </div>
      <ViewTabs active={props.view} />
      <div class="top-stats">
        <Show when={props.state}>
          {(state) => (
            <>
              <Stat label="workspaces" value={state().summary.workspaces} />
              <Stat label="lanes" value={state().summary.lanes} />
              <Stat label="working" value={state().summary.working} accent="working" />
              <Stat label="beads open" value={state().summary.beads_open} />
              <Stat label="closed" value={state().summary.beads_closed} />
              <Stat
                label="assigned"
                value={state().summary.assigned}
                title="beads whose assignee names a lane; the rest are joined only where a session record derives them"
              />
            </>
          )}
        </Show>
      </div>
      <div class="top-right">
        {props.children}
        <Show when={props.error}>
          <span class="fetch-error" title={props.error ?? ""}>fetch failed</span>
        </Show>
        <span class="freshness" title={props.fetchedAt ? new Date(props.fetchedAt).toLocaleTimeString() : "not loaded"}>
          {props.fetchedAt ? "synced " + relativeTime(new Date(props.fetchedAt).toISOString()) : "loading"}
        </span>
        <Show when={props.state}>
          {(state) => <SourceHealth sources={state().sources} />}
        </Show>
        <button class="icon-button" onClick={props.onRefresh} title="Refresh now" aria-label="Refresh now">
          <IconRefresh />
        </button>
      </div>
    </header>
  );
}

function Stat(props: { label: string; value: number; accent?: string; title?: string }): JSX.Element {
  return (
    <div class="stat" classList={{ [props.accent ?? ""]: Boolean(props.accent) }} title={props.title}>
      <span class="stat-value">{props.value}</span>
      <span class="stat-label">{props.label}</span>
    </div>
  );
}
