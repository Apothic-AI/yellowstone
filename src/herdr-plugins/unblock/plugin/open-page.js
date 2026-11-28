/**
 * "Open page" — a page ask in a pixel pane beside the queue.
 *
 * A page ask is an agent-authored HTML page. Reading it in the readline TUI is a
 * prose summary; answering it needs a browser. This module does the three things
 * that takes, and nothing that renders HTML itself:
 *
 *   1. resolve `pixel` (the terminal browser) — it is OPTIONAL and never
 *      installed by the product, because it is a 282 MB patched Electron plus a
 *      Chromium renderer process per page;
 *   2. decide honestly whether the terminal can do kitty graphics at all, since
 *      pixel's only useful renderer is the kitty one — its fallback is ANSI
 *      cells, and half-block ANSI of an HTML page is not a page;
 *   3. split a herdr pane and run the pixel app on the ask's own scoped URL.
 *
 * Every failure returns the URL rather than throwing into the TUI: the link is
 * always a usable answer, and a person at a keyboard must never be left with a
 * silent no-op. Rollout notes: docs/tui-open-page.md.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { call } from './herdr.js'

const ROOT = dirname(dirname(new URL(import.meta.url).pathname))
/** The pixel app this plugin ships. Only loaded when pixel is present. */
export const PIXEL_APP = join(ROOT, 'plugin', 'pixel-app.mjs')

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

/** A regular file. pixel's bin is a JS entry we run through node, so at the
 *  opt-in dev-install tier what matters is that it is there; a PATH hit or an
 *  explicit path still needs the executable bit, because there the shell or the
 *  operator is the one who would run it. */
function runnable(file) {
  try {
    const stat = statSync(file)
    return stat.isFile()
  } catch {
    return false
  }
}

function executable(file) {
  try {
    const stat = statSync(file)
    return stat.isFile() && Boolean(stat.mode & 0o111)
  } catch {
    return false
  }
}

/**
 * Find pixel, most explicit first:
 *
 *   $UNBLOCK_PIXEL (a path, or a command resolved on PATH)
 *   `pixel` on PATH
 *   <plugin root>/node_modules/.bin/pixel, the opt-in dev install
 *   absent — which is the DEFAULT state, and not an error
 *
 * Returns `{ path, source }`, or `{ path: null, source, reason }` when absent.
 * Nothing here installs, runs npx, or touches the network.
 */
export function resolvePixel({ env = process.env, root = ROOT, canRun = executable } = {}) {
  const explicit = oneLine(env.UNBLOCK_PIXEL)
  if (explicit) {
    // A path is taken as given; a bare name is a command, so it is resolved on PATH.
    const found = explicit.includes('/')
      ? (canRun(explicit) ? explicit : null)
      : onPath(explicit, env, canRun)
    return found
      ? { path: found, source: 'UNBLOCK_PIXEL' }
      : { path: null, source: 'UNBLOCK_PIXEL', reason: `UNBLOCK_PIXEL=${explicit} is not an executable` }
  }
  const found = onPath('pixel', env, canRun)
  if (found) return { path: found, source: 'PATH' }
  const local = join(root, 'node_modules', '.bin', 'pixel')
  if (runnable(local)) return { path: local, source: 'node_modules' }
  return { path: null, source: 'absent', reason: 'pixel is not installed' }
}

function onPath(command, env, canRun) {
  if (command.includes('/')) return canRun(command) ? command : null
  for (const dir of String(env.PATH || '').split(':')) {
    if (!dir) continue
    const candidate = join(dir, command)
    if (canRun(candidate)) return candidate
  }
  return null
}

/**
 * The module file pixel's app should import.
 *
 * The shipped app imports `@zenbu-labs/pixel` by name, which resolves when the
 * package sits in this plugin's own node_modules. A global install cannot be
 * found that way, so we also hand the app an absolute entry path derived from
 * where the binary we found actually lives (<...>/node_modules/.bin/pixel →
 * <...>/node_modules/@zenbu-labs/pixel). Undefined when that cannot be read;
 * the app then falls back to the bare specifier.
 */
export function pixelModuleEntry(pixelPath, { read = readFileSync, exists = existsSync } = {}) {
  if (!pixelPath) return undefined
  try {
    const pkgDir = join(dirname(dirname(pixelPath)), '@zenbu-labs', 'pixel')
    const manifest = join(pkgDir, 'package.json')
    if (!exists(manifest)) return undefined
    const pkg = JSON.parse(read(manifest, 'utf8'))
    const exported = typeof pkg.exports === 'string'
      ? pkg.exports
      : pkg.exports?.['.'] ?? pkg.exports?.['./'] ?? undefined
    const entry = typeof exported === 'string'
      ? exported
      : exported?.import ?? exported?.node ?? exported?.default ?? pkg.module ?? pkg.main
    if (!entry) return undefined
    const file = isAbsolute(entry) ? entry : join(pkgDir, entry)
    return exists(file) ? file : undefined
  } catch {
    return undefined
  }
}

