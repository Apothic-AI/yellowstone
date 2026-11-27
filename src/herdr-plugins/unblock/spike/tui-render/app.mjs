// The spike's whole pixel app: one full-size WebView on the page ask's own URL.
// Deliberately smaller than a real integration — the question this answers is whether the
// pixel/embedded route can show a page ask and take input, not how the unblock TUI should
// compose it.
import { appendFileSync } from "node:fs";
import { createRoot } from "@zenbu-labs/pixel";

const url = process.argv[2] || process.env.SPIKE_URL;
if (!url) {
  console.error("usage: pixel <this-file> -- <page-url>");
  process.exit(2);
}

const report = (line) => {
  if (process.env.SPIKE_REPORT) appendFileSync(process.env.SPIKE_REPORT, line + "\n");
  console.error("[spike] " + line);
};

const root = createRoot({
  onKey(event) {
    report("key " + JSON.stringify(event));
    if (event.kind === "press" && event.mods?.ctrl && event.key === "c") {
      root.stop();
      return true;
    }
  },
});

const info = root.info;
report("info " + JSON.stringify({
  width: info?.width, height: info?.height,
  cellWidth: info?.cellWidth, cellHeight: info?.cellHeight,
  basePx: info?.basePx, renderer: info?.renderer,
  device: info?.device, hosted: info?.hosted, kittyKeyboard: info?.kittyKeyboard,
}));

const page = root.loadURL(url);
page.onChange((state) => {
  report("page " + JSON.stringify({ url: state.url, title: state.title, loading: state.loading }));
  root.setTitle?.(state.title || "page ask");
});
