// A page ask v2 is authored in a DIRECTORY: the tool creates <state>/pages/<ticket>/ with a
// starter index.html, the agent edits it and drops assets beside it, and the ask stays in
// draft (out of the queue, unanswerable) until the agent says ready. These cases pin the
// four things that make that useful: the directory and template exist and are returned, a
// draft cannot be answered, the page and its RELATIVE assets are served from the ticket
// directory without following a link out of it, and the oEmbed fetch happens daemon-side
// against a provider the table chose — never an address the caller supplied.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const stateDir = mkdtempSync(join(tmpdir(), 'unblock-page-'))
process.env.UNBLOCK_STATE_DIR = stateDir
process.env.UNBLOCK_CONFIG_DIR = join(stateDir, 'config')
process.env.UNBLOCK_SECRET_BACKEND = 'env'

const { startDaemon, loadOrCreateSecret, SANDBOXED_SUBMIT_SUFFIXES, SANDBOXED_OEMBED_SUFFIX, setOembedTransport } =
  await import('../src/daemon.js')
const authSecret = loadOrCreateSecret()
const auth = { Authorization: `Bearer ${authSecret}` }

const pageAsk = (extra = {}) => ({
  kind: 'page', purpose: 'decision', only_you: 'judgment', project: 'checkout',
  title: 'Pick the rollout plan', why: 'Two plans, one call.',
  tried: ['I read both plans and either works technically.'],
  ...extra,
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
  return json(base, '/api/asks', {
    method: 'POST',
    body: JSON.stringify({ ask, origin: { session_id: 's-page', pane_id: 'w5H:pPAGE' } }),
  })
}

/** File a page ask and return its ticket plus the authoring path the tool handed back. */
async function filedPage(base, ask = pageAsk()) {
  const filed = await file(base, ask)
  assert.equal(filed.response.status, 201, JSON.stringify(filed.body))
  const { ticket, page } = filed.body
  assert.ok(page?.file, 'filing a page ask returns the file to edit')
  return { ticket, page, body: filed.body }
}

test('filing a page ask creates the directory, a starter page, and a DRAFT', async () => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  try {
    const { ticket, page, body } = await filedPage(base)

    assert.equal(body.kind, 'page')
    assert.deepEqual(body.fields, [], 'a page ask carries no fields')
    assert.equal(body.status, 'draft', 'it is filed as a draft, not as a live ask')
    assert.equal(page.dir, join(stateDir, 'pages', ticket), 'the ticket IS the directory name')
    assert.equal(page.file, join(page.dir, 'index.html'))
    assert.equal(page.ready, false)
    assert.ok(existsSync(page.file), 'the starter page exists on disk')

    const template = readFileSync(page.file, 'utf8')
    assert.match(template, /action="submit"/, 'the form already posts to this ticket')
    assert.match(template, /enctype="multipart\/form-data"/)
    assert.match(template, /method="post"/)
    assert.match(template, /PAGE ASK CONTRACT/, 'the contract is in the file the agent edits')
    assert.match(template, /oembed\?url=/, 'the page carries an oEmbed client')
    // A video cannot play inside this sandbox (docs/embeds.md), so the client must keep the
    // poster-card fallback: losing it would silently ship a black rectangle.
    assert.match(template, /a\.card/, 'the client renders a poster card for a video embed')
    assert.match(template, /thumbnailUrl/, 'using the provider thumbnail')
    assert.doesNotMatch(template, /<script src=|cdn\./, 'and no CDN: the page renders offline')

    // A draft is not in the queue: the operator must not see a half-written page.
    const queue = await json(base, '/api/asks?project=checkout')
    assert.equal(queue.body.asks.some((ask) => ask.ticket === ticket), false, 'a draft is not in the queue')

    const drafts = await json(base, `/api/asks?status=draft&project=checkout`)
    assert.equal(drafts.body.asks.some((ask) => ask.ticket === ticket), true, 'but it is visible as a draft')
  } finally {
    await daemon.close()
  }
})