/**
 * herdr's config file. `HERDR_CONFIG_DIR` is not a herdr variable — it is an
 * override this plugin and its tests use, documented in docs/tui-open-page.md;
 * otherwise herdr's own XDG rule applies.
 */
export function herdrConfigFiles({ env = process.env, home = homedir() } = {}) {
  const dir = env.HERDR_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'herdr')
  return [join(dir, 'config.toml')]
}

/**
 * `terminal.kitty_graphics` out of herdr's TOML.
 *
 * Deliberately a scanner, not a TOML parser: the value is one boolean in one
 * table, the plugin has no dependencies, and a scanner that only understands
 * `[table]` headers and `key = bool` cannot be tricked into inventing a value.
 * The table matters — a key written under another header is not herdr's switch,
 * and the live config on the author's machine proves how easy that is to do.
 */
export function kittyGraphicsSwitch(files, { read = readFileSync } = {}) {
  for (const file of files) {
    let text
    try {
      text = read(file, 'utf8')
    } catch {
      continue
    }
    let table = ''
    for (const raw of String(text).split('\n')) {
      const line = raw.replace(/#.*$/, '').trim()
      if (!line) continue
      const header = /^\[+([^\]]+)\]/.exec(line)
      if (header) {
        table = header[1].trim().toLowerCase()
        continue
      }
      const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(true|false)$/i.exec(line)
      if (pair && table === 'terminal' && pair[1].toLowerCase() === 'kitty_graphics') {
        return { value: pair[2].toLowerCase() === 'true', file }
      }
    }
  }
  return { value: undefined, file: undefined }
}

/**
 * Terminals that speak the kitty graphics protocol, by the markers they leave in
 * the environment. This is evidence, not a guess: each of these is set by a
 * terminal that implements the protocol (or by herdr when it is forwarding).
 */
const GRAPHICS_MARKERS = [
  ['KITTY_GRAPHICS_ENABLED', (value) => /^(1|true|yes|on)$/i.test(value), 'KITTY_GRAPHICS_ENABLED'],
  ['KITTY_WINDOW_ID', (value) => Boolean(value), 'KITTY_WINDOW_ID'],
  ['WEZTERM_PANE', (value) => Boolean(value), 'WEZTERM_PANE (WezTerm)'],
  ['GHOSTTY_RESOURCES_DIR', (value) => Boolean(value), 'GHOSTTY_RESOURCES_DIR (Ghostty)'],
]

/**
 * Can the terminal this pane is in render a pixel page?
 *
 * The answer is "yes" only on evidence, and "cannot tell" is treated as NO —
 * because the fallback is a half-block ANSI render of an HTML page, which is
 * exactly what this feature must never emit.
 *
 * Evidence, in order:
 *   $UNBLOCK_KITTY_GRAPHICS=1|0   an explicit statement from the operator
 *   herdr `terminal.kitty_graphics = false`   herdr will not forward images,
 *                                 whatever the outer terminal can do → NO
 *   a kitty-graphics terminal marker in the environment → YES
 *   anything else → NO, with the reason ("cannot tell")
 *
 * herdr 0.9.5 does not expose terminal capability over its RPC (checked:
 * `herdr api schema`, 103 methods, no capability call) and does not pass the
 * outer terminal's identity into panes (measured: TERM=xterm-256color,
 * TERM_PROGRAM=herdr, no KITTY_*), so a marker can only arrive when the
 * operator exports one. docs/tui-open-page.md says so in the operator's words.
 */
export function kittyGraphics({ env = process.env, files } = {}) {
  const override = oneLine(env.UNBLOCK_KITTY_GRAPHICS)
  if (/^(1|true|yes|on)$/i.test(override)) {
    return { supported: true, reason: 'UNBLOCK_KITTY_GRAPHICS=1' }
  }
  if (/^(0|false|no|off)$/i.test(override)) {
    return { supported: false, reason: 'UNBLOCK_KITTY_GRAPHICS=0' }
  }
  const config = kittyGraphicsSwitch(files ?? herdrConfigFiles({ env }))
  if (config.value === false) {
    return { supported: false, reason: `herdr terminal.kitty_graphics = false (${config.file})` }
  }
  // TERM is the last mark of a kitty-graphics terminal that does not export one
  // of the variables above (xterm-kitty, and kits that keep the name).
  if (/kitty/i.test(String(env.TERM || ''))) {
    return { supported: true, reason: `TERM=${env.TERM}` }
  }
  for (const [name, test, label] of GRAPHICS_MARKERS) {
    if (test(oneLine(env[name]))) return { supported: true, reason: label }
  }
  return { supported: false, reason: `cannot tell — no kitty-graphics marker (TERM=${env.TERM || 'unset'})` }
}

