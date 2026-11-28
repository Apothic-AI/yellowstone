# Open page — a page ask in a pixel pane

> Repo documentation, beside the component's source (this file is under `docs/`, which the
> package's `files` list does not include, so it is not in the npm tarball — the installed
> plugin carries the same rules in `skills/unblock/SKILL.md`). `package.json` is deliberately
> untouched by this feature.

A page ask is an agent-authored HTML page. The readline TUI can describe it, but it
cannot answer it: the page has form controls of the agent's own design, images, maybe
a chart. So the TUI offers one action on those asks:

```
 o open page
```

Press `o` on a page ask and unblock mints a **ticket-scoped** link, splits a herdr pane
beside the queue, and runs [`pixel`](https://github.com/zenbu-labs/pixel) in it on the
ask's own URL:

```
http://127.0.0.1:<port>/u/<token>/api/asks/<ticket>/page
```

That path is the page **shell** the daemon already serves: a sandboxed iframe
(`sandbox="allow-forms allow-scripts"`) around `page.html`. The human clicks the field,
types, submits — the form posts to the same forgiving submit endpoint every other page
ask uses, and the existing wake path fires. **No second submit path, no new route, no
change to how answers are recorded.**

The chip appears only on a page ask. On any other ask `o` does nothing at all: no mint,
no footer message.

## pixel is optional, and the product never installs it

`package.json` is unchanged by this feature and a test pins its bytes. There is no
`dependencies`, `optionalDependencies` or `devDependencies` entry for pixel, and no
`npx`, `npm install` or network call anywhere in the product code.

**Why not a dependency.** `@zenbu-labs/pixel` postinstalls a patched Electron: 282 MB on
disk, measured at install time during the spike. Each open page then costs a Chromium
renderer process for as long as the pane lives. The unblock plugin otherwise needs
nothing but Node's standard library, and `npm i unblockd` should not spend 282 MB on a
feature most sessions never use. So it is opt-in, per machine, by hand.

**Optional dev install**, inside the plugin root (`src/herdr-plugins/unblock/` — the
directory holding this `plugin/` and `package.json`):

```bash
npm i --no-save @zenbu-labs/pixel react     # 282 MB, ~30 s, patched Electron
```

`--no-save` is deliberate: it puts the package in `node_modules/.bin/pixel` without
writing a dependency into `package.json`. A repo-wide `npm install` removes it again;
that is fine, `o` falls back to the link.

**Resolution order** (`plugin/open-page.js`, `resolvePixel`):

| # | Where | How it is found |
|---|---|---|
| 1 | `$UNBLOCK_PIXEL` | an absolute path, or a command resolved on `PATH`; a set-but-unrunnable value is reported, not silently skipped |
| 2 | `pixel` on `PATH` | a global or system install |
| 3 | `<plugin root>/node_modules/.bin/pixel` | the opt-in dev install above |
| 4 | absent | **the default**, and not an error |

For installs outside the plugin root (cases 1 and 2), the shipped app
(`plugin/pixel-app.mjs`) cannot resolve `@zenbu-labs/pixel` by name from its own
directory, so `plugin/open-page.js` derives the module's absolute entry from where the
binary lives and passes it as `UNBLOCK_PIXEL_MODULE`.

`UNBLOCK_PIXEL_REPORT=<file>` makes the app append every key it receives, the engine
geometry it chose and every page change to that file — that is how the renderer claim
(`renderer: "kitty"`) is checked rather than assumed.

Most sessions run **without** pixel. `o` then prints:

```
http://127.0.0.1:<port>/u/<token>/api/asks/<ticket>/page  ·  pixel is not installed
— optional: npm i --no-save @zenbu-labs/pixel inside <plugin root>
```

Copy the link into any browser and the ask is answerable there. Nothing is rendered in
the terminal, and no pane is split.

## Kitty graphics is the gate, and "cannot tell" means no

pixel's only renderer that shows a page is the kitty graphics protocol (measured:
`renderer: "kitty"`, truecolour, precise pointer). On a terminal without it, pixel
degrades to `cells` — ANSI half-blocks. **A half-block ANSI render of an HTML page is
not a page**, and this feature must never emit one. So without evidence of kitty
graphics, `o` prints the link and stops.

### herdr's switch: `terminal.kitty_graphics`

herdr's own config key is the switch, in the `[terminal]` table:

```toml
[terminal]
# Render pane images in Kitty graphics-compatible outer terminals.
kitty_graphics = true
```

