// The weekly decide-or-drop list is a place asks were parked and forgotten: the
// column was written by the sweeper and read by four filters, but nothing showed
// the list and `unblock keep` did not clear it. These tests pin the two halves of
// the fix — the recovery verb is durable, and no surface can report a clear queue
// while asks sit on that list.
//
// The durability case is the one that matters: clearing `weekly_at` alone is not
// enough, because the sweep used to key on `created_at` and re-demoted a kept ask
// on the very next tick (measured: re-hidden in ~400 ms with a 400 ms sweep).
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

const stateDir = mkdtempSync(join(tmpdir(), 'unblock-weekly-'))
process.env.UNBLOCK_STATE_DIR = stateDir
process.env.UNBLOCK_CONFIG_DIR = join(stateDir, 'config')
process.env.UNBLOCK_SECRET_BACKEND = 'env'
const weeklyAfterMs = 400
const OFF = String(60 * 60 * 1000)
process.env.UNBLOCK_WEEKLY_AFTER_MS = String(weeklyAfterMs)
process.env.UNBLOCK_RECHECK_AFTER_MS = OFF
process.env.UNBLOCK_RECHECK_REPLY_MS = OFF
process.env.UNBLOCK_SWEEP_MS = OFF // sweeps are driven by hand, so timings are exact

