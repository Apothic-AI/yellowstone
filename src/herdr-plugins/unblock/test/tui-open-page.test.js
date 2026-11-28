// "Open page" — a page ask's own URL in a pixel pane beside the queue.
//
// The three constraints this file exists to hold:
//   * pixel is OPTIONAL and resolved on demand: no dependency, no install, no
//     npx, and package.json's bytes do not move;
//   * a terminal that cannot do kitty graphics gets the LINK, never a
//     half-block ANSI render of an HTML page;
//   * the pane is split through herdr's own RPC, on the ask's ticket-scoped URL.
//
// The last three tests drive the real TUI in a pty against a throwaway daemon and
// a fake herdr socket (the same shape herdr speaks: one JSON-RPC request per
// connection, replied to, then closed). Nothing outside the temp dirs is touched.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  PIXEL_APP, herdrConfigFiles, kittyGraphics, kittyGraphicsSwitch, openPagePane,
  pixelCommand, pixelModuleEntry, resolvePixel, shellQuote,
} from '../plugin/open-page.js'
import { bootFixtureDaemon } from './helpers/tui-fixture.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const dir = () => mkdtempSync(join(tmpdir(), 'unblock-open-page-'))

// ---------------------------------------------------------------- unit tests

test('pixel resolves in the documented order, and absent is a normal answer', () => {
  const bin = join(dir(), 'pixel')
  writeFileSync(bin, '#!/usr/bin/env node\n', { mode: 0o755 })
  const root = dir()

  // 1. UNBLOCK_PIXEL wins, whether it names a path or a command on PATH.
  assert.deepEqual(
    resolvePixel({ env: { UNBLOCK_PIXEL: bin, PATH: '' }, root }),
    { path: bin, source: 'UNBLOCK_PIXEL' },
  )
  assert.deepEqual(
    resolvePixel({ env: { UNBLOCK_PIXEL: 'pixel', PATH: join(bin, '..') }, root }),
    { path: bin, source: 'UNBLOCK_PIXEL' },
  )

  // 2. then `pixel` on PATH
  assert.deepEqual(resolvePixel({ env: { PATH: join(bin, '..') }, root }), { path: bin, source: 'PATH' })

  // 3. then the opt-in dev install inside the plugin root
  const devRoot = dir()
  mkdirSync(join(devRoot, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(devRoot, 'node_modules', '.bin', 'pixel'), '#!/usr/bin/env node\n', { mode: 0o755 })
  assert.deepEqual(resolvePixel({ env: { PATH: '' }, root: devRoot }), {
    path: join(devRoot, 'node_modules', '.bin', 'pixel'),
    source: 'node_modules',
  })

  // 4. absent — the default on this machine, and not an error.
  const missing = resolvePixel({ env: { PATH: '' }, root: dir() })
  assert.equal(missing.path, null)
  assert.equal(missing.source, 'absent')
  assert.match(missing.reason, /pixel is not installed/)

  // A set-but-broken override is reported as such instead of silently falling
  // through to a different pixel: the operator meant that one.
  const broken = resolvePixel({ env: { UNBLOCK_PIXEL: '/nonexistent/pixel', PATH: join(bin, '..') }, root })
  assert.equal(broken.path, null)
  assert.match(broken.reason, /not an executable/)
})

test('the pixel command is the spike invocation, quoted for a shell', () => {
  assert.equal(shellQuote('/a/b-c_d.e'), '/a/b-c_d.e')
  assert.equal(shellQuote('http://127.0.0.1:9/u/tok/api/asks/ub_1/page'), 'http://127.0.0.1:9/u/tok/api/asks/ub_1/page')
  assert.equal(shellQuote("it's"), `'it'\\''s'`)
  assert.equal(shellQuote('a b'), `'a b'`)
  assert.equal(shellQuote(''), "''")

  const command = pixelCommand({ node: '/usr/bin/node', pixel: '/opt/pixel', app: '/p/app.mjs', url: 'http://h/u/t/api/asks/x/page' })
  assert.equal(command, '/usr/bin/node /opt/pixel /p/app.mjs -- http://h/u/t/api/asks/x/page')

  // A global install needs its module path handed to the app, because the app's
  // own directory cannot resolve @zenbu-labs/pixel from there.
  const withModule = pixelCommand({
    node: '/usr/bin/node', pixel: '/opt/pixel', app: '/p/app.mjs',
    url: 'http://h/page', moduleEntry: '/opt/node_modules/@zenbu-labs/pixel/index.js',
  })
  assert.equal(
    withModule,
    "UNBLOCK_PIXEL_MODULE=/opt/node_modules/@zenbu-labs/pixel/index.js /usr/bin/node /opt/pixel /p/app.mjs -- http://h/page",
  )
})

test('the module entry is read from the install the binary belongs to', () => {
  const root = dir()
  const pkgDir = join(root, 'node_modules', '@zenbu-labs', 'pixel')
  mkdirSync(join(pkgDir, 'dist'), { recursive: true })
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(root, 'node_modules', '.bin', 'pixel'), '#!/usr/bin/env node\n', { mode: 0o755 })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@zenbu-labs/pixel', exports: { '.': { import: './dist/index.mjs' } } }))
  writeFileSync(join(pkgDir, 'dist', 'index.mjs'), 'export const createRoot = () => ({})\n')

  assert.equal(
    pixelModuleEntry(join(root, 'node_modules', '.bin', 'pixel')),
    join(pkgDir, 'dist', 'index.mjs'),
  )
  // Nothing to read: undefined, and the app falls back to the bare specifier.
  assert.equal(pixelModuleEntry(join(dir(), 'nowhere', 'pixel')), undefined)
  assert.equal(pixelModuleEntry(undefined), undefined)
})

