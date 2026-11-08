# ux-revamp — plan and progress

Revamp both unblock surfaces — the herdr TUI (`plugin/tui.js`) and the web
panel (`web/`) — so the queue is genuinely pleasant to work in, and so the two
look like one product. Branched from `main`; lands on `apothic-main` only.

## Why the UX was bad

- **TUI**: a wall of undifferentiated grey lines. No kind identity (a spend
  approval looked like a pasted shell output), no status, the header was one
  string, fields and list rows shared one indent, and the whole frame was
  `slice()`d to `columns * rows` — which can cut an ANSI escape in half and
  clips an expanded card off the bottom of the screen with no scroll.
- **Web panel**: `card-shadow: none`, flat 1px hairlines, and a dark theme
  that was pure neutral grey. The primary action was ink-on-ink. Kind hues
  existed but the focal card was a flat tint. Nothing said "waiting on you"
  or "an agent is stopped here" at a glance.

## Design direction

One mark — the gating dot from `favicon.svg` — and one accent (`#FF4D00`),
applied consistently across both surfaces. Warm paper light theme, warm
charcoal dark theme. Kind → hue is shared: the TUI's 256-colour kind table and
the web `--kind-text/--kind-bg` pairs say the same thing.

## Work plan

1. **TUI rewrite** (`plugin/tui.js`)
   - Styled-segment renderer: lines are built as `{text, tone}` and flattened
     with a visible-width budget, so narrow terminals clip text with an
     ellipsis instead of cutting escape sequences.
   - Kind table (glyph + 256-colour) derived from the same rule as the web's
     `askKind`, level badge from `levelOf`.
   - Header with live counts (waiting / gating / profile), hairline rule.
   - Rows: `▸` selection marker, gating `!`, dim meta, bold title, dim why,
     `needs:` list.
   - Expanded card: steps, links, per-field rendering with radio/checkbox
     glyphs, focused field highlighted with an inline hint. Prose (title, why,
     steps, link labels, the footer) word-wraps to the terminal width instead
     of clipping: a card is read, not truncated. A link URL stays whole on its
     own row and is split on a `/ ? & =` break only when it cannot fit.
   - Pinned footer: status line (accent / green / red by kind) plus key chips
     rendered inverse, so the keymap is legible without reading the README.
   - Scroll window: the selected ask is always in view; arrows show scrollback.
     Once a card is taller than the window, `↑`/`↓` scroll the card itself
     (page up/down by a screen, home/end to the ends) and hold that position
     until the human changes card, so the fields stay reachable at any width.
   - Empty state: `✔ Queue is clear — nothing needs you.`
   - Approvals (consent/spend/message/permission) never draft or submit from
     the TUI — the daemon answers those writes with 403 HUMAN_ONLY, so the
     raw error is replaced by one plain line of copy.

2. **Web panel** (`web/src/styles.css` + small `App.tsx` / `SoloCard.tsx` edits)
   - Token layer: accent scale, radii, shadows, motion curves; warm light and
     warm dark palettes; kind hues retuned for contrast on both grounds.
   - Sticky glass top bar with the gating-dot mark and a live waiting pill
     (accent, pulsing dot) while any gating ask waits.
   - List rows are cards now: hover lift + shadow, staggered entrance,
     accent "Answer →" on hover, kind-tinted expanded hero.
   - Solo card: status pill in the heading ("Waiting on you" / "Agent
     paused" / "Stalled"), kind-tinted focal card with a gradient, progress
     meter above the card, glassy sticky action bar.
   - Form controls: accent focus rings, animated choice indicators,
     recommended badge in accent.
   - Empty/loading states carry the mark.
   - Login-wall styles included so the session-auth merge lands on a designed
     screen rather than a bare form.

3. **Demo harness** (`scripts/demo-seed.mjs`) — boots a daemon on a temp
   state dir with one ask of every shape, so both UIs can be exercised
   against real data instead of fixtures.

## Verification

- `node --check plugin/tui.js`, plus pty-driven runs of the TUI against the
  demo daemon — this is text output, so it was read frame by frame: list,
  move, expand, field focus, choice selection, submit, approval
  passphrase gating, empty queue, 48-column width.
- `vite build web` (clean), `tsc --noEmit` (error set identical to the
  baseline: voice-live.ts + three scope files, all pre-existing).
- Web verification is structural, not pixel-level: headless-Chrome
  screenshots were captured (list, decision/permission/spend cards, dark
  theme, 390px mobile, login wall) but image review was unavailable in this
  session, so the checks that were actually read are DOM dumps — 8
  `list-entry` rows present, login-wall markup present, selector parity
  against `main` and `apothic-main` with **zero missing selectors** (180
  added), balanced CSS braces (324/324).
- `npm test`: feature branch 466 pass / 30 fail — a strict subset of
  pristine `main`'s 34 failures, so no regressions. The full suite at default
  concurrency hangs on `apothic-main` even before this branch (pre-existing);
  the merged tree is gated with `--test-concurrency=1`.

## Progress

- [x] Recon: read both UIs, their shared model (`src/queue-model.js`), the
      daemon ask schema, and the tests that touch the surfaces.
- [x] Demo seeder; TUI rewrite; web design system; App/SoloCard tweaks.
- [x] Visual verification in light, dark and mobile.
- [x] Test suite green in the feature workspace (no regressions vs baseline).
- [x] Merge commit of `apothic-main` + `ux-revamp`: conflicts resolved in
      `plugin/tui.js` (new renderer + session-auth's passphrase gating),
      `web/src/App.tsx` (brand/pill markup + session gating),
      `web/src/styles.css` (kept the redesigned login-wall block).
- [x] Serial test suite on the merged tree (469 pass / 31 fail: 30
      pre-existing scope/lane failures + cli.test.js's park poll, which
      reproduces on the untouched apothic-main checkout at the same moment).
- [x] Merge commit described; `apothic-main` bookmark (and the
      colocated git branch) moved to it; `main` left untouched at d21da21c.
- [x] Primary checkout re-pointed at the merge; `ux-revamp` workspace and
      the baseline workspace forgotten and their directories removed.