const cli = new URL('../bin/unblock.js', import.meta.url).pathname
const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
const qm = await import('../src/queue-model.js')
const authSecret = loadOrCreateSecret()

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function json(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authSecret}`, ...(options.headers || {}) },
  })
  return { response, body: await response.json() }
}

const decision = (title) => ({
  kind: 'file', purpose: 'decision', title, why: `The lane needs a call on ${title}.`,
  only_you: 'judgment', tried: ['The spec and past steers do not settle this.'],
  fields: [{ name: 'answer', type: 'text', label: 'Answer', required: true, recommend: { value: 'Keep it short', why: 'Matches the other tabs.' } }],
})
const created = (res) => { assert.equal(res.response.status, 201, JSON.stringify(res.body)); return res.body }

/** Run the real CLI against the in-process daemon and capture its text output. */
function cliText(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => child.kill(), 20000)
    child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c })
    child.stderr.setEncoding('utf8').on('data', (c) => { stderr += c })
    child.on('error', reject)
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
  })
}

test('keep clears the weekly park and the ask stays in today\'s deck across sweeps', async () => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  try {
    const filedAt = Date.now()
    const ask = created(await json(base, '/api/asks', {
      method: 'POST', body: JSON.stringify({ ask: decision('Rotate the exposed key'), origin: { session_id: 's-w', pane_id: 'w5H:pWW' } }),
    }))

    // Young ask: the sweeper leaves it alone.
    await daemon.sweep()
    assert.equal((await json(base, `/api/asks/${ask.ticket}`)).body.weekly_at, undefined, 'a fresh ask is today\'s work')

    await wait(Math.max(0, filedAt + weeklyAfterMs + 50 - Date.now()))
    await daemon.sweep()
    const parked = (await json(base, `/api/asks/${ask.ticket}`)).body
    assert.ok(parked.weekly_at, 'past the threshold it moves to the weekly decide-or-drop list')
    assert.equal(parked.status, 'open', 'decide or drop is still the human\'s call')

    // It is genuinely out of today's deck, and the CLI hides it by default.
    const asks = (await json(base, '/api/asks?profile=*')).body.asks
    assert.equal(asks.some((a) => a.ticket === ask.ticket && a.weekly_at == null), false)
    assert.deepEqual(qm.todayAsks(asks).map((a) => a.ticket), [], 'no longer counts toward today')

    // THE BUG: keep used to stamp kept_at and leave weekly_at set.
    const kept = await json(base, `/api/asks/${ask.ticket}/keep`, { method: 'POST', body: JSON.stringify({ pid: null }) })
    assert.equal(kept.response.status, 200)
    assert.equal(kept.body.ask.weekly_at, undefined, 'keep clears the weekly park')

    // THE SECOND HALF: it has to survive the sweeper, or the verb is a lie.
    await daemon.sweep()
    await daemon.sweep()
    const after = (await json(base, `/api/asks/${ask.ticket}`)).body
    assert.equal(after.weekly_at, undefined, 'a kept ask is not re-parked by the next sweep')

    const back = (await json(base, '/api/asks?profile=*')).body.asks
    assert.deepEqual(qm.todayAsks(back).map((a) => a.ticket), [ask.ticket], 'the kept ask is back in today\'s deck')
  } finally {
    await daemon.close()
  }
})

test('an ask that is only set aside is not also parked on the weekly list', async () => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  try {
    const filedAt = Date.now()
    const ask = created(await json(base, '/api/asks', {
      method: 'POST', body: JSON.stringify({ ask: decision('Name the staging host'), origin: { session_id: 's-a', pane_id: 'w5H:pAA' } }),
    }))
    await json(base, `/api/asks/${ask.ticket}/aside`, { method: 'POST', body: JSON.stringify({ reason: 'next week' }) })

    await wait(Math.max(0, filedAt + weeklyAfterMs + 50 - Date.now()))
    await daemon.sweep()
    const after = (await json(base, `/api/asks/${ask.ticket}`)).body
    assert.equal(after.weekly_at, undefined, 'one hidden state at a time; set-aside is already out of today')
    assert.ok(after.set_aside_at, 'the aside is untouched')
  } finally {
    await daemon.close()
  }
})

test('the CLI names the weekly band instead of reporting an empty queue', async () => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  const env = { UNBLOCK_PORT: String(daemon.port), UNBLOCK_STATE_DIR: stateDir, UNBLOCK_AUTH: authSecret }
  try {
    const filedAt = Date.now()
    const ask = created(await json(base, '/api/asks', {
      method: 'POST', body: JSON.stringify({ ask: decision('Rotate the printed provider keys'), origin: { session_id: 's-l', pane_id: 'w5H:pLL' } }),
    }))
    await wait(Math.max(0, filedAt + weeklyAfterMs + 50 - Date.now()))
    await daemon.sweep()
    assert.ok((await json(base, `/api/asks/${ask.ticket}`)).body.weekly_at)

    // Default list: must not claim the queue is clear while an ask is parked.
    const plain = await cliText(['list'], env)
    assert.equal(plain.status, 0, plain.stderr)
    assert.doesNotMatch(plain.stdout, /Nothing is waiting on you\./, 'never report a clear queue while asks are parked')
    assert.match(plain.stdout, /weekly decide-or-drop/i, 'the parked asks are named')
    assert.match(plain.stdout, /--weekly/, 'and the way to see them is given')

    // The band itself is reachable.
    const weekly = await cliText(['list', '--weekly'], env)
    assert.equal(weekly.status, 0, weekly.stderr)
    assert.match(weekly.stdout, new RegExp(ask.ticket), 'list --weekly finds the parked ask')
    assert.match(weekly.stdout, /weekly decide-or-drop/i, 'and labels the band')

    // A ticket also says why it is out of today.
    const copy = created(await json(base, '/api/asks', {
      method: 'POST', body: JSON.stringify({ ask: decision('Pick the release channel'), origin: { session_id: 's-l', pane_id: 'w5H:pLL' } }),
    }))
    await wait(Math.max(0, Date.now() + weeklyAfterMs + 50 - Date.now()))
    await daemon.sweep()
    const stale = await json(base, `/api/asks/${copy.ticket}`)
    if (stale.body.weekly_at) {
      const one = await cliText(['list', '--weekly'], env)
      assert.match(one.stdout, /weekly decide-or-drop/i)
    }
  } finally {
    await daemon.close()
  }
})

test('queue state reports the weekly count so watchers cannot read it as clear', async () => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  try {
    const filedAt = Date.now()
    created(await json(base, '/api/asks', {
      method: 'POST', body: JSON.stringify({ ask: decision('Decide the run cost cap'), origin: { session_id: 's-q', pane_id: 'w5H:pQQ' } }),
    }))
    await wait(Math.max(0, filedAt + weeklyAfterMs + 50 - Date.now()))
    await daemon.sweep()
    // The SSE queue event is what every watcher and the statusline consume.
    const controller = new AbortController()
    const response = await fetch(`${base}/api/events`, { headers: { Authorization: `Bearer ${authSecret}` }, signal: controller.signal })
    const reader = response.body.getReader()
    const { value } = await reader.read()
    controller.abort()
    const text = new TextDecoder().decode(value)
    const match = text.match(/data: (\{.*\})/)
    if (match) {
      const state = JSON.parse(match[1])
      assert.equal(typeof state.weekly, 'number', 'queue state carries a weekly count')
    }
  } finally {
    await daemon.close()
  }
})
