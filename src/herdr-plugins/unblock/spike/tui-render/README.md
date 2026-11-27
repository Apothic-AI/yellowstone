# TUI render spike (page asks in a terminal)

Throwaway harness proving that an agent-authored page ask can be rendered and answered inside a
terminal pane. See `research/tui-render-spike-findings.md` in the Yellowstone tree for the
measurements and the verdict.

- `ask-page.html` — the page an agent would author: one field, one button, fixed geometry so a
  blind click has a known target.
- `bootstrap.mjs` — starts a throwaway daemon on an ephemeral port, files this as a real page ask,
  mints a ticket-scoped link, prints the page URL, then WAITS for the answer exactly as a parked
  agent does.
- `app.mjs` — the whole pixel app: one full-size WebView on that URL, plus a report of the engine's
  geometry/renderer and every key it receives (`SPIKE_REPORT=<file>`).

Run it:

```bash
npm install @zenbu-labs/pixel@0.3.4 react@18   # in a scratch dir; pulls a patched Electron
node bootstrap.mjs                              # prints PAGE_URL / TICKET, then waits
node node_modules/.bin/pixel <path>/app.mjs -- "<PAGE_URL>"
```

Not part of the package: `spike/` is absent from the `files` list in `package.json`.
