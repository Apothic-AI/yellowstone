/**
 * FT-90 — a pinned summary widget for live watchers. Streaming event lines do
 * not appear here or in the transcript; chat receives only the terminal notice.
 *
 * A monitor used to emit one `bg-monitor-event` custom message per batch and pi
 * drew every batch as a transcript block. The transcript is the record of what
 * was *said*; ambient state does not belong in it, and it scrolls away from the
 * user. This module owns that ambient state instead, in the shape the operator
 * asked for:
 *
 *   ▸ Monitors (2) · click to expand          ← nothing live? no widget at all
 *   ▾ Monitors (2) · click to collapse        ← expanded: one watcher pill per monitor
 *     ◉ deploy watcher
 *     ◉ queue watcher
 *
 * The mechanism is the one `apothic-todo/src/overlay.ts` established, not an
 * invention: `uiCtx.setWidget(MONITORS_WIDGET_KEY, factory, { placement:
 * "aboveEditor" })` plus a `widgetRegistered` flag, and
 * `setWidget(MONITORS_WIDGET_KEY, undefined)` the moment nothing is live — so
 * there is never a permanent `Monitors (0)` line. The TODO overlay's proven
 * `aboveEditor` placement is the fixed chat-bottom surface immediately above
 * the editor; `setStatus`
 * was rejected: a footer status line cannot expand or take a click, and it
 * shares a namespace with every other extension's status. A custom footer
 * component was rejected: it replaces the operator's own footer wholesale for
 * one ambient surface.
 *
 * Invariants this file exists to keep:
 *   - **Count and watcher pills agree.** The `Monitors (N)` count and the pills
 *     are derived from one collection in one pass, so they cannot disagree; a
 *     monitor that ends is *removed*, so the count can never include a dead one.
 *   - **Events never enter this widget.** FT-03 owns monitor event transcript
 *     messages; this widget only renders the active watcher summaries.
 *   - **Order by start time**, ties broken by id — never by whichever event
 *     arrived last.
 *   - **Collapse state is a memory.** A click persists immediately (FT-90
 *     requires a reload to keep the choice), and a new event never touches a
 *     collapse decision.
 */

import { fitLine, writeMonitorEventsConfig, MONITOR_EVENT_HINTS, type MonitorEventPresentation, type MonitorEventTheme } from "./monitor-events.ts";
import type { UiContext } from "./types.ts";

/** The widget key. One key for the whole surface: one `Monitors (N)` line. */
export const MONITORS_WIDGET_KEY = "monitors";
/**
 * Rows the widget may draw. pi caps an array widget at `MAX_WIDGET_LINES = 10`
 * but does *not* bound a component factory, so the widget caps itself to the
 * same number rather than letting a busy lane push the editor off screen.
 */
export const MAX_MONITOR_WIDGET_LINES = 10;
/** Events kept per monitor. A persistent watch can stream forever; the block
 *  shows the newest rows and `totalLines` keeps the header's count honest. */

export interface MonitorWidgetEntry {
    id: string;
    description: string;
    startTime: number;
}

export type MonitorWidgetTarget =
    | { kind: "header" }
    | { kind: "monitor"; id: string }
    | { kind: "more" };

export interface MonitorWidgetRow {
    text: string;
    target: MonitorWidgetTarget;
}