/** POSIX single-quote a shell word. Sending a URL into a pane is sending it
 *  through a shell, and a URL is user-visible text, not a trusted token. */
export function shellQuote(word) {
  const text = String(word)
  if (text === '') return "''"
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`
}

/**
 * The command line the split pane runs: this node, pixel's bin, the app, then
 * `--` and the page URL (the spike's invocation, unchanged).
 */
export function pixelCommand({ node = process.execPath, pixel, app = PIXEL_APP, url, moduleEntry }) {
  const argv = [node, pixel, app, '--', url]
  const env = moduleEntry ? [`UNBLOCK_PIXEL_MODULE=${shellQuote(moduleEntry)}`] : []
  return [...env, ...argv.map(shellQuote)].join(' ')
}

/**
 * Wait for the split pane's shell to say something.
 *
 * `pane.split` returns as soon as the pane exists; the shell inside it may not
 * have drawn its prompt yet, and text sent before the line discipline is live is
 * echoed into a terminal nobody is reading. `herdr pane run` handles this
 * readiness itself; talking to the RPC directly means we have to. Best effort:
 * after ~2.5 s we send anyway, because a slow prompt is not a reason to lose the
 * command — the pane is right there and the human can press Enter.
 */
async function waitForPaneReady({ rpc, paneId, attempts = 12, pause }) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const read = await rpc('pane.read', { pane_id: paneId, source: 'recent', lines: 5 })
      const text = typeof read === 'string'
        ? read
        : read?.text ?? (Array.isArray(read?.lines) ? read.lines.join('\n') : '')
      if (String(text).trim()) return true
    } catch {
      // A read the server refuses (too new a pane, no scrollback yet) is not a
      // reason to fail the open: keep waiting, then send regardless.
    }
    await pause()
  }
  return false
}

/**
 * Split the calling pane and run pixel in it.
 *
 * `pane.split` is herdr's own RPC (found in `herdr api schema`, params
 * PaneSplitParams; the CLI is `herdr pane split`, which returns `.result.pane`).
 * Its response is the new pane; `pane.send_input` then types the command and
 * presses Enter, which is what `herdr pane run` does.
 *
 * Returns `{ ok: true, paneId }` or `{ ok: false, error }` — never throws, so the
 * caller can always fall back to printing the URL.
 */
export async function openPagePane({
  url,
  pixel,
  cwd,
  paneId = process.env.HERDR_PANE_ID,
  direction = 'right',
  app = PIXEL_APP,
  node = process.execPath,
  rpc = call,
  closePane = true,
  pause = () => new Promise((resolve) => setTimeout(resolve, 200)),
} = {}) {
  if (!url) return { ok: false, error: 'no page URL' }
  if (!pixel) return { ok: false, error: 'pixel is not installed' }
  let opened
  try {
    opened = await rpc('pane.split', {
      direction,
      target_pane_id: paneId || null,
      cwd: cwd || null,
      focus: false,
    })
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }
  const newPane = opened?.pane?.pane_id ?? opened?.pane_id ?? opened?.split?.pane?.pane_id
  if (!newPane) return { ok: false, error: 'herdr pane.split returned no pane id' }
  await waitForPaneReady({ rpc, paneId: newPane, pause })
  const command = pixelCommand({ node, pixel, app, url, moduleEntry: pixelModuleEntry(pixel) })
  try {
    await rpc('pane.send_input', { pane_id: newPane, text: command, keys: ['Enter'] })
  } catch (error) {
    // A shell pane with nothing in it is worse than no pane: close it and let
    // the caller print the link.
    if (closePane) await rpc('pane.close', { pane_id: newPane }).catch(() => {})
    return { ok: false, error: error?.message || String(error), paneId: newPane }
  }
  return { ok: true, paneId: newPane, command }
}

/** The one-line hint printed when pixel is not installed. It names the command
 *  a human may run; the product never runs it. */
export function pixelHint({ root = ROOT } = {}) {
  return `optional: npm i --no-save @zenbu-labs/pixel inside ${root}`
}
