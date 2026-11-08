/**
 * Boot a throwaway daemon with one long-bodied ask, so a TUI frame can be read
 * against real data. Nothing touches the real queue: the state dir is a temp
 * dir and the daemon binds port 0.
 *
 * Returns { env, ask, close } — `close()` stops the daemon.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const LONG_ASK = {
  kind: 'park', purpose: 'question', only_you: 'judgment', project: 'wrap-test',
  title: 'Pick the staging banner wording',
  why: 'The banner runs across the top of every staging page, and the current copy was written for the '
    + 'internal team. Customers now see staging during onboarding, so the wording has to warn without '
    + 'alarming, name the environment plainly, and avoid the word production anywhere in the sentence.',
  steps: [
    'Read the three drafts in the doc and the review thread where the conflict came up, then say which one you want.',
    'If none fit, write the line you want in the field below and the agent will use it verbatim.',
  ],
  links: [{ label: 'Banner copy drafts', url: 'https://example.invalid/docs/staging-banner-copy-drafts-and-notes' }],
  fields: [{
    name: 'pick', type: 'choice', label: 'Which draft goes live', required: true,
    choices: [{ value: 'a', label: 'Draft A' }, { value: 'b', label: 'Draft B' }],
  }],
}

export async function bootFixtureDaemon({ ask = LONG_ASK } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'unblock-frame-'))
  process.env.UNBLOCK_STATE_DIR = stateDir
  process.env.UNBLOCK_CONFIG_DIR = join(stateDir, 'config')
  process.env.UNBLOCK_SECRET_BACKEND = 'env'

  const { startDaemon, loadOrCreateSecret } = await import('../../src/daemon.js')
  const auth = loadOrCreateSecret()
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`

  const filed = await fetch(`${base}/api/asks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
    body: JSON.stringify({
      ask: { tried: ['Checked the CLI and the API; neither can make this call.'], ...ask },
      origin: { agent: 'codex', workspace_name: 'wrap-test', pane_id: '1' },
    }),
  })
  if (!filed.ok) throw new Error(await filed.text())

  return {
    env: {
      ...process.env,
      NO_COLOR: '1',
      UNBLOCK_STATE_DIR: stateDir,
      UNBLOCK_CONFIG_DIR: join(stateDir, 'config'),
      UNBLOCK_SECRET_BACKEND: 'env',
      UNBLOCK_PORT: String(daemon.port),
      UNBLOCK_AUTH: auth,
    },
    close: () => daemon.close?.(),
  }
}
