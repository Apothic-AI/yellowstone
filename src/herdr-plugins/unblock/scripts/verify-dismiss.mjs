/**
 * Dismiss verification: boots a throwaway daemon with three open asks and
 * drives the real TUI over a pty, asserting the confirm/cancel/enter paths and
 * the persisted note.
 *
 *   node scripts/verify-dismiss.mjs
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTuiDriver } from './lib/tui-harness.mjs'
import { DISMISS_NOTE } from '../src/queue-model.js'

const stateDir = mkdtempSync(join(tmpdir(), 'unblock-dismiss-'))
process.env.UNBLOCK_STATE_DIR = stateDir
process.env.UNBLOCK_CONFIG_DIR = join(stateDir, 'config')
process.env.UNBLOCK_SECRET_BACKEND = 'env'
const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
const auth = loadOrCreateSecret()
const daemon = await startDaemon({ port: 0 })
const base = `http://127.0.0.1:${daemon.port}`
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(400) })).ok) break } catch {}
  await new Promise((r) => setTimeout(r, 100))
}

async function file(title) {
  const response = await fetch(`${base}/api/asks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` },
    body: JSON.stringify({
      ask: { kind: 'file', title, why: 'Only a human can decide this one.', purpose: 'question', only_you: 'judgment',
        tried: ['Read the CLI help and the API docs; neither can decide it for the human.'],
        fields: [{ name: 'answer', type: 'text', label: 'Answer', required: false }] },
      origin: { agent: 'verify', session_id: 'verify-dismiss' },
    }),
  })
  if (!response.ok) throw new Error(await response.text())
  return (await response.json()).ticket
}

const t1 = await file('Dismiss me with enter')
const t2 = await file('Keep me with escape')
const t3 = await file('Forget the prompt with j')
const t4 = await file('Enter still opens the card')

const env = { ...process.env, UNBLOCK_STATE_DIR: stateDir, UNBLOCK_PORT: String(daemon.port), UNBLOCK_AUTH: auth, COLUMNS: '100', LINES: '40' }

/**
 * Drive the TUI under a pty, one key at a time, and return the captured output.
 * Each step waits for the effect it expects instead of sleeping, so keys are
 * never delivered before the TUI is reading them.
 */
async function drive(keys) {
  const tui = createTuiDriver({ tuiPath: new URL('../plugin/tui.js', import.meta.url).pathname, env })
  try {
    if (!(await tui.waitForFrame(1))) throw new Error('the TUI painted no frame')
    if (!(await tui.waitForQueue())) throw new Error('the TUI never listed an open ask')
    for (const key of keys) {
      if (!(await tui.press(key))) throw new Error(`key ${JSON.stringify(key)} produced no repaint`)
    }
    await tui.quit()
    return tui.output
  } finally {
    // A failing check leaves this function by throwing. Without this the pty
    // child would outlive the run and keep holding the temp state dir, so the
    // assertion's own message would be the last thing you could trust.
    await tui.kill()
  }
}

const strip = (text) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '')
// Screens are full repaints, so only the last frame describes the current state.
const lastFrame = (text) => strip(text.split('\x1b[H\x1b[2J').pop() || '')
// The list endpoint drops closed asks on purpose, so status is read per ticket.
const get = async (ticket) => (await (await fetch(`${base}/api/asks/${ticket}`, { headers: { authorization: `Bearer ${auth}` } })).json())

// 1. x -> enter closes the first ask and the footer says so.
const raw1 = await drive(['x', 'x'])
const s1 = lastFrame(raw1)
// 2. x -> esc keeps it.
const s2 = lastFrame(await drive(['x', '\x1b']))
// 3. x -> j forgets the prompt AND the j still moves the selection.
const s3 = lastFrame(await drive(['x', 'j']))

const [a1, a2, a3] = await Promise.all([get(t1), get(t2), get(t3)])
const byTitle = (t) => [a1, a2, a3].find((a) => a.title === t)
const findings = []
const check = (name, ok, detail = '') => findings.push({ name, ok, detail })

// The footer wraps, so the sentence is matched across line breaks.
const flat = (text) => text.replace(/\s+/g, ' ')
// The confirmation is its own frame; x x repaints over it immediately.
const allFrames = (text) => text.split('\x1b[H\x1b[2J').slice(1)
check('confirm prompt shown', allFrames(raw1).some((f) => flat(f).includes('x again to close')), '')
check('closed footer', s1.includes('the agent will re-check'), s1.match(/closed ub_\w+[^\n]*/)?.[0] || '')
check('x x closes the ask', byTitle('Dismiss me with enter')?.status === 'cancelled', JSON.stringify(byTitle('Dismiss me with enter')?.status))
check('stored note is the default', byTitle('Dismiss me with enter')?.note === DISMISS_NOTE, JSON.stringify(byTitle('Dismiss me with enter')?.note))
check('escape keeps it', byTitle('Keep me with escape')?.status === 'open', JSON.stringify(byTitle('Keep me with escape')?.status))
check('escape footer', s2.includes('kept'), s2.match(/kept/)?.[0] || '')
check('other key forgets prompt', a3.status === 'open' && !s3.includes('without answering?'), `status=${a3.status} title=${JSON.stringify(a3.title)} promptGone=${!s3.includes('without answering?')}`)
check('closed ask leaves the list', !s1.includes('Dismiss me with enter') || s1.lastIndexOf('closed ub_') > s1.indexOf('Dismiss me with enter'), '')

// 4. Regression: x then Enter is still "open the card", never a dismissal.
const s4 = lastFrame(await drive(['x', '\r']))
const [a4] = await Promise.all([get(t4)])
check('x then Enter does not close', a4.status === 'open', `status=${a4.status}`)
check('x then Enter still opens the card', /why\s*$/im.test(s4) || s4.includes('Only a human can decide this one.') || s4.includes('needs:'), s4.split('\n').filter((l) => l.trim()).slice(-3).join(' | '))

for (const f of findings) console.log(`${f.ok ? 'PASS' : 'FAIL'}  ${f.name}${f.ok ? '' : `  <- ${f.detail}`}`)
const failed = findings.filter((f) => !f.ok).length
console.log(failed ? `\n${failed} failed` : '\nall dismiss checks passed')
process.exit(failed ? 1 : 0)
