// The queue line has to say where an ask came from: workspace, tab, pane — by
// name, because 'pane w7:p1' is not something a person can picture. FT-09.
// Contract: the head row reads 'workspace · tab · pane · age' with the names
// paneOrigin collected; a missing name falls back to the raw id (pane) or the
// id herdr gave the tab; with no workspace name at all it still says
// 'workspace'. Proven on rendered frames of the real TUI, not by inspection.
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = new URL('..', import.meta.url).pathname

async function frameAt(cols, origin) {
  const args = ['test/helpers/tui-frame.mjs', String(cols), '24', '--no-expand']
  if (origin) args.push(`--origin=${JSON.stringify(origin)}`)
  const { stdout } = await run('node', args, {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1' },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 90_000,
  })
  // Carriage returns come from the pty's own line discipline, not the renderer.
  return stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '')
}

async function headRow(cols, origin) {
  const frame = await frameAt(cols, origin)
  const row = frame.split('\n').find((line) => line.includes(' question  '))
  assert.ok(row, `head row missing from frame:\n${frame}`)
  return row
}

test('a fully named origin renders workspace · tab · pane names', async () => {
  const row = await headRow(110, {
    agent: 'pi', workspace_id: 'w1T', workspace_name: 'Comms',
    tab_id: 'w1T:t1', tab_name: 'comms-leader', pane_id: 'w1T:p1', pane_name: 'pi-comms',
  })
  assert.ok(row.includes('Comms · comms-leader · pi-comms'), `names missing from head row:\n${row}`)
  assert.ok(!row.includes('w1T:p1'), `raw pane id should be replaced by the pane name:\n${row}`)
})

test('a tab without a label falls back to its id', async () => {
  const row = await headRow(110, {
    agent: 'pi', workspace_name: 'wrap-test',
    tab_id: 'w1T:t1', pane_id: 'w1T:p1', pane_name: 'pi-comms',
  })
  assert.ok(row.includes('wrap-test · w1T:t1 · pi-comms'), `tab id fallback missing:\n${row}`)
})

test('a pane without a name falls back to the raw pane id', async () => {
  const row = await headRow(110, {
    agent: 'pi', workspace_name: 'wrap-test',
    tab_id: 'w1T:t1', tab_name: 'comms-leader', pane_id: 'w1T:p1',
  })
  assert.ok(row.includes('wrap-test · comms-leader · pane w1T:p1'), `pane id fallback missing:\n${row}`)
})

test('an ask with no tab and no pane name keeps the old shape', async () => {
  // Default fixture origin: { agent, workspace_name, pane_id } only.
  const row = await headRow(110)
  assert.ok(row.includes('wrap-test · pane 1 · '), `sparse origin should render as before:\n${row}`)
  assert.ok(!row.includes('undefined'), `no fallback may print 'undefined':\n${row}`)
})

test('an origin herdr could not resolve still says workspace', async () => {
  const row = await headRow(110, { agent: 'pi', tab_name: 'ops', pane_name: 'pi' })
  assert.ok(row.includes('workspace · ops · pi · '), `workspace fallback missing:\n${row}`)
})
