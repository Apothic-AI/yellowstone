// FT-09: paneOrigin has to collect names, not just ids — the TUI and the web
// panel label an ask with workspace_name, tab_name and pane_name, and every
// one of them must degrade to absent (not to a wrong guess) when herdr cannot
// or does not provide it. The pane name resolves through what a person would
// call the pane: its manual label, then the agent in it, then the agent's own
// terminal title. Proven against a fake herdr socket, no live herdr needed.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// One socket for the whole file: herdr.js reads HERDR_SOCKET_PATH once at
// import, so the scenarios below swap the server's answer table instead of
// rebinding the path.
let answers = {}
const server = createServer((socket) => {
  let buf = ''
  socket.on('data', (chunk) => {
    buf += chunk
    const line = buf.split('\n').find((l) => l.trim())
    if (!line) return
    let request
    try { request = JSON.parse(line) } catch { socket.end(); return }
    // Real herdr wraps payloads in `result` and failures in a sibling `error`;
    // the tables below store exactly that response body.
    const reply = answers[request.method] ?? { error: { code: -32601, message: 'method not found' } }
    socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...reply }) + '\n')
  })
})
const socketPath = join(mkdtempSync(join(tmpdir(), 'unblock-origin-')), 'herdr.sock')
await new Promise((resolve) => server.listen(socketPath, resolve))
// The test runner must be able to exit when the cases are done: an idle
// listening socket would otherwise keep the process alive forever.
server.unref()
process.env.HERDR_SOCKET_PATH = socketPath

const { paneOrigin } = await import('../plugin/herdr.js')

const PANE = {
  pane_id: 'w1T:p1', tab_id: 'w1T:t1', workspace_id: 'w1T',
  cwd: '/home/bitnom/Documents/Comms', foreground_cwd: '/home/bitnom/Documents/Comms',
  label: 'pi-comms', agent: 'pi', terminal_title_stripped: 'π - Comms',
}
const WS = { workspace_id: 'w1T', label: 'Comms', profiles: ['next'] }
const TAB = { tab_id: 'w1T:t1', number: 1, label: 'comms-leader' }
const ROUTINE = {
  'pane.list': { result: { panes: [PANE] } },
  'workspace.list': { result: { workspaces: [WS] } },
  'tab.list': { result: { tabs: [TAB] } },
}

function withAnswers(table) {
  answers = table
}

test('a fully named pane collects workspace, tab and pane names', async () => {
  withAnswers(ROUTINE)
  const origin = await paneOrigin('w1T:p1')
  assert.equal(origin.workspace_name, 'Comms')
  assert.equal(origin.tab_name, 'comms-leader')
  assert.equal(origin.pane_name, 'pi-comms')
  assert.equal(origin.tab_id, 'w1T:t1')
  assert.equal(origin.workspace_id, 'w1T')
  assert.deepEqual(origin.profiles, ['next'])
})

test('the pane name falls back agent, then terminal title, then nothing', async () => {
  withAnswers({
    ...ROUTINE,
    'pane.list': { result: { panes: [{ ...PANE, label: undefined, display_agent: 'pi · lane' }] } },
  })
  assert.equal((await paneOrigin('w1T:p1')).pane_name, 'pi · lane', 'display_agent should be second choice')

  withAnswers({
    ...ROUTINE,
    'pane.list': { result: { panes: [{ ...PANE, label: undefined, display_agent: undefined }] } },
  })
  assert.equal((await paneOrigin('w1T:p1')).pane_name, 'pi', 'agent should be third choice')

  withAnswers({
    ...ROUTINE,
    'pane.list': { result: { panes: [{ ...PANE, label: undefined, display_agent: undefined, agent: undefined }] } },
  })
  assert.equal((await paneOrigin('w1T:p1')).pane_name, 'π - Comms', 'terminal title should be fourth choice')

  withAnswers({
    ...ROUTINE,
    'pane.list': { result: { panes: [{ pane_id: 'w1T:p1', tab_id: 'w1T:t1', workspace_id: 'w1T', cwd: '/x' }] } },
  })
  assert.equal((await paneOrigin('w1T:p1')).pane_name, undefined, 'an unnamed shell pane has no name')
})

test('a herdr without tab.list leaves tab_name off but keeps the rest', async () => {
  withAnswers({
    'pane.list': { result: { panes: [PANE] } },
    'workspace.list': { result: { workspaces: [WS] } },
    // tab.list is not in the table, so it answers method-not-found.
  })
  const origin = await paneOrigin('w1T:p1')
  assert.equal(origin.tab_name, undefined)
  assert.equal(origin.workspace_name, 'Comms')
  assert.equal(origin.pane_name, 'pi-comms')
  assert.equal(origin.tab_id, 'w1T:t1')
})

test('a tab with no label falls back to its number', async () => {
  withAnswers({ ...ROUTINE, 'tab.list': { result: { tabs: [{ tab_id: 'w1T:t1', number: 2 }] } } })
  assert.equal((await paneOrigin('w1T:p1')).tab_name, 'tab 2')
})

test('a pane herdr no longer knows leaves only the id', async () => {
  withAnswers({ 'pane.list': { result: { panes: [] } }, 'workspace.list': { result: { workspaces: [WS] } }, 'tab.list': { result: { tabs: [TAB] } } })
  const origin = await paneOrigin('gone:p9')
  assert.deepEqual(origin, { pane_id: 'gone:p9' })
})