test('herdr terminal.kitty_graphics is the switch, and only under [terminal]', () => {
  const one = (text) => {
    const file = join(dir(), 'config.toml')
    writeFileSync(file, text)
    return kittyGraphicsSwitch([file])
  }
  assert.equal(one('[terminal]\nkitty_graphics = false\n').value, false)
  assert.equal(one('[terminal]\nkitty_graphics = true\n').value, true)
  // A commented-out line is not a setting.
  assert.equal(one('[terminal]\n# kitty_graphics = false\n').value, undefined)
  // The live config on the author's machine writes the key under [experimental],
  // where herdr does not read it. Unset is the honest answer there, not `true`.
  assert.equal(one('[experimental]\nkitty_graphics = true\n').value, undefined)
  // A key of the same name in a nested table is not the switch either.
  assert.equal(kittyGraphicsSwitch([join(dir(), 'absent.toml')]).value, undefined)

  // Default location follows herdr's own XDG rule, with an explicit override
  // for tests and for a herdr installed elsewhere.
  assert.deepEqual(
    herdrConfigFiles({ env: { XDG_CONFIG_HOME: '/x' }, home: '/home/h' }),
    ['/x/herdr/config.toml'],
  )
  assert.deepEqual(
    herdrConfigFiles({ env: { HERDR_CONFIG_DIR: '/override' }, home: '/home/h' }),
    ['/override/config.toml'],
  )
})