test('a draft is unanswerable; ready puts it in the queue and then its submission is the answer', async () => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  try {
    const { ticket } = await filedPage(base, pageAsk({ title: 'Ready transition' }))

    const early = new FormData()
    early.set('plan', 'too-soon')
    const refused = await fetch(`${base}/api/asks/${ticket}/submit`, { method: 'POST', body: early, headers: auth })
    assert.equal(refused.status, 409, 'an unfinished page cannot be answered')

    const marked = await json(base, `/api/asks/${ticket}/update`, { method: 'POST', body: JSON.stringify({ ready: true }) })
    assert.equal(marked.response.status, 200, JSON.stringify(marked.body))
    assert.equal(marked.body.ask.status, 'open', 'ready is the draft -> open transition')

    const queue = await json(base, '/api/asks?project=checkout')
    assert.equal(queue.body.asks.some((ask) => ask.ticket === ticket), true, 'now it is in the queue')

    // Idempotent: a second ready is a no-op, not an error.
    const again = await json(base, `/api/asks/${ticket}/update`, { method: 'POST', body: JSON.stringify({ ready: true }) })
    assert.equal(again.response.status, 200)
    assert.equal(again.body.ask.status, 'open')

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
    const attachment = after.body.answers._attachments[0]
    assert.equal(attachment.field, 'shot', 'the attachment is recorded')
    assert.equal(attachment.filename, 'shot.png')
    assert.equal(attachment.contentType, 'image/png')
    assert.equal(readFileSync(attachment.path, 'utf8'), 'PNGDATA', 'the file is on disk under the state dir')
  } finally {
    await daemon.close()
  }
})

