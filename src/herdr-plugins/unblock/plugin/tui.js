#!/usr/bin/env node
import readline from 'node:readline'
import { api, hasSession, login } from './paths.js'
import { activeProfile } from './herdr.js'
import { applyKey, initialValues, missingFor, redactValue, sortAsks } from './queue-model.js'
import { levelOf } from '../src/queue-model.js'
import { APPROVAL_PURPOSES } from '../src/schema.js'

// Consent, spend, message and permission asks refuse every local write with
// 403 HUMAN_ONLY — drafts included — because the TUI carries the same bearer
// an agent does and the daemon cannot tell them apart. Drafts never go out at
// all; editing an approval's verdict or sending one is how a person crosses
// that line here, and it costs a signed-in session.
const isApproval = (ask) => APPROVAL_PURPOSES.includes(ask?.purpose)

const stdin = process.stdin
const stdout = process.stdout
const interactive = Boolean(stdin.isTTY)
const color = !process.env.NO_COLOR && stdout.isTTY

/** ANSI style helpers. Every styled run is closed with reset so lines can be
 * truncated at any point without bleeding attributes into the next line. */
const style = (code) => (color ? `\x1b[${code}m` : '')
const reset = style('0')
const bold = style('1')
const dim = style('2')
const inverse = style('7')
const fg = (n) => style(`38;5;${n}`)

const accent = fg(202) // the gating dot's orange, #ff4d00 territory
const ok = fg(71)
const bad = fg(203)
const faint = fg(240)

/** One visual identity with the web panel: same kinds, same hues. */
const KINDS = {
  key: { glyph: '⚿', label: 'key', color: fg(202) },
  click: { glyph: '➤', label: 'to do', color: fg(202) },
  decision: { glyph: '◆', label: 'decision', color: fg(141) },
  question: { glyph: '?', label: 'question', color: fg(141) },
  consent: { glyph: '✓', label: 'consent', color: fg(39) },
  spend: { glyph: '$', label: 'spend', color: fg(178) },
  message: { glyph: '✉', label: 'message', color: fg(205) },
  permission: { glyph: '⚠', label: 'permission', color: fg(203) },
}
const kindOf = (ask) =>
  KINDS[ask.purpose !== 'blocker' ? ask.purpose : (ask.fields || []).some((f) => f.type === 'secret') ? 'key' : 'click']

let restored = false
function restore() {
  if (restored) return
  restored = true
  if (interactive && stdin.isRaw) stdin.setRawMode(false)
  if (interactive) stdout.write('\x1b[?25h\x1b[?1049l')
}
process.once('exit', restore)
process.once('SIGINT', () => { restore(); process.exit(0) })
process.once('SIGTERM', () => { restore(); process.exit(0) })
process.once('uncaughtException', (error) => {
  restore()
  console.error(error?.stack || error)
  process.exit(1)
})