test('kitty graphics needs evidence; "cannot tell" is unsupported', () => {
  const configFile = (text) => {
    const file = join(dir(), 'config.toml')
    writeFileSync(file, text)
    return [file]
  }
  // A pane inside herdr: TERM is normalised and no kitty marker survives.
  const paneEnv = { TERM: 'xterm-256color', TERM_PROGRAM: 'herdr' }
  const cannotTell = kittyGraphics({ env: paneEnv, files: [] })
  assert.equal(cannotTell.supported, false)
  assert.match(cannotTell.reason, /cannot tell/)

  // An explicit operator statement works in both directions.
  assert.equal(kittyGraphics({ env: { ...paneEnv, UNBLOCK_KITTY_GRAPHICS: '1' }, files: [] }).supported, true)
  assert.equal(kittyGraphics({ env: { ...paneEnv, UNBLOCK_KITTY_GRAPHICS: '0' }, files: [] }).supported, false)

  // herdr's own switch, when it is actually set, can only veto: it says herdr
  // will not forward images, whatever the outer terminal can do.
  const vetoed = kittyGraphics({ env: { ...paneEnv, UNBLOCK_KITTY_GRAPHICS: '' }, files: configFile('[terminal]\nkitty_graphics = false\n') })
  assert.equal(vetoed.supported, false)
  assert.match(vetoed.reason, /kitty_graphics = false/)
  // Unset or true is permission, not capability — no marker still means no.
  assert.equal(kittyGraphics({ env: { ...paneEnv, UNBLOCK_KITTY_GRAPHICS: '' }, files: configFile('[terminal]\nkitty_graphics = true\n') }).supported, false)

  // Evidence from a terminal that implements the protocol.
  for (const env of [
    { TERM: 'xterm-kitty' },
    { TERM: 'xterm-256color', KITTY_WINDOW_ID: '1' },
    { TERM: 'xterm-256color', KITTY_GRAPHICS_ENABLED: '1' },
    { TERM: 'xterm-256color', WEZTERM_PANE: '0' },
    { TERM: 'xterm-256color', GHOSTTY_RESOURCES_DIR: '/ghostty' },
  ]) {
    const verdict = kittyGraphics({ env: { UNBLOCK_KITTY_GRAPHICS: '', ...env }, files: [] })
    assert.equal(verdict.supported, true, JSON.stringify(env))
  }
  // iTerm2 speaks its own inline-image protocol, not kitty's: no false positive.
  assert.equal(kittyGraphics({ env: { TERM: 'xterm-256color', TERM_PROGRAM: 'iTerm.app', UNBLOCK_KITTY_GRAPHICS: '' }, files: [] }).supported, false)
})

test('the split is herdr pane.split + pane.send_input, on the exact URL', async () => {
  const calls = []
  const rpc = async (method, params) => {
    calls.push({ method, params })
    if (method === 'pane.split') return { pane: { pane_id: 'w1:p9' } }
    if (method === 'pane.read') return { text: '~ $' }
    return {}
  }
  const url = 'http://127.0.0.1:4321/u/tok/api/asks/ub_abc/page'
  const result = await openPagePane({
    url, pixel: '/opt/pixel', cwd: '/w', paneId: 'w1:p1', app: '/p/app.mjs', node: '/usr/bin/node', rpc,
    pause: async () => {},
  })
  assert.equal(result.ok, true)
  assert.equal(result.paneId, 'w1:p9')
  // The shell in the new pane has to be drawn before text is typed into it, so a
  // read sits between the split and the command (`herdr pane run` does the same).
  assert.deepEqual(calls, [
    { method: 'pane.split', params: { direction: 'right', target_pane_id: 'w1:p1', cwd: '/w', focus: false } },
    { method: 'pane.read', params: { pane_id: 'w1:p9', source: 'recent', lines: 5 } },
    { method: 'pane.send_input', params: { pane_id: 'w1:p9', text: '/usr/bin/node /opt/pixel /p/app.mjs -- ' + url, keys: ['Enter'] } },
  ])
  // The shipped pixel app is what runs unless a caller says otherwise.
  assert.equal(PIXEL_APP.endsWith('/plugin/pixel-app.mjs'), true)
})