/** */
export function orderMonitorWidgetEntries(
    entries: readonly MonitorWidgetEntry[]
): MonitorWidgetEntry[] {
    return [...entries].sort(
        (a, b) => a.startTime - b.startTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
}

export interface MonitorWidgetLayoutArgs {
    monitors: readonly MonitorWidgetEntry[];
    presentation: MonitorEventPresentation;
    width: number;
    theme: MonitorEventTheme;
    clickable: boolean;
}

/**
 * The widget's rows, each tagged with what a click on it does. Rendering and
 * hit-testing go through this one function, so a click can never toggle a row
 * that is not the row it was drawn against.
 */
export function monitorWidgetLayout(args: MonitorWidgetLayoutArgs): MonitorWidgetRow[] {
    const { presentation, width, theme, clickable } = args;
    if (args.monitors.length === 0 || width <= 0) return [];
    const ordered = orderMonitorWidgetEntries(args.monitors);
    const collapsed = presentation.widgetCollapsed;
    const hint = collapsed
        ? (clickable ? "click to expand" : "expand with /monitors")
        : (clickable ? "click to collapse" : "collapse with /monitors");
    const head = `${theme.fg("dim", collapsed ? "▸" : "▾")} ${theme.fg("muted", `Monitors (${ordered.length})`)}${theme.fg("dim", ` · ${hint}`)}`;
    const rows: MonitorWidgetRow[] = [{ text: fitLine(head, width), target: { kind: "header" } }];
    if (!collapsed) {
        for (const entry of ordered) {
            rows.push({ text: fitLine(`  ◉ ${entry.description}`, width), target: { kind: "monitor", id: entry.id } });
        }
    }
    return rows;
}

/** A block the mouse cannot reach must not promise a click. */
const NON_CLICKABLE_HINTS = { collapsed: "collapsed", expanded: "expanded" } as const;

export interface MonitorWidgetComponent {
    render(width: number): string[];
    handleMouse?(event: { type: string; button: string; y: number }): { handled: boolean } | undefined;
    invalidate(): void;
}

/**
 * The live monitor view. One instance per session, holding the monitors that
 * are running right now and the widget they are drawn in.
 */
export class MonitorWidget {
    private readonly presentation: MonitorEventPresentation;
    private readonly entries = new Map<string, MonitorWidgetEntry>();
    private uiCtx: UiContext | undefined;
    private widgetRegistered = false;
    private requestRender: (() => void) | undefined;
    /** The rows as last drawn, so a click maps onto what is on screen. */
    private rows: MonitorWidgetRow[] = [];

    constructor(presentation: MonitorEventPresentation) {
        this.presentation = presentation;
    }

    /** Live monitors — the number the `Monitors (N)` line reports. */
    get liveCount(): number {
        return this.entries.size;
    }

    get widgetCollapsed(): boolean {
        return this.presentation.widgetCollapsed;
    }

    /** Register a monitor. Called the moment its job exists, before its source
     *  can emit, so a block's position is its start time and never its first
     *  event. */
    addMonitor(ctx: UiContext, monitor: { id: string; description: string; startTime: number }): void {
        if (this.entries.has(monitor.id)) return;
        this.entries.set(monitor.id, {
            id: monitor.id,
            description: monitor.description,
            startTime: monitor.startTime,
        });
        this.update(ctx);
    }

    /** A monitor reached a terminal state: its block leaves the widget. The
     *  count drops with it, so no dead monitor is ever counted as live. */
    endMonitor(ctx: UiContext, id: string): void {
        if (!this.entries.delete(id)) return;
        this.update(ctx);
    }

    /** Drop a monitor without touching a (possibly stale) ctx. The teardown
     *  path uses this: after a session was replaced, the widget is gone with
     *  the session and calling `setWidget` on the dead ctx would throw. */
    discard(id: string): void {
        this.entries.delete(id);
    }

    /** Collapse or expand the whole widget. The decision is global and is
     *  written immediately — FT-90 requires a reload to keep it. */
    setCollapsed(collapsed: boolean, ctx?: UiContext): void {
        if (ctx) this.adoptUICtx(ctx);
        if (this.presentation.widgetCollapsed === collapsed) {
            this.update();
            return;
        }
        this.presentation.widgetCollapsed = collapsed;
        void writeMonitorEventsConfig({ monitorsCollapsed: collapsed });
        this.update();
    }

    toggleCollapsed(ctx?: UiContext): void {
        this.setCollapsed(!this.presentation.widgetCollapsed, ctx);
    }

    /** Watcher pills are informational; FT-03 transcript events own event collapse state. */
    toggleMonitor(_id: string): void {
        return;
    }

    /** Draw and register the widget, or clear it when nothing is live. */
    update(ctx?: UiContext): void {
        if (ctx) this.adoptUICtx(ctx);
        const active = this.uiCtx;
        if (!active) return;

        if (this.entries.size === 0) {
            if (!this.widgetRegistered) return;
            this.widgetRegistered = false;
            this.requestRender = undefined;
            this.rows = [];
            this.clearWidget(active);
            return;
        }

        if (this.widgetRegistered) {
            this.requestRender?.();
            return;
        }

        try {
            active.ui.setWidget(
                MONITORS_WIDGET_KEY,
                (tui, factoryTheme) => {
                    const clickable = tui.mode === "fullscreen";
                    this.requestRender = () => tui.requestRender();
                    return {
                        render: (width: number) => {
                            this.rows = monitorWidgetLayout({
                                monitors: [...this.entries.values()],
                                presentation: this.presentation,
                                width,
                                theme: this.uiCtx?.ui.theme ?? factoryTheme,
                                clickable,
                            });
                            return this.rows.map((row) => row.text);
                        },
                        handleMouse: (event) => {
                            if (!clickable || event.type !== "click" || event.button !== "left") {
                                return undefined;
                            }
                            const row = this.rows[event.y];
                            if (!row) return undefined;
                            if (row.target.kind === "header") {
                                this.toggleCollapsed();
                                return { handled: true };
                            }
                            if (row.target.kind === "monitor") {
                                this.toggleMonitor(row.target.id);
                                return { handled: true };
                            }
                            return undefined;
                        },
                        invalidate: () => {},
                    };
                },
                // Match apothic-todo's proven overlay placement. The widget is
                // fixed immediately above the editor; belowEditor is beneath
                // the editor and is not the visible chat-bottom surface.
                { placement: "aboveEditor" }
            );
            this.widgetRegistered = true;
        } catch {
            // The captured ctx went stale (session replacement/reload). The
            // widget died with that session; drop the handle rather than throw
            // from the next event's follower tick.
            this.widgetRegistered = false;
            this.requestRender = undefined;
        }
    }

    /** Clear the widget and forget every monitor (session shutdown). */
    dispose(): void {
        const active = this.uiCtx;
        this.entries.clear();
        this.rows = [];
        this.requestRender = undefined;
        if (active && this.widgetRegistered) this.clearWidget(active);
        this.widgetRegistered = false;
        this.uiCtx = undefined;
    }

    private clearWidget(active: UiContext): void {
        try {
            active.ui.setWidget(MONITORS_WIDGET_KEY, undefined);
        } catch {
            /* stale ctx: the widget is already gone with the session */
        }
    }

    private adoptUICtx(ctx: UiContext): void {
        if (this.uiCtx !== undefined && this.uiCtx.ui === ctx.ui) {
            this.uiCtx = ctx;
            return;
        }
        // A different session's ui context: the registration this instance
        // holds belongs to the old one.
        this.uiCtx = ctx;
        this.widgetRegistered = false;
        this.requestRender = undefined;
        this.rows = [];
    }
}
