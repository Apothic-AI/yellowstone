/**
 * Submission parsing for agent-authored page asks.
 *
 * A page ask's HTML is written by an agent and posted back by a human's browser, so
 * the endpoint must accept whatever the agent wrote: arbitrary field names, repeated
 * names, files, or a JSON body from a scripted client. Nothing here validates the
 * submission's SEMANTICS -- the page owns that. What this module does enforce is
 * shape and size: a bounded number of parts, bounded field sizes, and per-file and
 * total byte caps, because the body is streamed rather than buffered and an unbounded
 * stream is a denial of service wearing a form submission.
 *
 * The body is never fully buffered: a file part is written to disk as its bytes
 * arrive, keeping only a sliding tail long enough to contain a boundary delimiter.
 */
import { createWriteStream } from 'node:fs'
import { mkdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'

export const SUBMIT_LIMITS = {
  maxFieldBytes: 1024 * 1024,      // one field value
  maxFields: 200,
  maxFileBytes: 10 * 1024 * 1024,  // one attachment
  maxFiles: 20,
  maxTotalBytes: 50 * 1024 * 1024, // the whole submission
  maxJsonBytes: 2 * 1024 * 1024,   // JSON and urlencoded are not file carriers
}

function fail(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

/** A filename from a browser may carry a path (or a Windows path). Keep the last segment. */
export function safeFilename(name, fallback = 'attachment') {
  const raw = String(name ?? '')
  const last = basename(raw.replace(/\\/g, '/')).replace(/[\\/]/g, '')
  const cleaned = last.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 120)
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback
}

function boundaryOf(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '')
  return match ? (match[1] || match[2] || '').trim() : ''
}

/** Parse one part's header block into { name, filename, contentType }. */
function partHeaders(block) {
  const text = block.toString('utf8')
  const disposition = /content-disposition:([^\r\n]*)/i.exec(text)?.[1] || ''
  const type = /content-type:([^\r\n]*)/i.exec(text)?.[1]
  const name = /name=(?:"([^"]*)"|([^;\s]+))/i.exec(disposition)
  const filename = /filename\*?=(?:"([^"]*)"|([^;\s]+))/i.exec(disposition)
  return {
    name: (name?.[1] ?? name?.[2] ?? '').trim(),
    filename: (filename?.[1] ?? filename?.[2] ?? '').trim(),
    contentType: (type || 'application/octet-stream').trim(),
  }
}

function addField(fields, name, value) {
  const key = name || 'unnamed'
  if (!(key in fields)) fields[key] = value
  else if (Array.isArray(fields[key])) fields[key].push(value)
  else fields[key] = [fields[key], value]
}

/**
 * Stream a multipart body. Files go to `attachmentsDir`; fields accumulate in memory
 * under the caps above. Resolves { fields, files, bytes }.
 */