test('a cold pane is waited for, a silent one is still used', async () => {
  const reads = []
  const readsThenPrompt = async (method) => {
    if (method === 'pane.split') return { pane: { pane_id: 'w1:p9' } }
    if (method === 'pane.read') {
      reads.push(reads.length)
      // Empty until the shell draws; a read that fails outright is also fine.
      if (reads.length === 1) return { text: '' }
      if (reads.length === 2) throw new Error('pane has no scrollback yet')
      return { text: '~ $' }
    }
    return {}
  }
  const waited = await openPagePane({
    url: 'http://h/page', pixel: '/opt/pixel', app: '/p/app.mjs', node: '/usr/bin/node',
    rpc: readsThenPrompt, pause: async () => {},
  })
  assert.equal(waited.ok, true)
  assert.equal(reads.length, 3, 'the send waits for output, tolerating a refused read')

  // A pane that never speaks is not a failure: after the attempts, send anyway.
  let reads2 = 0
  const silent = await openPagePane({
    url: 'http://h/page', pixel: '/opt/pixel', app: '/p/app.mjs', node: '/usr/bin/node',
    rpc: async (method) => {
      if (method === 'pane.split') return { pane: { pane_id: 'w1:p9' } }
      if (method === 'pane.read') { reads2 += 1; return { text: '' } }
      return {}
    },
    pause: async () => {},
  })
  assert.equal(silent.ok, true)
  assert.equal(reads2, 12, 'bounded: twelve attempts, then the command goes in')
})

test('a failed split or command reports it, and never leaves an empty pane behind', async () => {
  const splitFails = await openPagePane({
    url: 'http://h/page', pixel: '/opt/pixel', pause: async () => {},
    rpc: async () => { throw new Error('herdr is not running') },
  })
  assert.equal(splitFails.ok, false)
  assert.match(splitFails.error, /herdr is not running/)

  // A reply without a pane id is a failure, not a pane called "undefined".
  const noPane = await openPagePane({ url: 'http://h/page', pixel: '/opt/pixel', rpc: async () => ({}), pause: async () => {} })
  assert.equal(noPane.ok, false)
  assert.match(noPane.error, /no pane id/)

  const calls = []
  const sendFails = await openPagePane({
    url: 'http://h/page', pixel: '/opt/pixel', pause: async () => {},
    rpc: async (method, params) => {
      calls.push(method)
      if (method === 'pane.split') return { pane: { pane_id: 'w1:p9' } }
      if (method === 'pane.read') throw new Error('not yet')
      throw new Error('PTY input submission is still in progress')
    },
  })
  assert.equal(sendFails.ok, false)
  assert.equal(sendFails.paneId, 'w1:p9')
  assert.equal(calls[0], 'pane.split')
  assert.equal(calls.at(-2), 'pane.send_input')
  assert.equal(calls.at(-1), 'pane.close', 'the empty pane is closed, not left behind')

  // No pixel at all: nothing is attempted, so nothing can fail halfway.
  const noPixel = await openPagePane({ url: 'http://h/page', pixel: null, rpc: async () => { throw new Error('must not be called') } })
  assert.equal(noPixel.ok, false)
  assert.match(noPixel.error, /pixel is not installed/)
})

test('package.json still declares no runtime dependency, and its bytes are unchanged', () => {
  const file = join(ROOT, 'package.json')
  const bytes = readFileSync(file)
  const pkg = JSON.parse(bytes.toString('utf8'))

  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) {
    assert.equal(pkg[key], undefined, `${key} must stay absent: pixel is optional and on demand`)
  }
  // vite is the pre-existing build-time dev dependency; pixel is not a dev
  // dependency either, because `npm i` must not pull a 282 MB patched Electron.
  assert.deepEqual(pkg.devDependencies, { vite: '8.2.2' })

  // Byte-level pin, recorded from the file BEFORE this feature existed. The
  // brief's test is "the file's bytes are unchanged": adding a dependency, a
  // script, or even a formatting tweak here fails this assertion on purpose.
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '4b7a26a3f7d948d8cf1981b05b5af0c1c92e2564e4ca1e2e71e16fe436b4c013',
    'package.json changed — pixel must stay optional, out of the dependency graph',
  )
})

// --------------------------------------------------------- TUI, in a real pty

/** A herdr stand-in that speaks the real shape: one JSON-RPC request per
 *  connection, one reply, then the server closes it. Every call is recorded. */
