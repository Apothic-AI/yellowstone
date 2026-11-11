import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, Measurements, measure, median, type Config } from "./metrics.ts";
import { appendMeasurement, loadConfig, saveConfig, statsDirectory } from "./storage.ts";

const CONTENT_START = new Set(["text_start", "thinking_start", "toolcall_start"]);
const HELP = "/tps-stats [reset | mode [toggle|period|latest] | period <1..86400 seconds> | log [toggle|on|off] | save]";

// Exported factory supports a fake clock and scratch directory without a Pi runtime.
export function createStatsExtension(options: { directory?: string; now?: () => number } = {}) {
  return (pi: ExtensionAPI): void => {
    const directory = options.directory ?? statsDirectory();
    const now = options.now ?? Date.now;
    const samples = new Measurements();
    let config: Config = { ...DEFAULT_CONFIG };
    let start: number | undefined;
    let first: number | undefined;
    // Serialize disk writes with log toggles: after `log off` returns no write remains queued.
    let writes: Promise<void> = Promise.resolve();

    function notify(ctx: ExtensionContext, text: string, kind: "info" | "warning" | "error" = "info") {
      if (ctx.hasUI) ctx.ui.notify(text, kind);
    }
    function summary(): string {
      const selected = samples.select(config, now());
      const header = `TPS stats: ${config.mode}${config.mode === "period" ? ` ${config.periodSeconds}s (max 200 samples)` : ""}; logging ${config.logging ? "on" : "off"}`;
      if (!selected.length) return `${header}\nNo measurements in this view.`;
      const ttfts = selected.flatMap(sample => sample.ttftMs === null ? [] : [sample.ttftMs]);
      return `${header}\nSamples: ${selected.length}\neff ${median(selected.map(sample => sample.tps)).toFixed(1)} t/s` +
        (ttfts.length ? ` | ${Math.round(median(ttfts))}ms ttft` : " | ttft unavailable");
    }
    function update(ctx: ExtensionContext) {
      if (!ctx.hasUI) return;
      const selected = samples.select(config, now());
      ctx.ui.setStatus("tps", selected.length ? summary().replaceAll("\n", " | ") : undefined);
    }
    function reset(ctx: ExtensionContext) {
      samples.reset(); start = undefined; first = undefined; update(ctx);
    }
    pi.on("session_start", async (_event, ctx) => {
      await writes;
      config = { ...DEFAULT_CONFIG };
      try { config = await loadConfig(directory); }
      catch { notify(ctx, "TPS stats: config unreadable/invalid; using defaults, logging off.", "warning"); }
      reset(ctx);
    });
    pi.on("session_shutdown", async (_event, ctx) => {
      await writes; reset(ctx);
    });
    pi.on("model_select", (_event, ctx) => reset(ctx));
    pi.on("turn_start", (event) => { start = event.timestamp; first = undefined; });
    pi.on("message_update", (event) => {
      if (start !== undefined && first === undefined && CONTENT_START.has(event.assistantMessageEvent.type)) first = now();
    });
    pi.on("message_end", async (event, ctx) => {
      if (event.message.role !== "assistant" || start === undefined) return;
      const sample = measure(event.message.usage.output, start, first, now());
      start = undefined; first = undefined;
      if (!sample) return;
      samples.add(sample); update(ctx);
      if (!config.logging) return;
      const sessionId = ctx.sessionManager.getSessionId();
      writes = writes.then(() => appendMeasurement(directory, sessionId, sample)).catch(() => {
        config.logging = false;
        notify(ctx, "TPS stats: metric log write failed; logging disabled.", "error");
        update(ctx);
      });
      await writes;
    });
    pi.registerCommand("tps-stats", {
      description: "TPS/TTFT metrics: reset, mode, period, log, save (global defaults)",
      handler: async (args, ctx) => {
        const [command, value, ...extra] = args.trim().split(/\s+/);
        if (extra.length) { notify(ctx, HELP, "warning"); return; }
        switch (command) {
          case "": break;
          case "reset":
            if (value) { notify(ctx, HELP, "warning"); return; }
            reset(ctx); notify(ctx, "TPS stats: measurements reset (existing JSONL retained)."); return;
          case "mode":
            if (!value || value === "toggle") config.mode = config.mode === "period" ? "latest" : "period";
            else if (value === "period" || value === "latest") config.mode = value;
            else { notify(ctx, HELP, "warning"); return; }
            break;
          case "period": {
            const seconds = Number(value);
            if (!/^\d+$/.test(value ?? "") || !Number.isInteger(seconds) || seconds < 1 || seconds > 86400) {
              notify(ctx, HELP, "warning"); return;
            }
            config.periodSeconds = seconds; break;
          }
          case "log":
            if (value && !["toggle", "on", "off"].includes(value)) { notify(ctx, HELP, "warning"); return; }
            await writes;
            config.logging = value === "on" || ((value === undefined || value === "toggle") && !config.logging);
            break;
          case "save":
            if (value) { notify(ctx, HELP, "warning"); return; }
            try { await saveConfig(directory, config); notify(ctx, "TPS stats: global defaults saved."); }
            catch { notify(ctx, "TPS stats: could not save global defaults.", "error"); }
            return;
          default: notify(ctx, HELP, "warning"); return;
        }
        update(ctx); notify(ctx, summary());
      },
    });
  };
}
export default createStatsExtension();