test('the page and its relative assets come from the ticket directory, and nothing above it', async () => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  try {
    const { ticket, page } = await filedPage(base, pageAsk({ title: 'Assets' }))

    const authored = '<!doctype html><html><body><h1>Mine</h1>'
      + '<img src="chart.png"><form method="post" action="submit"><input name="x"><button>Send</button></form></body></html>'
    writeFileSync(page.file, authored)
    writeFileSync(join(page.dir, 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(join(page.dir, 'style.css'), 'body{color:#fff}')

    const html = await fetch(`${base}/api/asks/${ticket}/page.html`, { headers: auth })
    assert.equal(await html.text(), authored, 'the edited file is what is served, byte for byte')
    assert.equal(html.headers.get('content-security-policy'), 'sandbox allow-forms allow-scripts')

    // Relative to .../<ticket>/page, so the page's own src="chart.png" lands here.
    const png = await fetch(`${base}/api/asks/${ticket}/chart.png`, { headers: auth })
    assert.equal(png.status, 200)
    assert.equal(png.headers.get('content-type'), 'image/png')
    assert.deepEqual([...new Uint8Array(await png.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47])

    const css = await fetch(`${base}/api/asks/${ticket}/style.css`, { headers: auth })
    assert.equal(css.status, 200)
    assert.equal(await css.text(), 'body{color:#fff}')

    // A linked document is a document: it keeps the sandbox, or it would run on the daemon's origin.
    writeFileSync(join(page.dir, 'about.html'), '<p>about</p>')
    const about = await fetch(`${base}/api/asks/${ticket}/about.html`, { headers: auth })
    assert.equal(about.status, 200)
    assert.equal(about.headers.get('content-security-policy'), 'sandbox allow-forms allow-scripts')

    // Only known asset extensions are served: this is also why the fallback cannot swallow a route.
    const noExtension = await fetch(`${base}/api/asks/${ticket}/notes`, { headers: auth })
    assert.equal(noExtension.status, 404)

    // The page is agent-authored and may link upward; the daemon must refuse to follow.
    writeFileSync(join(stateDir, 'outside.txt'), 'secret')
    const upOne = await fetch(`${base}/api/asks/${ticket}/%2e%2e%2foutside.txt`, { headers: auth })
    assert.equal(upOne.status, 404, 'a traversal out of the ticket directory is refused')
    assert.doesNotMatch(await upOne.text(), /secret/, 'and nothing leaks in the body')

    const missing = await fetch(`${base}/api/asks/${ticket}/nope.png`, { headers: auth })
    assert.equal(missing.status, 404)
  } finally {
    await daemon.close()
  }
})

test('a page ask no longer accepts inline html', async () => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  try {
    const inline = await file(base, pageAsk({ title: 'Inline html', html: '<p>old design</p>' }))
    assert.equal(inline.response.status, 400)
    assert.equal(inline.body.path, 'html', 'the removed argument is named in the refusal')

    const withFields = await file(base, pageAsk({ title: 'Fields', fields: [{ name: 'plan', label: 'Plan', type: 'choice', options: [{ value: 'a', label: 'A' }] }] }))
    assert.equal(withFields.response.status, 400)
    assert.equal(withFields.body.path, 'fields', 'a page ask still carries no fields')
  } finally {
    await daemon.close()
  }
})

test('the submit endpoint takes urlencoded and JSON too, and rejects nothing by name', async () => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  try {
    const first = await filedPage(base, pageAsk({ title: 'Urlencoded' }))
    await json(base, `/api/asks/${first.ticket}/update`, { method: 'POST', body: JSON.stringify({ ready: true }) })
    const form = await fetch(`${base}/api/asks/${first.ticket}/submit`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'whatever=yes&something+odd=kept&again=one&again=two',
    })
    assert.equal(form.status, 200)
    const formAnswers = (await json(base, `/api/asks/${first.ticket}`)).body.answers
    assert.equal(formAnswers.whatever, 'yes')
    assert.equal(formAnswers['something odd'], 'kept', 'a name nobody anticipated is kept')
    assert.deepEqual(formAnswers.again, ['one', 'two'], 'a repeated name keeps every value')

    const second = await filedPage(base, pageAsk({ title: 'Json' }))
    await json(base, `/api/asks/${second.ticket}/update`, { method: 'POST', body: JSON.stringify({ ready: true }) })
    const asJson = await fetch(`${base}/api/asks/${second.ticket}/submit`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict: 'ship', detail: { depth: 2 } }),
    })
    assert.equal(asJson.status, 200)
    const jsonAnswers = (await json(base, `/api/asks/${second.ticket}`)).body.answers
    assert.equal(jsonAnswers.verdict, 'ship')
    assert.deepEqual(jsonAnswers.detail, { depth: 2 }, 'a nested value survives')
  } finally {
    await daemon.close()
  }
})

