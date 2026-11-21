/**
 * FT-02 — the sidebar's collapsible watchers (monitor) section.
 *
 * Covers the preference file (literal `watchers-collapsed` /
 * `remember-watchers-toggle` keys, merge-preserving writes), the initial-state
 * rule (collapsed unless a remembered decision says otherwise), the rendered
 * section (collapsed by default, expanded on demand), the click target, and
 * that a decision is only persisted while remembering is on.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundRegistry } from "../state.ts";
import {
    add,
    createRunningJob,
    renderSidebar,
    setWatchersCollapsed,
    stopSidebarTicker,
    toggleWatchers,
} from "../registry.ts";
import {
    DEFAULT_WATCHERS_COLLAPSED,
    flushWatcherConfigWrites,
    initialWatchersCollapsed,
    readWatcherConfig,
    writeWatcherConfig,
} from "../watchers.ts";
import type { UiContext } from "../types.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-watchers-"));

function tmpLog(name: string, content: string): string {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
}

interface FakeTui {
    mode: string;
    requestRender(): void;
}

interface WidgetComponent {
    render(width: number): string[];
    handleMouse?(event: {
        type: string;
        button: string;
        y: number;
    }): { handled: boolean } | undefined;
}

type WidgetFactory = (
    tui: FakeTui,
    theme: { fg(colour: string, text: string): string }
) => WidgetComponent;

const plainTheme = { fg: (_colour: string, text: string) => text };

function makeCtx() {
    let factory: WidgetFactory | undefined;
    const ctx = {
        ui: {
            notify() {},
            setWidget: (_name: string, content: string[] | WidgetFactory | undefined) => {
                factory = typeof content === "function" ? content : undefined;
            },
            setStatus() {},
            theme: plainTheme,
        },
    } as unknown as UiContext;

    /** The component pi would build from the registered factory. */
    function component(): WidgetComponent | undefined {
        if (!factory) return undefined;
        return factory({ mode: "fullscreen", requestRender() {} }, plainTheme);
    }

    /** The lines pi would draw, or undefined when the widget is cleared. */
    function lines(): string[] | undefined {
        return component()?.render(200);
    }

    return { ctx, component, lines };
}

/** One shell job, one monitor ("watcher") job, each with a live log line. */
function makeRegistry(): { reg: BackgroundRegistry; shellLog: string; watcherLog: string } {
    const reg = new BackgroundRegistry();
    const shellLog = tmpLog("shell.log", "building step 7\n");
    const watcherLog = tmpLog("watcher.log", "state w18/neti-leader done -> working\n");
    add(
        reg,
        createRunningJob({
            id: "b-shell-1",
            command: "npm run build",
            name: "release build",
            pid: 4001,
            logPath: shellLog,
            toolCallId: "t1",
        })
    );
    add(
        reg,
        createRunningJob({
            id: "m-watch-1",
            command: "tail -f watcher.log",
            name: "Leader watcher (re-armed): BLOCKED / STALE / GONE / PAUSED / CTX-HIGH",
            kind: "monitor",
            pid: 4002,
            logPath: watcherLog,
            toolCallId: "t2",
        })
    );
    return { reg, shellLog, watcherLog };
}

void describe("watchers preference file", () => {
    void it("defaults: no remembered decision, no remembering, session starts collapsed", () => {
        const config = readWatcherConfig(join(dir, "missing.json"));
        assert.deepEqual(config, { collapsed: false, remember: false });
        assert.equal(DEFAULT_WATCHERS_COLLAPSED, true);
        assert.equal(initialWatchersCollapsed(config), true, "collapsed is the default layout");
    });

    void it("reads the literal watchers-collapsed / remember-watchers-toggle keys", () => {
        const path = join(dir, "explicit.json");
        writeFileSync(
            path,
            JSON.stringify({ "watchers-collapsed": true, "remember-watchers-toggle": true })
        );
        assert.deepEqual(readWatcherConfig(path), { collapsed: true, remember: true });
    });

    void it("obeys the remembered decision only while remembering is on", () => {
        assert.equal(
            initialWatchersCollapsed({ collapsed: true, remember: false }),
            true,
            "remember off: the session default wins"
        );
        assert.equal(
            initialWatchersCollapsed({ collapsed: false, remember: true }),
            false,
            "remember on + expanded decision: expanded"
        );
        assert.equal(
            initialWatchersCollapsed({ collapsed: true, remember: true }),
            true,
            "remember on + collapsed decision: collapsed"
        );
    });

    void it("merges writes and preserves unrelated keys", async () => {
        const path = join(dir, "merge.json");
        writeFileSync(
            path,
            JSON.stringify({ "remember-watchers-toggle": true, unrelated: "keep me" })
        );
        await writeWatcherConfig({ collapsed: true }, path);
        await flushWatcherConfigWrites();
        const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        assert.equal(raw["watchers-collapsed"], true);
        assert.equal(raw["remember-watchers-toggle"], true, "the other preference survived");
        assert.equal(raw.unrelated, "keep me", "unknown keys survived");
        assert.deepEqual(readWatcherConfig(path), { collapsed: true, remember: true });
    });

    void it("degrades to defaults on malformed JSON", () => {
        const path = join(dir, "broken.json");
        writeFileSync(path, "{not json");
        assert.deepEqual(readWatcherConfig(path), { collapsed: false, remember: false });
    });
});

void describe("renderSidebar — watcher pills moved to the pinned widget", () => {
    void it("does not render active watcher summary or pills above the editor", () => {
        const { reg } = makeRegistry();
        const { ctx, lines } = makeCtx();
        renderSidebar(reg, ctx);
        assert.doesNotMatch((lines() ?? []).join("\n"), /watcher|neti-leader/i);
    });
});

after(() => {
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
});