- **Location:** `~/.config/herdr/config.toml`, i.e. `${XDG_CONFIG_HOME:-~/.config}/herdr/config.toml`.
  unblock also honours `HERDR_CONFIG_DIR` (its own variable, not herdr's) to point at a
  different herdr config directory — used by the tests, useful for an unusual install.
- **Default when unset: enabled.** `herdr --default-config` prints `# kitty_graphics = true`
  under `[terminal]`, so an unset key means herdr will forward pane images. (Measured on
  herdr 0.9.5.)
- **It is read once at startup.** herdr logs
  `terminal.kitty_graphics changes require restarting Herdr; kept current setting` — editing
  the file does not take effect in a running server.
- **Only `[terminal]` counts.** This machine's live config has `kitty_graphics = true` under
  `[experimental]`, where herdr does not read it (checked 2026-11-27, herdr 0.9.5): the
  effective state there is *unset*, not *true*. If you want herdr to honour it, move the line
  into `[terminal]` and restart herdr.

`plugin/open-page.js` reads that key (`kittyGraphicsSwitch`) — as a scanner, not a TOML
parser: it tracks `[table]` headers and `key = bool` pairs, so a key under the wrong header
cannot be mistaken for the switch.

### Why the key alone does not enable the pane

`kitty_graphics = false` is a hard **no** (herdr will not forward images, whatever the
terminal can do). `true` or unset is only *permission*: it says nothing about the outer
terminal, and enabling pixel on a terminal that cannot render it is exactly how you get
half-blocks. So the gate wants **capability evidence**:

1. `$UNBLOCK_KITTY_GRAPHICS=1` — an explicit statement from the operator (also `0` to force off);
2. otherwise a marker from a terminal that implements the protocol: `TERM` containing `kitty`
   (`xterm-kitty`), `KITTY_WINDOW_ID`, `KITTY_GRAPHICS_ENABLED=1`, `WEZTERM_PANE`,
   `GHOSTTY_RESOURCES_DIR`;
3. otherwise **cannot tell → unsupported**, with the reason printed.

That last rule matters inside herdr. herdr 0.9.5 exposes **no** terminal-capability call
(`herdr api schema`: 103 methods, none of them capability — `pane.list` has no graphics
field) and does **not** pass the outer terminal's identity into panes: measured in a herdr
pane on this machine, `TERM=xterm-256color`, `TERM_PROGRAM=herdr`, `COLORTERM=truecolor`,
and no `KITTY_*`/`GHOSTTY_*`/`WEZTERM_*` variable at all. From inside a pane, the capability
is genuinely unknowable, so unblock refuses to guess.

**To turn the pane on where you know it is safe** (a Ghostty/kitty/WezTerm terminal behind
herdr):

```bash
export UNBLOCK_KITTY_GRAPHICS=1      # in the environment the unblock TUI starts in
```

Then `o` splits the pane instead of printing the link. Leave it unset and you get the link,
which is a complete answer to a page ask — just not a picture of it.

## How the pane is split (no guessed method names)

The method is herdr's own, taken from `herdr api schema` (params `PaneSplitParams`), not
invented:

| Step | RPC (plugin/herdr.js `call`) | CLI equivalent |
|---|---|---|
| split | `pane.split {direction:"right", target_pane_id:$HERDR_PANE_ID, cwd, focus:false}` → `{pane:{pane_id}}` | `herdr pane split --current --direction right --cwd … --no-focus` |
| wait | `pane.read {pane_id, source:"recent", lines:5}` until the shell draws, ~2.5 s at most | readiness is inside `herdr pane run` |
| run | `pane.send_input {pane_id, text, keys:["Enter"]}` | `herdr pane run <pane-id> <command>` |

`pane.read` before the command is not decorative: `pane.split` returns as soon as the pane
exists, and text typed before the shell's line discipline is live goes nowhere. After twelve
unsuccessful reads the command is sent anyway — a slow prompt is not a reason to lose it.

The command is the spike's, unchanged, shell-quoted:

```
<node> <pixel> <plugin/pixel-app.mjs> -- <page-url>
```

Failure handling: a failed split prints the URL in the footer. A split that succeeds but
whose `pane.send_input` fails **closes the new pane** (`pane.close`) before printing the
URL — an empty shell pane beside the queue is worse than no pane. Nothing fails silently.

## What a person does in the pane, and what is honest about it

Click a field, type, press the page's submit button. The page renders at the ask's own URL
through the scoped token, so the shell's iframe, the sandbox, the null-origin submit
allowance and the wake path are all the ones already tested.

**Verification status, stated plainly.** The herdr half — split a real pane, run a command
in it, have typed text arrive, submit, and the parked agent wake — was measured during the
2026-11-27 spike (`research/tui-render-spike-findings.md`). What has **never** been
exercised end to end is a **mouse click inside a herdr pane**: the spike verified keys
in-pane (`herdr pane send-text` / `send-keys`) and the click only at the X level in ghostty.
That gap remains open. It cannot be closed on this machine in this build: pixel is not
installed (its 282 MB spike install is gone), and from inside a herdr pane the outer
terminal cannot even be identified (§ above), so the gate resolves to "cannot tell" and
prints the link instead of opening a pane. Treat "click in a herdr pane" as unverified
until someone with pixel installed and `UNBLOCK_KITTY_GRAPHICS=1` tries it.

If a pane does open on a terminal that turns out not to do kitty graphics, the app prints
`degraded renderer "<name>" — this terminal cannot show a page` to its own stderr, which
is visible in the pane. The gate is meant to make that unreachable.

## Tests

`test/tui-open-page.test.js`:

- `o` on a page ask mints a ticket-scoped link and requests `pane.split` + `pane.send_input`
  with the exact URL (herdr replaced by a real unix socket that speaks its JSON-RPC shape);
- `o` on a non-page ask does nothing — no mint, no split, no footer;
- pixel absent → footer is the URL plus the optional-install hint, and no pane is requested;
- no kitty graphics → link printed, no pane requested;
- `package.json` declares no runtime dependency **and its bytes are unchanged** (sha256 pin);
- plus unit tests for the resolution order, the shell quoting, the module-entry derivation,
  the `[terminal] kitty_graphics` scanner, and the failure paths (split refused, no pane id,
  command refused → pane closed).

The last four tests drive the real TUI in a pty against a throwaway daemon, so the key
handling, the link mint and the footer text are the shipped ones.