export async function parseMultipart(stream, { contentType, attachmentsDir, limits = {} }) {
  const caps = { ...SUBMIT_LIMITS, ...limits }
  const boundary = boundaryOf(contentType)
  if (!boundary) throw fail(400, 'NO_BOUNDARY', 'multipart body without a boundary')
  mkdirSync(attachmentsDir, { recursive: true, mode: 0o700 })

  const dash = Buffer.from(`--${boundary}`)
  const crlfDash = Buffer.from(`\r\n--${boundary}`)
  const keepTail = crlfDash.length + 8

  const fields = {}
  const files = []
  let fieldCount = 0
  let bytes = 0
  let buf = Buffer.alloc(0)
  let state = 'preamble'
  let part = null
  let sink = null      // write stream for a file part
  let fileSize = 0
  let fieldChunks = []
  let fieldSize = 0
  let ended = false

  const closePart = async () => {
    if (!part) return
    if (part.filename !== '') {
      if (sink) await new Promise((resolve, reject) => sink.end((err) => (err ? reject(err) : resolve())))
      sink = null
      files.push({ field: part.name, filename: part.filename, path: part.path, size: fileSize, contentType: part.contentType })
    } else {
      addField(fields, part.name, Buffer.concat(fieldChunks).toString('utf8'))
      fieldChunks = []
      fieldSize = 0
    }
    part = null
    fileSize = 0
  }

  const writeBody = async (chunk) => {
    if (!part || chunk.length === 0) return
    if (part.filename !== '') {
      fileSize += chunk.length
      if (fileSize > caps.maxFileBytes) throw fail(413, 'FILE_TOO_LARGE', `${part.filename} is larger than ${caps.maxFileBytes} bytes`)
      if (!sink) sink = createWriteStream(part.path)
      if (!sink.write(chunk)) await new Promise((resolve) => sink.once('drain', resolve))
    } else {
      fieldSize += chunk.length
      if (fieldSize > caps.maxFieldBytes) throw fail(413, 'FIELD_TOO_LARGE', `field ${part.name} is larger than ${caps.maxFieldBytes} bytes`)
      fieldChunks.push(chunk)
    }
  }

  const pump = async (final) => {
    for (;;) {
      if (state === 'preamble') {
        const at = buf.indexOf(dash)
        if (at < 0) { if (!final) { buf = buf.slice(Math.max(0, buf.length - keepTail)) } return }
        buf = buf.slice(at + dash.length)
        state = 'afterBoundary'
        continue
      }
      if (state === 'afterBoundary') {
        if (buf.length < 2) return
        if (buf[0] === 0x2d && buf[1] === 0x2d) { ended = true; return }
        if (buf[0] !== 0x0d || buf[1] !== 0x0a) throw fail(400, 'BAD_BOUNDARY', 'malformed multipart boundary')
        buf = buf.slice(2)
        state = 'headers'
        continue
      }
      if (state === 'headers') {
        const at = buf.indexOf('\r\n\r\n')
        if (at < 0) return
        const headers = partHeaders(buf.slice(0, at))
        buf = buf.slice(at + 4)
        fieldCount += 1
        if (fieldCount > caps.maxFields) throw fail(413, 'TOO_MANY_FIELDS', `more than ${caps.maxFields} parts`)
        if (headers.filename !== '') {
          if (files.length >= caps.maxFiles) throw fail(413, 'TOO_MANY_FILES', `more than ${caps.maxFiles} attachments`)
          const name = `${String(files.length + 1).padStart(2, '0')}-${safeFilename(headers.filename)}`
          part = { ...headers, filename: safeFilename(headers.filename), path: join(attachmentsDir, name) }
        } else {
          part = { ...headers }
        }
        state = 'body'
        continue
      }
      // state === 'body'
      const at = buf.indexOf(crlfDash)
      if (at < 0) {
        const flushable = final ? buf.length : Math.max(0, buf.length - keepTail)
        if (flushable > 0) { await writeBody(buf.slice(0, flushable)); buf = buf.slice(flushable) }
        if (final) throw fail(400, 'TRUNCATED', 'multipart body ended before its closing boundary')
        return
      }
      await writeBody(buf.slice(0, at))
      await closePart()
      buf = buf.slice(at + 2 + dash.length)
      state = 'afterBoundary'
    }
  }

  try {
    for await (const chunk of stream) {
      bytes += chunk.length
      if (bytes > caps.maxTotalBytes) throw fail(413, 'TOO_LARGE', `submission is larger than ${caps.maxTotalBytes} bytes`)
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
      await pump(false)
      if (ended) break
    }
    await pump(true)
    if (!ended) throw fail(400, 'TRUNCATED', 'multipart body ended before its closing boundary')
    return { fields, files, bytes }
  } catch (error) {
    if (sink) sink.destroy()
    for (const file of files) { try { rmSync(file.path, { force: true }) } catch { /* already gone */ } }
    throw error
  }
}

/** Read a whole non-file body under a cap (JSON and urlencoded are not file carriers). */
export async function readSmallBody(stream, { limit }) {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > limit) throw fail(413, 'TOO_LARGE', `body is larger than ${limit} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Parse any submission body. Returns { fields, files }. Field values are STRINGS for
 * multipart and urlencoded, and whatever JSON carried for a JSON body.
 */
export async function parseSubmission(stream, { contentType = '', attachmentsDir, limits = {} }) {
  const caps = { ...SUBMIT_LIMITS, ...limits }
  const type = String(contentType).toLowerCase()
  if (type.startsWith('multipart/form-data')) {
    return parseMultipart(stream, { contentType, attachmentsDir, limits })
  }
  if (type.startsWith('application/x-www-form-urlencoded')) {
    const body = await readSmallBody(stream, { limit: caps.maxJsonBytes })
    const fields = {}
    for (const [name, value] of new URLSearchParams(body.toString('utf8'))) addField(fields, name, value)
    return { fields, files: [], bytes: body.length }
  }
  // JSON is the fallback deliberately: a scripted client that sends no content type at
  // all should still land, because the requirement is a forgiving endpoint.
  const body = await readSmallBody(stream, { limit: caps.maxJsonBytes })
  const text = body.toString('utf8').trim()
  if (!text) return { fields: {}, files: [], bytes: 0 }
  let parsed
  try { parsed = JSON.parse(text) } catch { throw fail(400, 'BAD_JSON', 'body is neither form data nor JSON') }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { fields: { value: parsed }, files: [], bytes: body.length }
  }
  return { fields: parsed, files: [], bytes: body.length }
}
