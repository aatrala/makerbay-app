import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Empty, Notice, Skeleton, api, explain, when } from '@makerbay/web-kit'

interface Ticket {
  ticketId: string
  subject: string
  category: string
  status: 'open' | 'answered' | 'closed'
  messages: Array<{ from: 'customer' | 'staff'; text: string; at: string }>
  updatedAt: string
}

/**
 * Support & feedback (issue 49). Assistant-first: the MakerBay assistant
 * answers how-to questions instantly from the same knowledge that powers
 * the marketing site; a ticket is the escape hatch with a real thread and
 * an answer in your inbox. Dogfood on purpose - our support runs on the
 * assistant we sell.
 */
export default function Support() {
  const [tickets, setTickets] = useState<Ticket[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [form, setForm] = useState({ category: 'question', subject: '', message: '' })
  const [reply, setReply] = useState('')
  const [showAsk, setShowAsk] = useState(true)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setTickets((await api('GET', '/v1/core/support/tickets')).tickets ?? []) }
    catch (e) { setError(explain(e)); setTickets([]) }
  }, [])
  useEffect(() => { void load() }, [load])

  const run = (fn: () => Promise<void>) =>
    void (async () => {
      setBusy(true); setError(''); setNote('')
      try { await fn(); await load() } catch (e) { setError(explain(e)) } finally { setBusy(false) }
    })()

  const create = (e: FormEvent) => {
    e.preventDefault()
    run(async () => {
      await api('POST', '/v1/core/support/tickets', form)
      setForm({ category: 'question', subject: '', message: '' })
      setNote('Sent. We answer here and by email - usually within a day.')
    })
  }

  const current = (tickets ?? []).find((t) => t.ticketId === open) ?? null

  return (
    <>
      <h1>Support &amp; feedback</h1>
      <p>Stuck, found a problem, or have an idea? We read everything.</p>
      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card">
        <div className="row">
          <h2 className="grow">Quick answers</h2>
          <button className="ghost" onClick={() => setShowAsk(!showAsk)}>{showAsk ? 'Hide' : 'Show'}</button>
        </div>
        <p className="meta">
          The fastest way for how-do-I questions — the assistant knows MakerBay inside out.
          Still stuck? Open a ticket below.
        </p>
        {showAsk && (
          <iframe
            title="Ask MakerBay"
            src="https://chat.makerbay.app/makerbay-hq"
            style={{ width: '100%', height: 420, border: '1px solid var(--line)', borderRadius: 12 }}
          />
        )}
      </div>

      <div className="card">
        <h2>Open a ticket</h2>
        <form onSubmit={create}>
          <div className="row">
            <div>
              <label htmlFor="tk-cat">This is a</label>
              <select id="tk-cat" value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}>
                <option value="problem">Problem</option>
                <option value="question">Question</option>
                <option value="idea">Idea / feedback</option>
              </select>
            </div>
            <div className="grow">
              <label htmlFor="tk-sub">Subject</label>
              <input id="tk-sub" maxLength={140} required value={form.subject}
                placeholder="Bookings page shows the wrong timezone"
                onChange={(e) => setForm({ ...form, subject: e.target.value })} />
            </div>
          </div>
          <label htmlFor="tk-msg">What happened, or what would help?</label>
          <textarea id="tk-msg" rows={4} maxLength={4000} required value={form.message}
            placeholder="The more you tell us, the faster we can fix it."
            onChange={(e) => setForm({ ...form, message: e.target.value })} />
          <div className="mt">
            <button disabled={busy || form.subject.trim().length < 3 || form.message.trim().length < 10}>
              {busy ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <h2>Your tickets</h2>
        {!tickets ? <Skeleton rows={3} /> : tickets.length === 0 ? (
          <Empty title="Nothing yet">Anything you send appears here with our answers.</Empty>
        ) : (
          <>
            {tickets.map((t) => (
              <div key={t.ticketId} className="row" style={{ borderTop: '1px solid var(--line)', padding: '9px 0', cursor: 'pointer' }}
                onClick={() => { setOpen(open === t.ticketId ? null : t.ticketId); setReply('') }}>
                <span className="grow">
                  <strong>{t.subject}</strong>
                  <span className="meta"> · {t.category} · {when(t.updatedAt)}</span>
                </span>
                <span className={`chip ${t.status === 'answered' ? 'ready' : t.status === 'open' ? 'processing' : 'awaiting_upload'}`}>
                  {t.status === 'open' ? 'with us' : t.status}
                </span>
              </div>
            ))}
            {current && (
              <div className="mt" style={{ borderTop: '2px solid var(--line)', paddingTop: 10 }}>
                {current.messages.map((m, i) => (
                  <div key={i} style={{
                    margin: '8px 0', padding: '10px 12px', borderRadius: 10,
                    background: m.from === 'staff' ? 'rgba(194,65,12,.06)' : 'var(--bg, #faf9f7)',
                    border: '1px solid var(--line)',
                  }}>
                    <p className="meta">{m.from === 'staff' ? 'MakerBay' : 'You'} · {when(m.at)}</p>
                    <p style={{ whiteSpace: 'pre-wrap' }}>{m.text}</p>
                  </div>
                ))}
                <div className="row mt">
                  <input className="grow" value={reply} placeholder="Reply…" maxLength={4000}
                    onChange={(e) => setReply(e.target.value)} aria-label="Reply" />
                  <button disabled={busy || reply.trim().length < 2}
                    onClick={() => run(async () => {
                      await api('POST', `/v1/core/support/tickets/${current.ticketId}/reply`, { message: reply })
                      setReply('')
                    })}>
                    Send
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