test('a scoped link renders the page directly and answers it without the panel', async () => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  try {
    const { ticket, page } = await filedPage(base, pageAsk({ title: 'Scoped link' }))
    writeFileSync(join(page.dir, 'chart.png'), Buffer.from([1, 2, 3]))
    await json(base, `/api/asks/${ticket}/update`, { method: 'POST', body: JSON.stringify({ ready: true }) })

    const minted = await json(base, '/api/links', { method: 'POST', body: JSON.stringify({ ticket }) })
    assert.equal(minted.response.status, 201, JSON.stringify(minted.body))
    const token = minted.body.token

    const shell = await fetch(`${base}/u/${token}`)
    assert.equal(shell.status, 200)
    const shellText = await shell.text()
    assert.match(shellText, new RegExp(`/u/${token}/api/asks/${ticket}/page\\.html`), 'the iframe is the ticket page')
    assert.match(shellText, /sandbox="allow-forms allow-scripts"/)
    assert.doesNotMatch(shellText, /allow-same-origin/)

    const raw = await fetch(`${base}/u/${token}/api/asks/${ticket}/page.html`)
    assert.equal(raw.status, 200)
    assert.equal(raw.headers.get('content-security-policy'), 'sandbox allow-forms allow-scripts')

    // Relative assets resolve under the same token-scoped ticket path.
    const asset = await fetch(`${base}/u/${token}/api/asks/${ticket}/chart.png`)
    assert.equal(asset.status, 200)
    assert.equal(asset.headers.get('content-type'), 'image/png')

    const form = new FormData()
    form.set('plan', 'from-the-link')
    const answered = await fetch(`${base}/u/${token}/api/asks/${ticket}/submit`, { method: 'POST', body: form })
    assert.equal(answered.status, 200)
    const after = await json(base, `/api/asks/${ticket}`)
    assert.equal(after.body.answers.plan, 'from-the-link')
    assert.equal(after.body.answered_via, 'share-link:local', 'the answer records the link it came through')
    // A form with NO action posts to the page URL itself, which is under the token too.
    const other = await filedPage(base, pageAsk({ title: 'No action' }))
    await json(base, `/api/asks/${other.ticket}/update`, { method: 'POST', body: JSON.stringify({ ready: true }) })
    const otherToken = (await json(base, '/api/links', { method: 'POST', body: JSON.stringify({ ticket: other.ticket }) })).body.token
    const noAction = new FormData()
    noAction.set('decision', 'go with plan B')
    const posted = await fetch(`${base}/u/${otherToken}/api/asks/${other.ticket}/page`, { method: 'POST', body: noAction })
    assert.equal(posted.status, 200, 'a form with no action posts to the page URL')
    assert.equal((await json(base, `/api/asks/${other.ticket}`)).body.answers.decision, 'go with plan B')
  } finally {
    await daemon.close()
  }
})

test('a sandboxed page posts as Origin: null and is accepted; a foreign origin is not', async () => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  try {
    const { ticket } = await filedPage(base, pageAsk({ title: 'Null origin' }))
    await json(base, `/api/asks/${ticket}/update`, { method: 'POST', body: JSON.stringify({ ready: true }) })
    const minted = await json(base, '/api/links', { method: 'POST', body: JSON.stringify({ ticket }) })
    const submit = `${base}/u/${minted.body.token}/api/asks/${ticket}/submit`

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
    assert.equal(SANDBOXED_OEMBED_SUFFIX, 'oembed',
      'the sandboxed read surface is the oEmbed endpoint alone; it is a separate capability from submit')

    // The boundary is GENERATED from that same list, so a new suffix brings its own near misses
    // by construction rather than by anyone remembering to write them.
    const boundary = await filedPage(base, pageAsk({ title: 'Boundary' }))
    const boundaryToken = (await json(base, '/api/links', {
      method: 'POST', body: JSON.stringify({ ticket: boundary.ticket }),
    })).body.token
    const probe = (suffix) => fetch(`${base}/u/${boundaryToken}/api/asks/${boundary.ticket}/${suffix}`, {
      method: 'POST',
      headers: { Origin: 'null', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'a=1',
    })
    for (const suffix of SANDBOXED_SUBMIT_SUFFIXES) {
      assert.notEqual((await probe(suffix)).status, 403, `null is permitted on ${suffix}`)
      // One step off is a different path, and the allowance is generated from the same list
      // it is pinned by, so a new suffix arrives with its own near misses.
      for (const near of [`${suffix}x`, `${suffix}/extra`]) {
        assert.equal((await probe(near)).status, 403, `null is refused one step off ${suffix}: ${near}`)
      }
    }

    // And the read surface is only a GET on the oEmbed endpoint: the same origin on the page
    // itself is still refused, so the allowance did not spread to the document.
    const pageOrigin = await fetch(`${base}/u/${boundaryToken}/api/asks/${boundary.ticket}/page.html`, {
      headers: { Origin: 'http://evil.example' },
    })
    assert.equal(pageOrigin.status, 403, 'a foreign origin still cannot read the page')
  } finally {
    await daemon.close()
  }
})

