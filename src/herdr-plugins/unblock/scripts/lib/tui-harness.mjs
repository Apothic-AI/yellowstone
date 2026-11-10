/**
 * Event-driven pty driver shared by the TUI verification scripts.
 *
 * Why this exists. The verification scripts used to feed keys on fixed
 * wall-clock sleeps (`[[600, 'x'], [500, 'x']]`). On a loaded machine the child
 * had not finished booting or painting when the first key arrived, the key was
 * dropped, and the assertion failed for a reason that had nothing to do with
 * the behaviour under test. The failure count also moved between runs, which is
 * worse than a stable failure: it made "verified" a thing you could not trust.
 *
 * The TUI repaints by writing `ESC[H ESC[2J` followed by a whole screen, so a
 * frame is a countable, observable event. Every step here waits for the effect
 * it expects — the first frame, a frame after a key, a piece of text, the child
 * exiting — instead of guessing how long the machine will take. A dropped or
 * unhandled key still fails, but now it fails loudly and reproducibly.
 */
import { spawn } from 'node:child_process'

/** The sequence the TUI writes before every full repaint. */
export const CLEAR = '\x1b[H\x1b[2J'

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '')

/**
 * Start the real TUI under a pty and return a driver for it.
 *
 * @param {object} options
 * @param {string} options.tuiPath   absolute path to plugin/tui.js
 * @param {object} options.env       environment for the child (must set UNBLOCK_PORT etc.)
 * @param {number} [options.stepTimeoutMs] how long one key may take to show an effect
 * @param {number} [options.quitGraceMs]   how long `q` gets to exit before SIGTERM
 */
export function createTuiDriver({ tuiPath, env, stepTimeoutMs = 10000, quitGraceMs = 2000 }) {
  const child = spawn('script', ['-qec', `node ${tuiPath}`, '/dev/null'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let out = ''
  let exited = false
  const waiters = new Set()

  const wake = () => { for (const waiter of [...waiters]) waiter() }

  // A test that fails must not keep the process alive on a live pty handle, and
  // must not leave the TUI running after node exits. Removed again on close, so
  // driving the TUI several times in one script does not pile up listeners.
  const exitGuard = () => { try { child.kill('SIGKILL') } catch { /* already gone */ } }
  process.on('exit', exitGuard)

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { out += chunk; wake() })
  // stderr is folded in so a crash shows up in the captured text instead of
  // leaving an assertion to fail with no explanation.
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { out += chunk; wake() })
  child.on('close', () => { exited = true; process.off('exit', exitGuard); wake() })

  /** Resolve true as soon as `predicate` holds, false if the timeout wins. */
  function waitUntil(predicate, timeoutMs) {
    return new Promise((resolve) => {
      if (predicate()) return resolve(true)
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        waiters.delete(check)
        clearTimeout(timer)
        resolve(value)
      }
      const check = () => { if (predicate()) finish(true) }
      const timer = setTimeout(() => finish(false), timeoutMs)
      waiters.add(check)
    })
  }

  const splitFrames = () => out.split(CLEAR)
  const frameCount = () => splitFrames().length - 1

  return {
    /** Raw captured bytes, exactly as the terminal received them. */
    get output() { return out },
    get exited() { return exited },

    frameCount,
    /** Every complete frame, ANSI stripped, oldest first. */
    frames: () => splitFrames().slice(1).map(stripAnsi),
    /** The newest frame — the only one that describes the current screen. */
    lastFrame: () => stripAnsi(splitFrames().at(-1) || ''),
    /** All output with ANSI and newlines flattened, for substring checks. */
    flat: () => stripAnsi(out).replace(/\s+/g, ' '),

    /** Wait until at least `n` frames have been painted. */
    waitForFrame(n = 1, timeoutMs = stepTimeoutMs) {
      return waitUntil(() => frameCount() >= n, timeoutMs)
    },

    /** Wait until the flattened output contains `text`. */
    waitForText(text, timeoutMs = stepTimeoutMs) {
      return waitUntil(() => this.flat().includes(text), timeoutMs)
    },

    /**
     * Wait until the TUI has painted a screen that lists at least one ask.
     * The list header reads "<n> waiting"; the empty state reads "clear".
     * Titles wrap at the column width, so they are not safe markers.
     */
    waitForQueue(timeoutMs = stepTimeoutMs) {
      return waitUntil(() => this.flat().includes('waiting'), timeoutMs)
    },

    /**
     * Send one key and wait for the repaint it causes.
     * Returns false if no frame followed within `stepTimeoutMs` — that is a real
     * signal (the key was ignored or the TUI is wedged), not something to hide.
     */
    async press(key) {
      const before = frameCount()
      try {
        child.stdin.write(key)
      } catch {
        return false
      }
      return waitUntil(() => frameCount() > before, stepTimeoutMs)
    },

    /** Ask the TUI to quit, then tear it down so a run cannot hang. */
    async quit(key = 'q') {
      try {
        child.stdin.write(key)
      } catch {
        /* already gone */
      }
      if (await waitUntil(() => exited, quitGraceMs)) return true
      return this.kill()
    },

    /**
     * Terminate unconditionally, for failure paths.
     *
     * SIGTERM alone is not always enough: the direct child is `script` and the
     * TUI is its grandchild behind a pty, so a SIGTERM that `script` does not
     * forward leaves a live `node tui.js` holding the state dir. Escalate to
     * SIGKILL rather than report a cleanup that did not happen.
     */
    async kill() {
      if (exited) return true
      child.kill('SIGTERM')
      if (await waitUntil(() => exited, quitGraceMs)) return true
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      return waitUntil(() => exited, quitGraceMs)
    },
  }
}