function age(createdAt) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(createdAt).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86400)}d ago`
}

const oneLine = (value) => String(value || '').replace(/\s+/g, ' ').trim()
function meta(ask) {
  const origin = ask.origin || {}
  const parts = [origin.workspace_name || 'workspace']
  if (origin.pane_id) parts.push(`pane ${origin.pane_id}`)
  parts.push(age(ask.created_at))
  return parts.join(' · ')
}

/**
 * Lines are built as styled segments and flattened with a visible-width
 * budget, so a narrow terminal clips text but never cuts an escape sequence.
 */
const ANSI_RE = /\x1b\[[0-9;]*m/g
const visible = (text) => [...text.replace(ANSI_RE, '')].length
const s = (text, tone = '') => ({ text: String(text), tone })
function flat(segments, width) {
  if (width <= 0) return ''
  const over = segments.reduce((sum, { text }) => sum + visible(text), 0) > width
  const budget = over ? width - 1 : width // leave a column for the ellipsis
  let out = ''
  let used = 0
  for (const { text, tone } of segments) {
    const room = budget - used
    if (room <= 0) break
    const take = [...text].slice(0, room).join('')
    if (take) out += tone ? tone + take + reset : take
    used += visible(take)
  }
  // Clip with an ellipsis instead of cutting a word in half.
  return over ? out + faint + '…' + reset : out
}
/** Word-wrap plain text; each result is short enough for one row.
 * A word longer than the row (a long URL, a continuous identifier) is split
 * across rows instead of being pushed out whole, so nothing is unreadable. */
function wrap(text, width) {
  const limit = Math.max(1, width)
  const lines = []
  let line = ''
  const push = (piece) => {
    // A piece that fits on its own joins the current row when there is room.
    if (line && visible(line) + 1 + visible(piece) <= limit) { line = `${line} ${piece}`; return }
    if (line) lines.push(line)
    line = piece
  }
  for (const word of oneLine(text).split(' ').filter(Boolean)) {
    let rest = word
    while (visible(rest) > limit) {
      if (line) { lines.push(line); line = '' }
      const chars = [...rest]
      lines.push(chars.slice(0, limit).join(''))
      rest = chars.slice(limit).join('')
    }
    if (rest) push(rest)
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

function headerLines(width, queue, scope) {
  const gating = queue.filter((ask) => ask.gating).length
  const right = [
    queue.length ? `${queue.length} waiting` : 'clear',
    gating ? `${gating} gating` : '',
    `profile ${scope}`,
  ].filter(Boolean).join(' · ')
  const left = [s(' ▌', accent), s(' unblock', bold)]
  const leftWidth = 2 + visible(' unblock')
  const gap = Math.max(1, width - leftWidth - visible(right))
  return [
    flat([...left, s(' '.repeat(gap)), s(right, dim)], width),
    flat([s(' ' + '─'.repeat(Math.max(0, width - 1)), faint)], width),
  ]
}

function askLines(ask, { focused, open, width }) {
  const kind = kindOf(ask)
  const level = levelOf(ask)
  const marker = focused ? [s(' ▸', accent)] : [s('  ')]
  const badge = ask.gating ? s(' !', accent) : s('  ')
  const lines = []
  const head = [
    ...marker, badge,
    s(` ${kind.glyph} `, kind.color), s(kind.label, kind.color),
    s(`  ${meta(ask)}`, dim), s(`  ${level}`, faint),
  ]
  lines.push(head)
  const titleTone = focused ? bold + (color ? kind.color : '') : bold
  // An open card is read, not clipped: every prose row wraps to the row width.
  // A folded row stays one line — it is the index, and a 15-line preview would
  // push everything else off the screen; Enter opens the card to read it.
  const indent = '     '
  const wrapped = (text, indentText, tone) => {
    for (const row of wrap(text, Math.max(16, width - visible(indentText)))) {
      lines.push([s(indentText), s(row, tone)])
    }
  }
  const single = (text, indentText, tone) => {
    lines.push([s(indentText), s(oneLine(text), tone)])
  }
  const prose = (text, tone) => (open ? wrapped(text, indent, tone) : single(text, indent, tone))
  prose(ask.title, titleTone)
  // The why is the ask's own statement of the problem; a folded row shows its
  // one-line summary instead when the ask carries both.
  const summary = oneLine(ask.summary)
  const whyText = open ? oneLine(ask.why) || summary : summary || oneLine(ask.why)
  if (whyText) prose(whyText, dim)
  if (!open) {
    const needs = (ask.fields || []).filter((f) => !(f.name in (ask.answers || {})))
    if (needs.length) single(`needs: ${needs.map((f) => f.label || f.name).join(', ')}`, indent, faint)
    lines.push([s('')])
    return lines
  }

  // A step's bullet hangs its continuation rows under the text, not under the
  // bullet, so a wrapped step still reads as one item.
  const stepIndent = '       · '
  const stepRest = '         '
  for (const step of ask.steps || []) {
    wrap(step, Math.max(16, width - visible(stepIndent))).forEach((row, n) => {
      lines.push(n === 0
        ? [s('       '), s('· ', faint), s(row, dim)]
        : [s(stepRest), s(row, dim)])
    })
  }
  for (const link of ask.links || []) {
    // The label is prose and wraps. The URL is a single token: it goes on its
    // own row, hard-split at the row width, so no part of it is ever lost.
    const labelIndent = '       ↗ '
    for (const row of wrap(link.label || link.url, Math.max(16, width - visible(labelIndent)))) {
      lines.push([s('       '), s('↗ ', kind.color), s(row, dim)])
    }
    if (link.label && link.url) {
      // Break after a / ? & = - so a split URL is still recognisable and can be
      // pasted back together; fall back to a hard split when no break lands.
      const urlWidth = Math.max(16, width - visible(stepRest))
      const pieces = []
      let rest = oneLine(link.url)
      while (visible(rest) > urlWidth) {
        const chars = [...rest]
        let at = urlWidth
        for (let i = urlWidth; i > urlWidth / 2; i -= 1) {
          if ('/ ?&=_-'.includes(chars[i - 1])) { at = i; break }
        }
        pieces.push(chars.slice(0, at).join(''))
        rest = chars.slice(at).join('')
      }
      if (rest) pieces.push(rest)
      for (const row of pieces) lines.push([s(stepRest), s(row, faint)])
    }
  }
  const fields = unansweredFields(ask)
  if (fields.length) lines.push([s('')])
  fields.forEach((field, i) => {
    const isFocus = focused && i === fieldIndex
    const state = states.get(`${ask.ticket}:${field.name}`) || { value: undefined }
    const pointer = isFocus ? s('    › ', accent) : s('      ')
    const label = `${field.label || field.name}${field.required ? ' *' : ''}`
    if (field.type === 'choice') {
      const value = state.value
      const picked = (field.choices || []).map((choice, n) => {
        const on = Array.isArray(value) ? value.includes(choice.value) : value === choice.value
        const radio = field.multi ? (on ? '▣' : '□') : (on ? '●' : '○')
        return `${radio} ${n + 1}:${choice.label}`
      }).join('   ')
      // A long question and its choices each wrap; the choices are wrapped as
      // tokens so a row never splits a radio from its label.
      const choiceIndent = '         '
      const labelRows = wrap(label, Math.max(16, width - visible(choiceIndent) - 2))
      lines.push([pointer, s(labelRows[0], isFocus ? bold : '')])
      for (const row of labelRows.slice(1)) lines.push([s(choiceIndent), s(row, isFocus ? bold : '')])
      const choiceWidth = Math.max(16, width - visible(choiceIndent))
      let row = ''
      for (const token of picked.split('   ')) {
        const next = row ? `${row}   ${token}` : token
        if (row && visible(next) > choiceWidth) { lines.push([s(choiceIndent), s(row, dim)]); row = token }
        else row = next
      }
      if (row) lines.push([s(choiceIndent), s(row, dim)])
      if (isFocus) for (const row of wrap('←/→ or number to choose · tab next field', Math.max(16, width - visible(choiceIndent)))) lines.push([s(choiceIndent), s(row, faint)])
    } else if (field.type === 'confirm') {
      const choiceIndent = '         '
      const labelRows = wrap(label, Math.max(16, width - visible(choiceIndent) - 8))
      lines.push([pointer, s(labelRows[0], isFocus ? bold : ''), s(`  ${state.value ? '▣ yes' : '□ no'}`, state.value ? ok : dim)])
      for (const row of labelRows.slice(1)) lines.push([s(choiceIndent), s(row, isFocus ? bold : '')])
      if (isFocus) for (const row of wrap('space to toggle · tab next field', Math.max(16, width - visible(choiceIndent)))) lines.push([s(choiceIndent), s(row, faint)])
    } else {
      const shown = redactValue(field, state.value)
      const choiceIndent = '         '
      const labelRows = wrap(label, Math.max(16, width - visible(choiceIndent) - 2))
      if (shown) {
        // What the human typed is theirs to read back: it wraps too.
        lines.push([pointer, s(labelRows[0], isFocus ? bold : '')])
        for (const row of labelRows.slice(1)) lines.push([s(choiceIndent), s(row, isFocus ? bold : '')])
        for (const row of wrap(shown, Math.max(16, width - visible(choiceIndent)))) {
          lines.push([s(choiceIndent), s(row, isFocus ? inverse : dim)])
        }
      } else {
        lines.push([pointer, s(labelRows[0], isFocus ? bold : ''), s('  type here', faint)])
        for (const row of labelRows.slice(1)) lines.push([s(choiceIndent), s(row, isFocus ? bold : '')])
      }
      if (field.type === 'paste' && field.command) {
        for (const row of wrap(`run: ${field.command}`, Math.max(16, width - visible(choiceIndent)))) {
          lines.push([s(choiceIndent), s(row, dim)])
        }
      }
    }
  })
  lines.push([s('')])
  return lines
}

function keyChip(key, action) {
  return [s(` ${key} `, inverse), s(` ${action}   `, dim)]
}

function footerLines(width) {
  const ask = selectedAsk()
  const missing = ask && expanded === ask.ticket ? missingFor(ask, valuesFor(ask)) : []
  let status = footer
  let tone = footerKind === 'error' ? bad : footerKind === 'ok' ? ok : accent
  if (!status && missing.length) { status = `still needed: ${missing.join(', ')}`; tone = bad }
  const rule = flat([s(' ' + '─'.repeat(Math.max(0, width - 1)), faint)], width)
  // A long status (a URL to copy, an error someone wrote out) wraps instead of
  // being cut: the footer is where the answer lives.
  const line = status
    ? wrap(status, Math.max(16, width - 1)).map((row) => flat([s(' '), s(row, tone)], width))
    : []
  // A hidden passphrase prompt owns every key; the keymap would lie.
  if (passphrasePrompt) return [rule, ...line]
  const keys = expanded === ask?.ticket
    ? [keyChip('tab', 'fields'), keyChip('␣/←/→', 'answer'), keyChip('^⏎', 'submit'), keyChip('↑↓', 'scroll'), keyChip('esc', 'fold'), keyChip('q', 'quit')]
    : [keyChip('j/k', 'move'), keyChip('⏎', 'open'), keyChip('↑↓', 'scroll'), keyChip('r', 'refresh'), keyChip('p', 'scope'), keyChip('l', 'link'), keyChip('q', 'quit')]
  return [rule, ...line, ...chipLines(keys, width)]
}

/** Key chips wrap onto more rows rather than running off the right edge. */
function chipLines(keys, width) {
  const rows = []
  let current = [s(' ')]
  let used = 1
  for (const chip of keys) {
    const room = chip.reduce((sum, seg) => sum + visible(seg.text), 0)
    if (current.length > 1 && used + room > width) {
      rows.push(flat(current, width))
      current = [s(' ')]
      used = 1
    }
    current.push(...chip)
    used += room
  }
  rows.push(flat(current, width))
  return rows
}

function plainListing(data) {
  const queue = sortAsks((data.asks || []).filter((ask) => ask.status === 'open'))
  const width = Math.max(40, stdout.columns || Number(process.env.COLUMNS) || 100)
  const lines = [...headerLines(width, queue, data.profile || '*'), '']
  if (queue.length === 0) {
    lines.push(flat([s('   ✔ ', ok), s('Queue is clear — nothing needs you.', dim)], width), '')
  }
  queue.forEach((ask) => {
    for (const segments of askLines(ask, { focused: false, open: false, width })) {
      lines.push(flat(segments, width))
    }
  })
  return lines.join('\n') + '\n'
}

const activeScope = await activeProfile()
let profile = activeScope || '*'
let data = { asks: [], hidden: 0, profile }
let selected = 0
let expanded = null
let fieldIndex = 0
let states = new Map()
let footer = ''
let footerKind = 'info'
let draftTimer
let isEditing = false
let busy = false
let scroll = 0
/** Set by ↑/↓: hold the window where the human put it until they move on. */
let manualScroll = null
/** While set, keys type a hidden passphrase instead of moving the queue. */
let passphrasePrompt = null

const writeError = (error) => {
  setFooter(hasSession() ? error.message : 'session expired or signed out — press the key again', 'error')
  render()
}

/**
 * Gate an approval action on a human session: either we already have one, or
 * pause here for a hidden passphrase prompt and resume `after` on success.
 * Returns true when the action should proceed now.
 */
function needHuman(after) {
  if (hasSession()) return true
  passphrasePrompt = { buf: '', after }
  setFooter('passphrase:  · enter signs in · esc cancels')
  render()
  return false
}

const asks = () => sortAsks((data.asks || []).filter((ask) => ask.status === 'open'))
const selectedAsk = () => asks()[selected]

function valuesFor(ask) {
  return Object.fromEntries(
    (ask.fields || []).map((field) => [field.name, states.get(`${ask.ticket}:${field.name}`)?.value])
      .filter(([, value]) => value !== undefined),
  )
}

function initialize() {
  for (const ask of asks()) {
    const values = initialValues(ask)
    for (const field of ask.fields || []) {
      const key = `${ask.ticket}:${field.name}`
      if (!states.has(key)) states.set(key, { value: values[field.name] })
    }
  }
}

function setFooter(text, kind = 'info') {
  footer = text
  footerKind = kind
}

async function refresh({ renderAfter = true } = {}) {
  if (isEditing || busy) return
  busy = true
  try {
    data = await api(`/api/asks?profile=${encodeURIComponent(profile)}`)
    selected = Math.min(selected, Math.max(0, asks().length - 1))
    initialize()
    setFooter('')
  } catch (error) {
    setFooter(error.message, 'error')
  } finally {
    busy = false
    if (renderAfter && interactive) render()
  }
}

if (!interactive) {
  data = await api(`/api/asks?profile=${encodeURIComponent(profile)}`)
  data.profile = profile
  stdout.write(plainListing(data))
  process.exit(0)
}

function unansweredFields(ask) {
  return (ask.fields || []).filter((field) => !(field.name in (ask.answers || {})))
}

/** True when the selected card needs more rows than the window can show. */
function bodyOverflows(ask) {
  const width = Math.max(24, stdout.columns || Number(process.env.COLUMNS) || 100)
  const rows = Math.max(10, stdout.rows || Number(process.env.LINES) || 40)
  const chrome = headerLines(width, asks(), profile).length + footerLines(width).length + 1
  const card = askLines(ask, { focused: true, open: expanded === ask.ticket, width }).length
  return card > Math.max(1, rows - chrome)
}

function render() {
  const width = Math.max(24, stdout.columns || Number(process.env.COLUMNS) || 100)
  const rows = Math.max(10, stdout.rows || Number(process.env.LINES) || 40)
  const queue = asks()
  const header = headerLines(width, queue, profile)
  const foot = footerLines(width)
  const budget = Math.max(1, rows - header.length - foot.length - 1)

  const body = []
  let selectedStart = 0
  queue.forEach((ask, index) => {
    if (index === selected) selectedStart = body.length
    for (const segments of askLines(ask, {
      focused: index === selected, open: expanded === ask.ticket, width,
    })) body.push(segments)
  })
  if (queue.length === 0) {
    body.push([s('')])
    body.push([s('     ✔ ', ok), s('Queue is clear — nothing needs you.', dim)])
    body.push([s(''), s('       Agents file here when only you can clear the way.', faint)])
  }

  // Keep the selection inside the window; fold an open card upward when it
  // overflows so its fields stay reachable instead of falling off the screen.
  // A manual scroll wins until the human changes card: the point of ↑/↓ is to
  // read a card that is taller than the window, not to have it snap back.
  if (manualScroll === null) {
    if (selectedStart < scroll) scroll = selectedStart
    const endOfSelected = body.length && queue.length
      ? Math.min(body.length, selectedStart + askLines(selectedAsk() || queue[0], {
          focused: true, open: expanded === (selectedAsk() || queue[0])?.ticket, width,
        }).length)
      : 0
    if (endOfSelected - scroll > budget) scroll = endOfSelected - budget
  }
  const maxScroll = Math.max(0, body.length - budget)
  scroll = manualScroll === null ? scroll : manualScroll
  scroll = Math.max(0, Math.min(scroll, maxScroll))

  const windowLines = body.slice(scroll, scroll + budget).map((segments) => flat(segments, width))
  while (windowLines.length < budget) windowLines.push('')
  const more = body.length > budget
    ? flat([s(` ${scroll > 0 ? '↑' : ' '} ${scroll + budget < body.length ? '↓' : ' '} `, faint)], width)
    : ''
  const screen = [...header, ...windowLines, ...[more, ...foot].filter(Boolean)]
  stdout.write(`\x1b[H\x1b[2J${screen.join('\n')}`)
}

function safeDraft(ask) {
  const secretNames = new Set((ask.fields || []).filter((field) => field.type === 'secret').map((field) => field.name))
  return Object.fromEntries(Object.entries(valuesFor(ask)).filter(([name]) => !secretNames.has(name)))
}

function scheduleDraft(ask, field) {
  if (field.type === 'secret' || isApproval(ask)) return
  clearTimeout(draftTimer)
  draftTimer = setTimeout(async () => {
    try { await api(`/api/asks/${encodeURIComponent(ask.ticket)}/draft`, { values: safeDraft(ask) }) }
    catch (error) { writeError(error) }
  }, 700)
}

async function submit() {
  const ask = selectedAsk()
  if (!ask || expanded !== ask.ticket) return
  if (isApproval(ask) && !needHuman(submit)) return
  const missing = missingFor(ask, valuesFor(ask))
  if (missing.length) { setFooter(`still needed: ${missing.join(', ')}`, 'error'); return render() }
  busy = true
  try {
    const result = await api(`/api/asks/${encodeURIComponent(ask.ticket)}/answer`, { values: valuesFor(ask) })
    setFooter(result.complete && ask.gating ? `waking ${ask.origin?.agent || 'agent'}` : result.complete ? 'answered' : 'saved', 'ok')
    expanded = null
    data.asks = data.asks.filter((item) => item.ticket !== ask.ticket || !result.complete)
  } catch (error) { writeError(error) }
  finally { busy = false; render() }
}

async function mintLink() {
  try {
    const result = await api('/api/links', { ttl_seconds: 3600 })
    setFooter(`${result.url} (expires ${result.expires_at})`, 'ok')
  } catch (error) { setFooter(error.message, 'error') }
  render()
}

function finishEditingSoon() {
  isEditing = true
  clearTimeout(finishEditingSoon.timer)
  finishEditingSoon.timer = setTimeout(() => { isEditing = false }, 700)
}

readline.emitKeypressEvents(stdin)
stdin.setRawMode(true)
stdout.write('\x1b[?1049h\x1b[?25l')
process.on('SIGWINCH', render)
stdin.on('keypress', async (_text, key) => {
  if (busy) return
  if ((key.ctrl && key.name === 'c') || key.name === 'q') { restore(); process.exit(0) }
  if (passphrasePrompt) {
    if (key.name === 'return' || key.name === 'enter') {
      const { buf, after } = passphrasePrompt
      passphrasePrompt = null
      busy = true
      setFooter('signing in…')
      render()
      try {
        await login(buf)
      } catch (error) {
        busy = false
        setFooter(error.message, 'error')
        render()
        return
      }
      busy = false
      await after()
      return
    }
    if (key.name === 'escape') {
      passphrasePrompt = null
      setFooter('cancelled')
      return render()
    }
    if (key.name === 'backspace') passphrasePrompt.buf = passphrasePrompt.buf.slice(0, -1)
    else if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) passphrasePrompt.buf += key.sequence
    setFooter(`passphrase: ${'*'.repeat(passphrasePrompt.buf.length)} · enter signs in · esc cancels`)
    return render()
  }
  if (key.ctrl && (key.name === 'return' || key.name === 'enter')) return void submit()
  if (key.name === 'escape' && expanded) {
    expanded = null
    setFooter('')
    return render()
  }
  const queue = asks()
  const ask = selectedAsk()
  const fields = ask ? unansweredFields(ask) : []

  if (expanded === ask?.ticket && fields.length) {
    if (key.name === 'tab') {
      fieldIndex = (fieldIndex + (key.shift ? -1 : 1) + fields.length) % fields.length
      setFooter('')
      return render()
    }
    const field = fields[fieldIndex]
    const stateKey = `${ask.ticket}:${field.name}`
    const previous = states.get(stateKey) || { value: undefined }
    const next = applyKey(previous, key, field)
    if (next !== previous) {
      const apply = () => {
        states.set(stateKey, next)
        finishEditingSoon()
        scheduleDraft(ask, field)
        setFooter('')
        render()
      }
      // Editing an approval's verdict is an approval act: prove a person.
      if (isApproval(ask) && !needHuman(apply)) return
      apply()
      return
    }
  }

  if (key.name === 'j') { selected = Math.min(queue.length - 1, selected + 1); manualScroll = null }
  else if (key.name === 'k') { selected = Math.max(0, selected - 1); manualScroll = null }
  // Arrows scroll a card that is taller than the window; with nothing to
  // scroll they move the selection, which is what they did before.
  else if (key.name === 'down' || key.name === 'up') {
    const overflow = expanded === ask?.ticket && bodyOverflows(ask)
    if (!overflow) {
      selected = key.name === 'down'
        ? Math.min(queue.length - 1, selected + 1)
        : Math.max(0, selected - 1)
      manualScroll = null
    } else {
      manualScroll = Math.max(0, scroll + (key.name === 'down' ? 1 : -1))
    }
  } else if (key.name === 'pagedown' || key.name === 'pageup') {
    const page = Math.max(1, (stdout.rows || 40) - 6)
    manualScroll = Math.max(0, scroll + (key.name === 'pagedown' ? page : -page))
  } else if (key.name === 'home') manualScroll = 0
  else if (key.name === 'end') manualScroll = Number.MAX_SAFE_INTEGER
  else if (key.name === 'return' || key.name === 'enter') {
    expanded = expanded === ask?.ticket ? null : ask?.ticket
    fieldIndex = 0
    manualScroll = null
  } else if (key.name === 's') return void submit()
  else if (key.name === 'r') return void refresh()
  else if (key.name === 'p') { profile = profile === '*' ? (activeScope || '*') : '*'; return void refresh() }
  else if (key.name === 'l') return void mintLink()
  else return
  setFooter('')
  render()
})

await refresh()
setInterval(() => { if (!isEditing) void refresh() }, 6000).unref()