async function fakeHerdr() {
  const socketPath = join(dir(), 'herdr.sock')
  const calls = []
  const server = net.createServer((socket) => {
    let buf = ''
    socket.on('data', (chunk) => {
      buf += chunk
      const line = buf.split('\n').find((row) => row.trim())
      if (!line) return
      let request
      try {
        request = JSON.parse(line)
      } catch {
        socket.end()
        return
      }
      const result = request.method === 'pane.split'
        ? { pane: { pane_id: 'wFAKE:p9' } }
        : request.method === 'pane.read' ? { text: '~ $' } : {}
      calls.push({ method: request.method, params: request.params })
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
      socket.end()
    })
  })
  await new Promise((resolve) => server.listen(socketPath, resolve))
  return {
    path: socketPath,
    calls,
    methods: () => calls.map((call) => call.method),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function fakePixelBinary() {
  const file = join(dir(), 'pixel')
  writeFileSync(file, '#!/usr/bin/env node\nprocess.exit(0)\n')
  chmodSync(file, 0o755)
  return file
}

/**
 * Run the real TUI in a pty (it only renders interactively on a tty), press
 * keys, and return the final frame with ANSI stripped.
 */
async function driveTui({ env, keys }) {
  const child = spawn('script', ['-qec', 'stty cols 100 rows 46 2>/dev/null; exec node plugin/tui.js', '/dev/null'], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1', TERM: 'xterm-256color', COLUMNS: '100', LINES: '46', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { out += chunk })
  await wait(1800) // first frame, after the queue loads
  for (const [key, delay] of keys) {
    child.stdin.write(key)
    await wait(delay)
  }
  child.kill('SIGTERM')
  await wait(250)
  const frame = out.split('\x1b[H\x1b[2J').filter((part) => part.trim()).pop() || out
  return frame.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '')
}

const PAGE_ASK = {
  kind: 'page', purpose: 'decision', only_you: 'judgment', project: 'open-page',
  title: 'Pick the rollout plan', why: 'Two plans, one call.',
  tried: ['I read both plans and either works technically.'],
}

/** Env for a TUI that has a herdr to talk to, a kitty-capable terminal, and a
 *  pixel binary — the whole happy path, with nothing real behind it. */
async function happyEnv({ pixel = fakePixelBinary() } = {}) {
  const herdr = await fakeHerdr()
  return {
    herdr,
    env: {
      HERDR_SOCKET_PATH: herdr.path,
      HERDR_PANE_ID: 'wTEST:p1',
      HERDR_ENV: '1',
      UNBLOCK_PIXEL: pixel,
      UNBLOCK_KITTY_GRAPHICS: '1',
      HERDR_CONFIG_DIR: dir(), // no config.toml: the override is the evidence
    },
  }
}

test('o on a page ask mints a scoped link and opens it in a split pane', async () => {
  const fixture = await bootFixtureDaemon({ ask: PAGE_ASK, ready: true, origin: { agent: 'codex', cwd: '/tmp' } })
  const { herdr, env } = await happyEnv()
  try {
    const frame = await driveTui({ env: { ...fixture.env, ...env }, keys: [['\r', 900], ['o', 1600]] })
    assert.match(frame, /o\s+open page/, 'a page ask advertises the action in its footer')

    assert.deepEqual(herdr.methods().filter((method) => method.startsWith('pane.')), ['pane.split', 'pane.read', 'pane.send_input'])
    const split = herdr.calls.find((call) => call.method === 'pane.split')
    assert.deepEqual(split.params, { direction: 'right', target_pane_id: 'wTEST:p1', cwd: '/tmp', focus: false })

    const send = herdr.calls.find((call) => call.method === 'pane.send_input')
    assert.equal(send.params.pane_id, 'wFAKE:p9')
    assert.deepEqual(send.params.keys, ['Enter'])
    // The exact URL, on the ask's own ticket, under the minted token.
    const port = fixture.env.UNBLOCK_PORT
    const expected = new RegExp(
      `^${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\S*\\/pixel \\S*\\/plugin\\/pixel-app\\.mjs -- ` +
        `http://127\\.0\\.0\\.1:${port}/u/[A-Za-z0-9_-]+/api/asks/${fixture.ticket}/page$`,
    )
    assert.match(send.params.text, expected)

    // The URL the pane was handed is the page shell, served through the scoped
    // token — not a daemon path that would need the TUI's bearer.
    const url = send.params.text.split(' -- ')[1]
    const shell = await fetch(url)
    const shellText = await shell.text()
    assert.equal(shell.status, 200, shellText)
    assert.equal(shell.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.match(shellText, /iframe sandbox="allow-forms allow-scripts"/)

    assert.match(frame, /opened page in pane wFAKE:p9/, `footer should say what happened:\n${frame}`)
  } finally {
    await herdr.close()
    await fixture.close()
  }
})

test('o on a non-page ask does nothing at all', async () => {
  const fixture = await bootFixtureDaemon() // the wrap-test park ask: no page
  const { herdr, env } = await happyEnv()
  try {
    const frame = await driveTui({ env: { ...fixture.env, ...env }, keys: [['\r', 900], ['o', 1400]] })
    assert.deepEqual(herdr.methods().filter((method) => method.startsWith('pane.')), [], 'no split, no input')
    assert.doesNotMatch(frame, /open page/, 'no chip on an ask with no page')
    assert.doesNotMatch(frame, /\/u\/[A-Za-z0-9_-]+/, 'no link minted')
    assert.doesNotMatch(frame, /could not open|needs pixel|needs kitty/, 'and no error either')
  } finally {
    await herdr.close()
    await fixture.close()
  }
})

test('pixel absent: the footer is the URL plus the optional install, and nothing is attempted', async () => {
  const fixture = await bootFixtureDaemon({ ask: PAGE_ASK, ready: true })
  const { herdr, env } = await happyEnv()
  // Unresolvable on purpose: no UNBLOCK_PIXEL, and a PATH with no pixel on it.
  env.UNBLOCK_PIXEL = ''
  env.PATH = '/usr/bin:/bin'
  try {
    const frame = await driveTui({ env: { ...fixture.env, ...env }, keys: [['\r', 900], ['o', 1600]] })
    const flat = frame.replace(/\s+/g, ' ')
    assert.match(flat, new RegExp(`/u/[A-Za-z0-9_-]+/api/asks/${fixture.ticket}/page`), 'the link is the fallback')
    assert.match(flat, /npm i --no-save @zenbu-labs\/pixel/, 'and the one-line hint says how to get the pane')
    assert.deepEqual(herdr.methods().filter((method) => method.startsWith('pane.')), [], 'no pane, so no render')
  } finally {
    await herdr.close()
    await fixture.close()
  }
})

test('no kitty graphics: the link is printed and no pane is opened', async () => {
  const fixture = await bootFixtureDaemon({ ask: PAGE_ASK, ready: true })
  const { herdr, env } = await happyEnv()
  // pixel IS installed here; the terminal is what cannot do it. Nothing in the
  // environment is evidence of kitty graphics, and herdr's switch is unset, so
  // the honest answer is "cannot tell" — which is treated as unsupported.
  env.UNBLOCK_KITTY_GRAPHICS = ''
  env.HERDR_CONFIG_DIR = dir()
  try {
    const frame = await driveTui({ env: { ...fixture.env, ...env }, keys: [['\r', 900], ['o', 1600]] })
    // The footer wraps, so match it with whitespace flattened.
    const flat = frame.replace(/\s+/g, ' ')
    assert.match(flat, new RegExp(`/u/[A-Za-z0-9_-]+/api/asks/${fixture.ticket}/page`))
    assert.match(flat, /needs kitty graphics: cannot tell/)
    assert.deepEqual(herdr.methods().filter((method) => method.startsWith('pane.')), [], 'no render attempted')
  } finally {
    await herdr.close()
    await fixture.close()
  }
})
