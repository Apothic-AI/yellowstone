// A card in the TUI is read, not clipped. Alex (2026-10-24): a long agent
// message ran off the right edge with no way to read it, and there was no way
// to scroll to the right, so the end of the question was unreachable.
// Contract: every prose row of a card word-wraps to the row width and nothing
// in the body is hidden behind an ellipsis; a long URL is split on a natural
// break so it can be read and put back together; the footer and its key chips
// wrap rather than running off the edge.
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = new URL('..', import.meta.url).pathname

async function frameAt(cols, rows = 44) {
  const { stdout } = await run('node', ['test/helpers/tui-frame.mjs', String(cols), String(rows)], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1' },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 90_000,
  })
  // Carriage returns come from the pty's own line discipline, not the renderer.
  return stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '')
}

test('a long ask wraps to the terminal width instead of clipping', async () => {
  const frame = await frameAt(40)
  const rows = frame.split('\n').filter((line) => line.trim())
  assert.ok(rows.length > 15, `frame should contain the open card:\n${frame}`)

  // Everything the agent wrote is readable somewhere on screen.
  const flat = rows.map((line) => line.trim()).join(' ')
  for (const needle of [
    'the internal team',
    'avoid the word production',
    'which one you want.',
    'verbatim.',
    'staging-banner-copy-drafts',
    'next field',
  ]) {
    assert.ok(flat.includes(needle), `"${needle}" is missing from the frame:\n${frame}`)
  }

  // No row runs past the terminal, and only the header line (workspace, pane,
  // age — meta, not prose) is allowed to ellipsize.
  // The header (workspace, pane, age) and the card's own head row are meta,
  // not prose; anything else must not hide words behind an ellipsis.
  const prose = rows.filter((line) => !line.startsWith(' ▌') && !line.includes(' question  '))
  assert.deepEqual(prose.filter((line) => line.includes('…')), [], `clipped rows:\n${frame}`)
  const widest = Math.max(...prose.map((line) => [...line.replace(/\r/g, '')].length))
  assert.ok(widest <= 40, `a row is ${widest} columns in a 40-column terminal:\n${frame}`)
})

test('the same card fits a wide terminal without wrapping early', async () => {
  const frame = await frameAt(120)
  const rows = frame.split('\n')
  const whyRow = rows.find((line) => line.includes('The banner runs across'))
  assert.ok(whyRow, `missing the why row:\n${frame}`)
  assert.ok(whyRow.includes('internal team'), 'a wide terminal should not wrap this early')
})

test('a folded row stays one line, so the queue is still an index', async () => {
  const { stdout } = await promisify(execFile)('node', ['test/helpers/tui-frame.mjs', '40', '30', '--no-expand'], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1' },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 90_000,
  })
  const rows = stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '').split('\n')
  const whyRows = rows.filter((line) => line.includes('The banner runs across'))
  assert.equal(whyRows.length, 1, `a folded card should occupy one why row:\n${rows.join('\n')}`)
  assert.ok(whyRows[0].trimEnd().endsWith('…'), 'a folded row is a preview, clipped to one line')
})
