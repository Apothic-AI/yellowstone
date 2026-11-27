// A page ask is an agent-authored HTML document instead of fields, so these cases check the
// three things that make it useful: the daemon serves it SANDBOXED, the submit endpoint
// accepts whatever the page posts (multipart with files, urlencoded, JSON), and the
// submission lands as the ask's answer so the normal wake path can deliver it.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const stateDir = mkdtempSync(join(tmpdir(), 'unblock-page-'))
process.env.UNBLOCK_STATE_DIR = stateDir
process.env.UNBLOCK_CONFIG_DIR = join(stateDir, 'config')
process.env.UNBLOCK_SECRET_BACKEND = 'env'

const { startDaemon, loadOrCreateSecret, SANDBOXED_SUBMIT_SUFFIXES } = await import('../src/daemon.js')
const authSecret = loadOrCreateSecret()
const auth = { Authorization: `Bearer ${authSecret}` }

const PAGE = '<!doctype html><html><body><h1>Pick one</h1>'
  + '<form method="post" action="submit" enctype="multipart/form-data">'
  + '<input name="plan"><input name="note"><input type="file" name="shot">'
  + '<button>Send</button></form></body></html>'

const pageAsk = (extra = {}) => ({
  kind: 'page', purpose: 'decision', only_you: 'judgment', project: 'checkout',
  title: 'Pick the rollout plan', why: 'Two plans, one call.',
  tried: ['I read both plans and either works technically.'],
  html: PAGE, ...extra,
})

async function json(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...auth, ...(options.headers || {}) },
  })
  const text = await response.text()
  return { response, body: text ? JSON.parse(text) : null }
}

async function file(base, ask) {
  const filed = await json(base, '/api/asks', {
    method: 'POST',
    body: JSON.stringify({ ask, origin: { session_id: 's-page', pane_id: 'w5H:pPAGE' } }),
  })
  return filed
}

test('a page ask is served sandboxed and its multipart submission becomes the answer', async () => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  try {
    const filed = await file(base, pageAsk())
    assert.equal(filed.response.status, 201, JSON.stringify(filed.body))
    const ticket = filed.body.ticket
    assert.equal(filed.body.kind, 'page', 'the kind survives the round trip')
    assert.equal(filed.body.html, PAGE, 'the page is stored exactly as the agent wrote it')
    assert.deepEqual(filed.body.fields, [], 'a page ask carries no fields')

    const shell = await fetch(`${base}/api/asks/${ticket}/page`, { headers: auth })
    assert.equal(shell.status, 200)
    const shellText = await shell.text()
    assert.match(shellText, /sandbox="allow-forms allow-scripts"/, 'the iframe is sandboxed')
    assert.doesNotMatch(shellText, /allow-same-origin/, 'and never gains same-origin')
    assert.match(shellText, new RegExp(`/api/asks/${ticket}/page\\.html`), 'the iframe URL is per-ticket')

    const raw = await fetch(`${base}/api/asks/${ticket}/page.html`, { headers: auth })
    assert.equal(raw.status, 200)
    assert.equal(raw.headers.get('content-security-policy'), 'sandbox allow-forms allow-scripts')
    assert.equal(await raw.text(), PAGE, 'the page is served byte for byte')

    const form = new FormData()
    form.set('plan', 'canary')
    form.set('note', 'after the freeze')
    form.append('shot', new Blob([Buffer.from('PNGDATA')], { type: 'image/png' }), 'shot.png')
    const submitted = await fetch(`${base}/api/asks/${ticket}/submit`, { method: 'POST', body: form, headers: auth })
    assert.equal(submitted.status, 200)

    const after = await json(base, `/api/asks/${ticket}`)
    assert.equal(after.body.status, 'answered', 'the submission answers the ask')
    assert.equal(after.body.answers.plan, 'canary', 'an arbitrary field name is kept')
    assert.equal(after.body.answers.note, 'after the freeze')
    const attachments = after.body.answers._attachments
    assert.equal(attachments.length, 1)
    assert.equal(attachments[0].filename, 'shot.png')
    assert.equal(attachments[0].contentType, 'image/png')
    assert.equal(readFileSync(attachments[0].path, 'utf8'), 'PNGDATA', 'the file is on disk under the state dir')
    assert.ok(after.body.answered_via, 'the answer records how it arrived')
  } finally {
    await daemon.close()
  }
})

test('the submit endpoint takes urlencoded and JSON too, and rejects nothing by name', async () => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  try {
    const formAsk = await file(base, pageAsk({ title: 'Form encoded ask' }))
    const encoded = await fetch(`${base}/api/asks/${formAsk.body.ticket}/submit`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'whatever=yes&something+odd=kept&again=one&again=two',
    })
    assert.equal(encoded.status, 200)
    const formAnswered = await json(base, `/api/asks/${formAsk.body.ticket}`)
    assert.equal(formAnswered.body.answers.whatever, 'yes')
    assert.equal(formAnswered.body.answers['something odd'], 'kept', 'a name nobody anticipated is kept')
    assert.deepEqual(formAnswered.body.answers.again, ['one', 'two'], 'a repeated name keeps every value')

    const jsonAsk = await file(base, pageAsk({ title: 'JSON ask' }))
    const sentJson = await fetch(`${base}/api/asks/${jsonAsk.body.ticket}/submit`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict: 'ship', detail: { depth: 2 } }),
    })
    assert.equal(sentJson.status, 200)
    const jsonAnswered = await json(base, `/api/asks/${jsonAsk.body.ticket}`)
    assert.equal(jsonAnswered.body.answers.verdict, 'ship')
    assert.deepEqual(jsonAnswered.body.answers.detail, { depth: 2 }, 'a nested value survives')
  } finally {
    await daemon.close()
  }
})

