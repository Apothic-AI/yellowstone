/**
 * Render one frame of the real TUI at a fixed size, for tests.
 *
 * The pane is driven through `script(1)`, so it gets a real tty: the renderer
 * only runs interactively when stdin is one, and key presses have to arrive on
 * that same tty.
 *
 *   node test/helpers/tui-frame.mjs <cols> <rows> [--no-expand]
 *
 * Boots a throwaway daemon (see tui-fixture.mjs), opens the first card, prints
 * the final frame with ANSI stripped. Nothing touches the real queue.
 */
import { spawn } from 'node:child_process'
import { bootFixtureDaemon } from './tui-fixture.mjs'

const cols = Number(process.argv[2] || 60)
const rows = Number(process.argv[3] || 40)
const expand = !process.argv.includes('--no-expand')

const fixture = await bootFixtureDaemon()
const child = spawn('script', ['-qec', `stty cols ${cols} rows ${rows} 2>/dev/null; exec node plugin/tui.js`, '/dev/null'], {
  cwd: new URL('../..', import.meta.url).pathname,
  env: { ...fixture.env, COLUMNS: String(cols), LINES: String(rows) },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let out = ''
child.stdout.on('data', (chunk) => { out += chunk })
child.stderr.on('data', (chunk) => { out += chunk })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

await wait(1600)              // first frame, after the queue loads
if (expand) child.stdin.write('\r')
await wait(1100)              // expanded frame
child.kill('SIGTERM')
await wait(150)
await fixture.close()

const frame = out.split('\x1b[H\x1b[2J').filter((part) => part.trim()).pop() || out
process.stdout.write(frame.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''))
process.exit(0)