test('oEmbed resolves a provider link server-side, strips scripts, and leaves other links alone', async () => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  const calls = []
  setOembedTransport(async (url) => {
    calls.push(url)
    return new Response(JSON.stringify({
      html: '<iframe src="https://www.youtube.com/embed/abc" title="v"></iframe><script>alert(1)</script>',
      title: 'A video', provider_name: 'YouTube', type: 'video',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  try {
    const { ticket } = await filedPage(base, pageAsk({ title: 'Embeds' }))
    const video = encodeURIComponent('https://www.youtube.com/watch?v=abc')

    const embedded = await json(base, `/api/asks/${ticket}/oembed?url=${video}`)
    assert.equal(embedded.response.status, 200, JSON.stringify(embedded.body))
    assert.equal(embedded.body.provider, 'youtube')
    assert.match(embedded.body.html, /youtube\.com\/embed\/abc/, 'the provider embed comes back')
    assert.doesNotMatch(embedded.body.html, /<script/i, 'provider scripts are stripped before they reach the page')
    assert.equal(calls.length, 1)
    assert.ok(calls[0].startsWith('https://www.youtube.com/oembed?'), `the fetch went to the provider endpoint: ${calls[0]}`)
    assert.ok(calls[0].includes('format=json'))

    // The page's own call is relative, and it is a GET from an opaque origin.
    const nullOrigin = await fetch(`${base}/api/asks/${ticket}/oembed?url=${video}`, { headers: { Origin: 'null' } })
    assert.equal(nullOrigin.status, 200, 'the sandboxed page may fetch the embed')
    const foreign = await fetch(`${base}/api/asks/${ticket}/oembed?url=${video}`, { headers: { Origin: 'http://evil.example' } })
    assert.equal(foreign.status, 403, 'a foreign origin cannot use the daemon as its CORS proxy')

    // Unsupported providers cost nothing and leave the link a link.
    const before = calls.length
    const unsupported = await json(base, `/api/asks/${ticket}/oembed?url=${encodeURIComponent('https://example.com/post')}`)
    assert.equal(unsupported.response.status, 404)
    assert.equal(unsupported.body.error, 'unsupported')
    assert.equal(calls.length, before, 'an unsupported host is never fetched')

    const missing = await json(base, `/api/asks/${ticket}/oembed`)
    assert.equal(missing.response.status, 400)
  } finally {
    setOembedTransport(null)
    await daemon.close()
  }
})

test('oEmbed never fetches an address the provider table did not choose', async () => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  const calls = []
  setOembedTransport(async (url) => {
    calls.push(url)
    return new Response('{"html":"<iframe></iframe>"}', { status: 200 })
  })
  try {
    const { ticket } = await filedPage(base, pageAsk({ title: 'SSRF' }))

    // A URL whose address is the attacker's, wearing a provider name as a prefix/suffix.
    for (const hostile of [
      'https://www.youtube.com.evil.example/watch?v=abc',
      'https://evil.example/?u=https://www.youtube.com/watch?v=abc',
      'http://127.0.0.1:6379/',
      'file:///etc/passwd',
    ]) {
      const response = await json(base, `/api/asks/${ticket}/oembed?url=${encodeURIComponent(hostile)}`)
      assert.equal(response.response.status, 404, `${hostile} is not a provider URL`)
    }
    assert.deepEqual(calls, [], 'the transport was never asked to fetch a caller-supplied address')
  } finally {
    setOembedTransport(null)
    await daemon.close()
  }
})

test('a provider that refuses is a 502, not an unsupported 404', async () => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  setOembedTransport(async () => {
    throw new Error('network down')
  })
  try {
    const { ticket } = await filedPage(base, pageAsk({ title: 'Provider down' }))
    const failed = await json(base, `/api/asks/${ticket}/oembed?url=${encodeURIComponent('https://vimeo.com/12345')}`)
    assert.equal(failed.response.status, 502)
    assert.equal(failed.body.error, 'failed')
    assert.equal(failed.body.provider, 'vimeo')
  } finally {
    setOembedTransport(null)
    await daemon.close()
  }
})