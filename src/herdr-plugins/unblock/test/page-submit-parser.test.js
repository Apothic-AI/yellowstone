// The page-submit parser is the part most likely to be subtly wrong: it streams, so a
// boundary that straddles two chunks (or three) has to be found without ever seeing the
// whole body. These cases chunk the SAME body at different sizes and assert the same
// result, which is the only way to show the parser is not accidentally reading memory
// buffers that happen to align.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { parseSubmission, safeFilename } from '../src/page-submit.js'

const BOUNDARY = '----unblockPageBoundary42'
const CT = `multipart/form-data; boundary=${BOUNDARY}`

function multipart(parts) {
  const chunks = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n`))
    const disposition = part.filename !== undefined
      ? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.type || 'application/octet-stream'}\r\n`
      : `Content-Disposition: form-data; name="${part.name}"\r\n`
    chunks.push(Buffer.from(disposition + '\r\n'))
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(String(part.value)))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`))
  return Buffer.concat(chunks)
}

function chunked(body, size) {
  const out = []
  for (let at = 0; at < body.length; at += size) out.push(body.subarray(at, Math.min(at + size, body.length)))
  return Readable.from(out)
}

const dir = () => mkdtempSync(join(tmpdir(), 'page-submit-'))

test('a multipart submission survives any chunk size, with repeated names and files', async () => {
  const body = multipart([
    { name: 'headline', value: 'Ship it' },
    { name: 'tag', value: 'alpha' },
    { name: 'tag', value: 'beta' },
    { name: 'notes', value: 'line one\r\nline two' },
    { name: 'screenshot', filename: 'shot.png', type: 'image/png', value: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
    { name: 'log', filename: '../../etc/passwd', type: 'text/plain', value: Buffer.from('traversal attempt') },
  ])
  for (const size of [1, 7, 64, 100000]) {
    const attachments = dir()
    const got = await parseSubmission(chunked(body, size), { contentType: CT, attachmentsDir: attachments })
    assert.equal(got.fields.headline, 'Ship it')
    assert.deepEqual(got.fields.tag, ['alpha', 'beta'], 'a repeated field keeps every value')
    assert.equal(got.fields.notes, 'line one\r\nline two')
    assert.equal(got.files.length, 2)
    const shot = got.files.find((f) => f.field === 'screenshot')
    assert.equal(shot.size, 7)
    assert.equal(shot.contentType, 'image/png')
    assert.deepEqual([...readFileSync(shot.path)], [0x89, 0x50, 0x4e, 0x47, 1, 2, 3], 'file bytes land on disk')
    const log = got.files.find((f) => f.field === 'log')
    assert.equal(log.filename, 'passwd', 'a path in the filename is stripped')
    assert.equal(readFileSync(log.path, 'utf8'), 'traversal attempt')
    assert.equal(readdirSync(attachments).length, 2, 'nothing extra is written')
  }
})

test('urlencoded and JSON bodies are accepted, and a bare JSON value is kept', async () => {
  const form = await parseSubmission(Readable.from([Buffer.from('a=1&b=two&b=three&odd%20name=yes')]), {
    contentType: 'application/x-www-form-urlencoded',
  })
  assert.equal(form.fields.a, '1')
  assert.deepEqual(form.fields.b, ['two', 'three'])
  assert.equal(form.fields['odd name'], 'yes')

  const json = await parseSubmission(Readable.from([Buffer.from(JSON.stringify({ answer: { nested: true }, list: [1, 2] }))]), {
    contentType: 'application/json',
  })
  assert.deepEqual(json.fields.answer, { nested: true })
  assert.deepEqual(json.fields.list, [1, 2])

  const bare = await parseSubmission(Readable.from([Buffer.from('42')]), { contentType: 'application/json' })
  assert.equal(bare.fields.value, 42, 'a non-object JSON body is still carried')
})

test('the caps refuse rather than silently truncate', async () => {
  const big = multipart([{ name: 'tooBig', filename: 'big.bin', value: Buffer.alloc(64) }])
  await assert.rejects(
    () => parseSubmission(chunked(big, 16), { contentType: CT, attachmentsDir: dir(), limits: { maxFileBytes: 32 } }),
    (error) => error.status === 413 && error.code === 'FILE_TOO_LARGE',
  )
  const many = multipart([{ name: 'a', value: '1' }, { name: 'b', value: '2' }, { name: 'c', value: '3' }])
  await assert.rejects(
    () => parseSubmission(chunked(many, 8), { contentType: CT, attachmentsDir: dir(), limits: { maxFields: 2 } }),
    (error) => error.code === 'TOO_MANY_FIELDS',
  )
  const truncated = multipart([{ name: 'a', value: '1' }]).subarray(0, 40)
  await assert.rejects(
    () => parseSubmission(Readable.from([truncated]), { contentType: CT, attachmentsDir: dir() }),
    (error) => error.status === 400,
  )
})

test('safeFilename keeps a usable name and never escapes the directory', () => {
  assert.equal(safeFilename('screenshot 2026 (1).png'), 'screenshot_2026_1_.png', 'each run of disallowed characters collapses to one underscore')
  assert.equal(safeFilename('/etc/passwd'), 'passwd')
  assert.equal(safeFilename('..'), 'attachment')
  assert.equal(safeFilename(''), 'attachment')
})
