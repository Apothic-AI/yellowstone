/**
 * Demo seeder: boots the daemon on a temp state dir and files one ask of every
 * shape, so the TUI and the web panel can be eyeballed against real data.
 *
 *   node scripts/demo-seed.mjs            # prints the env + urls, stays up
 *   node scripts/demo-seed.mjs --once     # seeds, prints env, exits (daemon dies with it)
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stateDir = mkdtempSync(join(tmpdir(), 'unblock-demo-'))
process.env.UNBLOCK_STATE_DIR = stateDir
process.env.UNBLOCK_CONFIG_DIR = join(stateDir, 'config')
process.env.UNBLOCK_SECRET_BACKEND = 'env'

const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
const auth = loadOrCreateSecret()
const daemon = await startDaemon({ port: Number(process.env.UNBLOCK_PORT || 0) || 0 })
const base = `http://127.0.0.1:${daemon.port}`

async function file(ask) {
  const response = await fetch(`${base}/api/asks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
    body: JSON.stringify({
      ask: { kind: 'file', tried: ['Checked the CLI and API; neither can do this as the human.'], ...ask },
      origin: { agent: 'codex', session_id: 'demo', workspace_name: 'unblock', pane_id: '3' },
    }),
  })
  const body = await response.json()
  if (!response.ok) throw new Error(`${ask.title}: ${JSON.stringify(body)}`)
  return body
}

await file({
  kind: 'park',
  title: 'Approve the production deploy command',
  why: 'The release is staged and tested. Only you can run the deploy step against production.',
  purpose: 'permission', gating: true, only_you: 'their_account',
  permission: { tool: 'shell', command: 'flyctl deploy --app unblock --image registry.fly.io/unblock:4f2a1c', summary: 'Deploy the staged build to production' },
})
await file({
  title: 'Which outreach template should the agent send?',
  why: 'Two finalists tested well. The agent recommends the plain-text one: it reads personal and lands in primary more often.',
  purpose: 'decision', only_you: 'judgment',
  fields: [{
    name: 'template', type: 'choice', label: 'Template', required: true,
    choices: [
      { value: 'plain', label: 'Plain text', description: 'Reads like a person wrote it' },
      { value: 'branded', label: 'Branded HTML', description: 'Logo, colors, footer' },
    ],
    recommend: { value: 'plain', why: 'higher reply rate in the last batch' },
  }],
})
await file({
  title: 'Add the OPENAI_API_KEY for the summarizer',
  why: 'The summarizer needs a key from your OpenAI account. It is stored locally; the agent only gets a reference.',
  purpose: 'blocker', only_you: 'credential', minutes: 1,
  links: [{ label: 'OpenAI API keys', url: 'https://platform.openai.com/api-keys' }],
  fields: [{ name: 'key', type: 'secret', label: 'OpenAI API key', required: true, help: 'Starts with sk-', url: 'https://platform.openai.com/api-keys' }],
})
await file({
  title: 'Buy the staging domain on Namecheap',
  why: 'The launch checklist needs staging.unblock.example before Monday. Link will ask you to confirm on your phone.',
  purpose: 'spend', only_you: 'spend',
  spend: { item: 'staging domain', vendor: 'Namecheap', vendor_url: 'https://namecheap.com', amount_cents: 1249, currency: 'USD', cap_cents: 2000, why: 'staging environment' },
})
await file({
  title: 'Send the intro message to Priya',
  why: 'A warm intro was agreed last week; only you can message a real person.',
  purpose: 'message', only_you: 'message',
  message: { to: 'Priya', via: 'email', subject: 'Intro', text: 'Hi Priya — quick intro as promised.' },
})
await file({
  title: 'Sign in to the Vercel console and flip the flag',
  why: 'The agent cannot act in a console signed in as you.',
  purpose: 'consent', only_you: 'their_account',
  plan: {
    site: 'vercel.com', start_url: 'https://vercel.com/apothic/staging/settings/flags',
    steps: ['Open the staging project flags page', 'Toggle the new router flag', 'Screenshot the result'],
    changes: 'Only the new-router flag', untouched: 'Every other flag stays as it is',
  },
})
await file({
  title: 'Paste the migration output',
  why: 'The migration ran in a shell the agent cannot read.',
  purpose: 'blocker', only_you: 'credential',
  links: [{ label: 'Migration runbook', url: 'https://github.com/aneym/unblock/actions/workflows/migrate.yml' }],
  fields: [{ name: 'output', type: 'paste', label: 'Migration output', required: true, command: 'pnpm db:migrate 2>&1 | tail -40' }],
})
await file({
  title: 'What region should the new worker run in?',
  why: 'Latency to the database matters more than price here.',
  purpose: 'question', only_you: 'judgment',
  fields: [{ name: 'region', type: 'text', label: 'Region', placeholder: 'iad', required: false }],
})

console.log(`UNBLOCK_STATE_DIR=${stateDir}`)
console.log(`UNBLOCK_PORT=${daemon.port}`)
console.log(`UNBLOCK_AUTH=${auth}`)
console.log(`web: ${base}/`)

if (process.argv.includes('--once')) process.exit(0)
console.log('daemon up — ctrl-c to stop')
setInterval(() => {}, 60000)