test('a page ask is rejected without html, or when it carries fields', async () => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  try {
    const noHtml = await file(base, pageAsk({ html: undefined }))
    assert.equal(noHtml.response.status, 400)
    assert.match(JSON.stringify(noHtml.body), /html/)

    const withFields = await file(base, pageAsk({ fields: [{ name: 'x', type: 'text', label: 'X' }] }))
    assert.equal(withFields.response.status, 400)
    assert.match(JSON.stringify(withFields.body), /fields/)
  } finally {
    await daemon.close()
  }
})

test('a scoped link renders the agent page directly, and answers it without the panel', async () => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  try {
    const filed = await file(base, pageAsk({ title: 'Answer me from a link' }))
    const ticket = filed.body.ticket
    const minted = await json(base, '/api/links', {
      method: 'POST',
      body: JSON.stringify({ ticket }),
    })
    assert.equal(minted.response.status, 201, JSON.stringify(minted.body))
    const token = minted.body.token

    // The link opens the agent page itself, not the React panel: the panel is not built
    // in a checkout, and a page ask must not depend on that build to be answerable.
    const opened = await fetch(`${base}/u/${token}`)
    assert.equal(opened.status, 200)
    const openedText = await opened.text()
    assert.match(openedText, /sandbox="allow-forms allow-scripts"/, 'the link serves the page shell')
    assert.doesNotMatch(openedText, /id="root"/, 'and not the panel shell')
    assert.match(openedText, new RegExp(`/u/${token}/api/asks/${ticket}/page\\.html`), 'the iframe stays under the token')

    // A form with no action posts to the page URL, which is under the token too.
    const form = new FormData()
    form.set('decision', 'go with plan B')
    const submitted = await fetch(`${base}/u/${token}/api/asks/${ticket}/page`, { method: 'POST', body: form })
    assert.equal(submitted.status, 200)
    const after = await json(base, `/api/asks/${ticket}`)
    assert.equal(after.body.status, 'answered')
    assert.equal(after.body.answers.decision, 'go with plan B')
    assert.equal(after.body.answered_via, 'share-link:local', 'the answer records the link it came through')
  } finally {
    await daemon.close()
  }
})


test('a sandboxed page posts as Origin: null and is accepted; a foreign origin is not', async () => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  try {
    const filed = await file(base, pageAsk({ title: 'Null origin' }))
    const ticket = filed.body.ticket
    const minted = await json(base, '/api/links', { method: 'POST', body: JSON.stringify({ ticket }) })
    const token = minted.body.token
    const submit = `${base}/u/${token}/api/asks/${ticket}/submit`

    // The guard still refuses a page from somewhere else.
    const foreign = await fetch(submit, {
      method: 'POST',
      headers: { Origin: 'http://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'plan=stolen',
    })
    assert.equal(foreign.status, 403, 'a foreign origin is refused')

    // A CSP-sandboxed document has an opaque origin, so this is the ONLY Origin a real
    // browser can send from the page we serve. Refusing it made every page ask unanswerable
    // while every header-less test passed.
    const form = new FormData()
    form.set('plan', 'null-origin')
    const accepted = await fetch(submit, { method: 'POST', headers: { Origin: 'null' }, body: form })
    assert.equal(accepted.status, 200)
    const after = await json(base, `/api/asks/${ticket}`)
    assert.equal(after.body.status, 'answered')
    assert.equal(after.body.answers.plan, 'null-origin')

    // The permitted surface is pinned as DATA. Widening it has to touch this line, which is the
    // only thing that makes a widening visible in review: a hand-written list of near misses
    // inherits the author's memory, and the person who widens the alternation is precisely the
    // person not thinking about its edge.
    assert.deepEqual([...SANDBOXED_SUBMIT_SUFFIXES], ['page', 'page.html', 'submit'],
      'the sandboxed submit surface is exactly these suffixes; adding one is a security change')

    // The boundary is GENERATED from that same list, so a new suffix brings its own near misses
    // by construction rather than by anyone remembering to write them.
    const boundary = await file(base, pageAsk({ title: 'Boundary' }))
    const boundaryTicket = boundary.body.ticket
    const boundaryToken = (await json(base, '/api/links', {
      method: 'POST', body: JSON.stringify({ ticket: boundaryTicket }),
    })).body.token
    const probe = (suffix) => fetch(`${base}/u/${boundaryToken}/api/asks/${boundaryTicket}/${suffix}`, {
      method: 'POST',
      headers: { Origin: 'null', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'a=1',
    })
    for (const suffix of SANDBOXED_SUBMIT_SUFFIXES) {
      assert.notEqual((await probe(suffix)).status, 403, `null is permitted on ${suffix}`)
      for (const near of [`${suffix}x`, `${suffix}/extra`]) {
        assert.equal((await probe(near)).status, 403, `null is refused one step off ${suffix}: ${near}`)
      }
    }

    // And the allowance is narrow: a null origin anywhere else is still refused.
    const elsewhere = await fetch(`${base}/api/asks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'null', ...auth },
      body: JSON.stringify({ ask: pageAsk({ title: 'Sneaky' }) }),
    })
    assert.equal(elsewhere.status, 403, 'null is only accepted on the page-ask submit paths')
  } finally {
    await daemon.close()
  }
})

