import { useEffect, useState } from 'react'
import { api, BASE } from './lib/api'
import type { Ask } from './deck'
import { PlainText } from './ChipText'

/**
 * An agent-authored page ask. The agent's HTML IS the question, so this card is a frame
 * around it: the page owns the form, posts to its own per-ticket submit endpoint, and
 * the daemon records whatever it posted. Nothing here renders fields, because there are
 * none — that is the whole point of the kind.
 */
export function PageAsk({ ask, onFinished }: { ask: Ask; onFinished: () => void }) {
  const [status, setStatus] = useState(ask.status)
  useEffect(() => {
    if (status !== 'open') return
    // Polling only drives this card's banner. The answer itself does not depend on this
    // page being open: the daemon records the submission and wakes the agent.
    const timer = window.setInterval(() => {
      api<Ask>(`/api/asks/${encodeURIComponent(ask.ticket)}`)
        .then((next) => {
          if (next?.status && next.status !== status) setStatus(next.status)
          if (next?.status && next.status !== 'open') onFinished()
        })
        .catch(() => { /* the queue event will tell us instead */ })
    }, 4000)
    return () => window.clearInterval(timer)
  }, [ask.ticket, status, onFinished])

  const answered = status !== 'open'
  const src = `${BASE}/api/asks/${encodeURIComponent(ask.ticket)}/page`
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '.6rem', height: '100%' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: '.75rem', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: '1.05rem' }}><PlainText text={ask.title} /></h2>
        <span style={{ color: '#8b949e', fontSize: '.85rem' }}>
          {ask.ticket}{answered ? ' · answered' : ' · written by the agent that filed it'}
        </span>
      </header>
      {answered && (
        <p style={{ margin: 0, padding: '.5rem .75rem', borderRadius: '.4rem', background: '#12261a', color: '#7ee787' }}>
          Answered — the agent has been woken with your submission. You can close this.
        </p>
      )}
      <iframe
        title={ask.title}
        src={src}
        sandbox="allow-forms allow-scripts"
        referrerPolicy="no-referrer"
        style={{ flex: 1, minHeight: '32rem', width: '100%', border: '1px solid #21262d', borderRadius: '.5rem', background: '#fff' }}
      />
    </section>
  )
}
