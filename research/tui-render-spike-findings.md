# TUI render spike — findings (2026-11-27Z)

Timeboxed proof of concept for rendering a **page ask** in a terminal pane, as directed by the
brief's `TUI render spike` section. Verdict up front:

**The pixel/embedded route won. It works, at true 24-bit fidelity, with real input, inside a
herdr pane. The CDP-screencast fallback was not built and is not needed.** The spike's most
valuable output was not the render — it was the defect the render exposed, described under
"What it found".

## What was measured (not inferred)

Environment: Node 22.23.3, X11 `DISPLAY=:1`, GPU present (`/dev/dri/card0`, `renderD128`),
ghostty 1.1.3-dev, inside herdr (`TERM_PROGRAM=herdr`, `TERM=xterm-256color`).

| Question | Measured answer |
|---|---|
| Does the runtime install? | `@zenbu-labs/pixel@0.3.4` + `react@18`: postinstall fetched a patched Electron; 282 MB, 30 s, exit 0 |
| Which renderer does it pick? | `renderer: "kitty"`, `device: {name:"pixels", lattice:[1,1], colors:"truecolor", pointer:"precise"}`, `kittyKeyboard: true` |
| Fidelity | The window capture contains the page's own CSS colours exactly: `#0B0F14` 504,467 px, `#111823` 19,458 px, `#2F81F7` 8,597 px, `#E6EDF3` text. That is 24-bit truecolour, not sixel or ANSI half-blocks |
| Does a click reach a control? | Real X pointer click on the field (`xdotool mousemove --window … 300 277; click 1`) focused it; the caret rendered |
| Does a keystroke type into a field? | `xdotool type 'Tuesday 02:00 UTC'` typed into the focused field; the text rendered |
| Does submit post and wake the agent? | `ANSWERED {"_submitted_at":…,"when":"Tuesday 02:00 UTC"}` and `VIA share-link:local` — the parked bootstrap (the "agent") returned |
| In a herdr pane? | Pane `w17:p4W`, `herdr pane run … node node_modules/.bin/pixel app.mjs -- <page-url>`: `renderer:"kitty"`, `width:264 height:544 cellWidth:8 cellHeight:16`; `herdr pane send-text 'Tuesday 02:00 UTC'` reached the field and `send-keys Enter` submitted — `ANSWERED` again |

Geometry note: the page area measured 1122×722 device pixels in a window whose engine geometry
was 990×550 CSS px at `cellWidth 10 / cellHeight 22` — i.e. the sheet arrives at 1:1 with the
page's CSS pixel grid, so a page authored with ordinary CSS lays out where it says it will.

## What it found — the reason this spike was worth running

The first browser submission was rejected:

    [spike-debug] origin reject {"origin":"null","host":"127.0.0.1:34345","actualPort":34345,
                                 "url":"/u/<token>/api/asks/ub_ff3k9a/submit","method":"POST"}

`Origin: null` is what a browser sends from a document with an **opaque origin**, and the page
ask had one because I served it with `Content-Security-Policy: sandbox allow-forms allow-scripts`
— the sandbox that stops an agent-authored page from reading the daemon's origin. So the very
hardening that made the feature safe made every real submission fail its CSRF check.

Every test passed, because every test was `fetch` from Node: **no test sent an `Origin` header at
all**, so the guard's only reachable branch was "absent Origin → allow". A header-less client
cannot see this bug; only a browser can. The feature would have shipped, looked right in review,
and been unanswerable in the one place a human actually uses it.

Fix (in this commit): `validateOriginHeader` accepts `null` **only** for `POST` to
`/api/asks/<ticket>/{page,page.html,submit}` — the sandboxed submit surface — and refuses it
everywhere else. Safe because those routes are authorised by the per-ticket link token in the
path, or have already passed the bearer check, and the daemon sets **no cookies at all**
(verified: no `Set-Cookie` in `src/daemon.js`), so a cross-site form cannot authenticate to them.
Pinned by three assertions: `null` accepted on submit; a foreign origin still 403; `null` on
`POST /api/asks` still 403.

## Costs and limits, stated rather than glossed

- **The React card is still unbuilt** (`web/dist` absent, `vite` not installed). This spike does
  not depend on it: the page and its shell are served by the daemon.
- **A page ask costs a Chromium renderer process** (hundreds of MB, per the PixelGUI docs — their
  native React API is <10 MB, a WebView is a full renderer). The unblock plugin currently has no
  runtime dependencies beyond Node's standard library; embedding pixel adds a 282 MB patched
  Electron. It must stay **optional and on demand**, and `spike/` must stay out of the package's
  `files` list (it is: `files` lists `src/ bin/ web/dist/ plugin/ hooks/ skills/` and the
  manifests, not `spike/`).
- **Multiplexer caveat is real but not fatal here.** PixelGUI warns multiplexers degrade
  performance and can lose capabilities. Measured in herdr: works, kitty renderer, keys arrive.
  herdr has a `kitty_graphics` config key (unset here, default applies) — that is the switch a
  rollout would document.
- **Not verified:** herdr's *mouse* forwarding (keys were verified in-pane; the click was verified
  at the X level in ghostty). And I cannot see the operator's screen — fidelity is measured from a
  captured window, which is the stronger evidence anyway.

## Which method won, and what the fallback would have cost

**pixel/embedded won on every axis**: pixels come off the GPU, only dirty regions are transmitted,
input is synthesized into Chromium, and it already ships a herdr plugin plus a TUI-embedding
example (`examples/tui-host-ts`). The CDP-screencast fallback (headless Chromium → JPEG frames →
kitty/sixel/ANSI) would re-derive all of that at lower fidelity and higher latency, and would still
have to solve input synthesis. It stays unbuilt.

## Integration recommendation (before any product build)

Two shapes, cheapest first:

1. **Split-pane open (recommended v1).** On a page ask, the TUI offers "open page" and splits a
   pane running `pixel` on the ticket's own URL (`/u/<token>/api/asks/<ticket>/page`). This is how
   terminal-browser itself works in herdr (`open-split.sh`), needs no changes to the readline TUI,
   and the answer lands through the same submit path proven here. Cost: one Electron process while
   the pane is open, gone when it closes.
2. **Embedded host (v2).** Follow `examples/tui-host-ts`: spawn the pixel app with `PIXEL_EMBED`,
   print its placeholders into a region of the existing TUI, forward mouse/keys. More integrated,
   more code, and it roots a renderer inside the queue UI.

Terminals without kitty graphics: the engine degrades to `cells` (ANSI) rendering, which is
functional but not a page. For those, keep the current behaviour — print the link — rather than
render half-blocks.

## Reproduction

```bash
cd /tmp && npm install @zenbu-labs/pixel@0.3.4 react@18        # 282 MB, patched Electron
node spike/tui-render/bootstrap.mjs                             # files a real page ask, waits
node node_modules/.bin/pixel spike/tui-render/app.mjs -- "<PAGE_URL it printed>"
```

The spike harness lives at `src/herdr-plugins/unblock/spike/tui-render/` (not shipped: `spike/` is
absent from the package's `files`).

## Two process notes, disclosed

- I ran `pkill -f 'spike-ask'` to close a window and **killed my own shell**, because the window
  title is in my own command line. The rule exists because this happens; it happened. Closed by
  `xdotool search` → `getwindowpid` → `kill <pid>` instead.
- Two bash calls ran ~35 min past their work. Cause was not `xdotool` (the first inference) but my
  own `setsid nohup … &` children inheriting the pipe into `tail`, so the call waited on EOF that
  never came. Fixed by logging to a file and never piping a command that starts daemons.
