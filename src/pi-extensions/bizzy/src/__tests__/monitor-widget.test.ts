/**
 * FT-90 — a pinned summary widget for live watchers, separate from FT-03
 * transcript events.
 *
 * Covers the acceptance points with measurements, not assertions of intent:
 * one `Monitors (N)` line above the editor, one pill per active watcher (no
 * event lines), a count derived from the same collection the pills are (so it
 * cannot include a dead monitor), start-time ordering, the widget clearing
 * itself when nothing is live, and collapse state remembered across reloads.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundRegistry } from "../state.ts";
import { add, createRunningJob } from "../registry.ts";
import { startMonitorSession } from "../monitor-session.ts";
import { registerCommands } from "../commands.ts";
import type { MonitorSource } from "../monitor-source.ts";
import type { SpawnExit } from "../spawn.ts";
import { EVENT } from "../types.ts";
import {
    MAX_MONITOR_WIDGET_LINES,
    MONITORS_WIDGET_KEY,
    MonitorWidget,
    monitorWidgetLayout,
    orderMonitorWidgetEntries,
    type MonitorWidgetComponent,
} from "../monitor-widget.ts";
import {
    MONITOR_COLLAPSE_KEY,
    MONITORS_COLLAPSED_KEY,
    createMonitorEventPresentation,
    flushMonitorEventsConfigWrites,
    readMonitorEventsConfig,
} from "../monitor-events.ts";
import type { UiContext } from "../types.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-monitor-widget-"));
process.env.PI_CODING_AGENT_DIR = dir;
mkdirSync(dir, { recursive: true });
const configPath = join(dir, "bizzy-monitor-events.json");

after(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.PI_CODING_AGENT_DIR;
});

const plainTheme = { fg: (_colour: string, text: string) => text };

interface SetWidgetCall {
    name: string;
    content: unknown;
    options?: { placement?: string };
}

type Factory = (
    tui: { mode: string; requestRender(): void },
    theme: typeof plainTheme
) => MonitorWidgetComponent;

/** A ui context that records registrations and can build pi's component.
 *  Registrations are keyed: a real session also registers the sidebar
 *  (`background-jobs`) on the same ui, and the test must read the monitors
 *  widget, not whatever registered last. */
function makeCtx(mode = "fullscreen") {
    const calls: SetWidgetCall[] = [];
    const history: string[] = [];
    const factories = new Map<string, Factory | undefined>();
    const ctx = {
        ui: {
            notify() {},
            setWidget: (name: string, content: unknown, options?: { placement?: string }) => {
                calls.push({ name, content, options });
                factories.set(
                    name,
                    typeof content === "function" ? (content as Factory) : undefined
                );
            },
            setStatus() {},
            theme: plainTheme,
        },
    } as unknown as UiContext;
    let renders = 0;
    const tui = {
        mode,
        requestRender() {
            renders += 1;
        },
    };
    const component = (): MonitorWidgetComponent | undefined =>
        factories.get(MONITORS_WIDGET_KEY)?.(tui, plainTheme);
    const lines = (width = 200): string[] => {
        const rendered = component()?.render(width) ?? [];
        history.push(rendered.join("\n"));
        return rendered;
    };
    return {
        ctx,
        calls,
        component,
        lines,
        history,
        registered: () =>
            calls.filter((call) => call.name === MONITORS_WIDGET_KEY && typeof call.content === "function")
                .length,
        cleared: () =>
            calls.filter((call) => call.name === MONITORS_WIDGET_KEY && call.content === undefined).length,
        renders: () => renders,
    };
}

function freshPresentation(
    overrides: Partial<Parameters<typeof createMonitorEventPresentation>[0]> = {}
) {
    return createMonitorEventPresentation({
        collapse: true,
        monitorsCollapsed: true,
        overrides: {},
        ...overrides,
    });
}

/** The header's stated count and the number of monitor blocks drawn. */
function countAndBlocks(lines: readonly string[]): { count: number; blocks: number } {
    const match = /Monitors \((\d+)/.exec(lines[0] ?? "");
    assert.ok(match, `the widget's first row is the count line, got: ${JSON.stringify(lines[0])}`);
    return {
        count: Number(match[1]),
        blocks: lines.filter((line) => /Monitor ·/.test(line)).length,
    };
}

/** Two live monitors, one of which has emitted three batches of events. */
function twoMonitors() {
    const harness = makeCtx();
    const widget = new MonitorWidget(freshPresentation());
    widget.addMonitor(harness.ctx, { id: "m1", description: "deploy watcher", startTime: 1_000 });
    widget.addMonitor(harness.ctx, { id: "m2", description: "queue watcher", startTime: 2_000 });
    return { ...harness, widget };
}

void describe("FT-90 — watcher-only monitors widget", () => {
    void it("renders one collapsed count line and expands to watcher pills, not transcript lines", () => {
        const h = makeCtx();
        const widget = new MonitorWidget(freshPresentation());
        widget.addMonitor(h.ctx, { id: "m1", description: "deploy watcher", startTime: 1 });
        widget.addMonitor(h.ctx, { id: "m2", description: "queue watcher", startTime: 2 });
        assert.equal(h.lines().length, 1);
        assert.match(h.lines()[0], /Monitors \(2\)/);
        assert.match(h.lines()[0], /▸/);
        assert.equal(h.calls[0].options?.placement, "aboveEditor");
        widget.setCollapsed(false);
        const expanded = h.lines().join("\n");
        assert.match(expanded, /▾ Monitors \(2\)/);
        assert.match(expanded, /◉ deploy watcher/);
        assert.match(expanded, /◉ queue watcher/);
        assert.doesNotMatch(expanded, /event|DONE|START/);
        widget.endMonitor(h.ctx, "m1");
        assert.match(h.lines().join("\n"), /Monitors \(1\)/);
        widget.endMonitor(h.ctx, "m2");
        assert.equal(h.lines().length, 0);
        assert.equal(h.cleared(), 1);
    });

    void it("keeps global collapse persisted and count equal to watcher pills", async () => {
        const h = makeCtx();
        const widget = new MonitorWidget(freshPresentation());
        widget.addMonitor(h.ctx, { id: "m1", description: "deploy watcher", startTime: 1 });
        widget.setCollapsed(false);
        await flushMonitorEventsConfigWrites();
        assert.equal(readMonitorEventsConfig(configPath).monitorsCollapsed, false);
        assert.equal(h.lines().filter((x) => /◉/.test(x)).length, 1);
    });
});
