import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Route } from 'react-router-dom'
import { api, explain, Notice, type DashboardModule, type Me } from '@makerbay/web-kit'

interface Msg { role: 'user' | 'assistant'; text: string }
interface Pending { actionId: string; summary: string }

/**
 * Genie: the owner's conversational view of the whole business. Chips are
 * pre-baked questions with zero prompt ambiguity; the first slot is
 * context-aware (morning briefing before noon, tomorrow's bookings in the
 * evening) and the rest are drawn from the modules this workspace actually
 * runs - a chip for a module you don't use is noise.
 */
const firstChip = () => {
  const h = new Date().getHours()
  if (h < 12) return { label: 'Morning briefing', q: 'Give me my morning briefing.' }
  if (h >= 17) return { label: "Tomorrow's bookings", q: 'What is booked for tomorrow?' }
  return { label: 'What happened today', q: 'What happened today?' }
}

const moduleChips = (me: Me | undefined) => {
  const mods = me?.entitlements?.modules ?? {}
  const on = (id: string) => mods[id]?.enabled !== false && mods[id] !== undefined
  const out: Array<{ label: string; q: string }> = []
  if (on('booking')) out.push({ label: "Today's bookings", q: 'What is in the diary today and tomorrow?' })
  if (on('requests') || on('reviews')) {
    out.push({ label: 'Waiting on you', q: 'What is waiting on me - open requests and reviews to reply to?' })
  }
  if (on('quotes')) out.push({ label: 'Unpaid invoices', q: 'Which invoices are unpaid, and who owes what?' })
  if (on('payments')) out.push({ label: 'Money this week', q: 'What money came in this week, and what is still owed?' })
  if (on('reviews')) out.push({ label: 'How are reviews?', q: 'How are my reviews looking?' })
  if (on('booking')) out.push({ label: 'Block out time', q: 'I want to block out some time in my diary.' })
  if (on('presence')) out.push({ label: 'My page', q: 'How is my public page set up, and what should I improve?' })
  // Nothing enabled yet (brand-new workspace): still offer the basics.
  return out.length ? out.slice(0, 5) : [
    { label: 'What can you do?', q: 'What can you do for me?' },
  ]
}

function GeniePage({ me }: { me?: Me }) {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [sessionId, setSessionId] = useState<string>(() => sessionStorage.getItem('mb.genieSession') ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [remaining, setRemaining] = useState<number | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sessionId) return
    void api('GET', `/v1/genie/history?sessionId=${sessionId}`)
      .then((r) => setMessages(r.messages ?? []))
      .catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, busy])

  const ask = (q: string) => {
    if (!q.trim() || busy) return
    setError('')
    setMessages((m) => [...m, { role: 'user', text: q }])
    setInput('')
    setBusy(true)
    void api('POST', '/v1/genie/chat', { sessionId: sessionId || undefined, message: q })
      .then((r) => {
        setMessages((m) => [...m, { role: 'assistant', text: r.text }])
        setRemaining(r.remaining ?? null)
        setPending(r.pendingAction ?? null)
        if (r.sessionId && r.sessionId !== sessionId) {
          setSessionId(r.sessionId)
          sessionStorage.setItem('mb.genieSession', r.sessionId)
        }
      })
      .catch((e) => setError(explain(e)))
      .finally(() => setBusy(false))
  }

  const decide = (confirm: boolean) => {
    if (!pending || busy) return
    setBusy(true); setError('')
    void api('POST', `/v1/genie/actions/${pending.actionId}/${confirm ? 'confirm' : 'decline'}`, {})
      .then((r) => {
        setMessages((m) => [...m, {
          role: 'assistant',
          text: confirm ? (r.receipt ?? 'Done.') : `Left alone: ${pending.summary}`,
        }])
      })
      .catch((e) => setError(explain(e)))
      .finally(() => { setPending(null); setBusy(false) })
  }

  const submit = (e: FormEvent) => { e.preventDefault(); ask(input) }
  const first = firstChip()
  const chips = [first, ...moduleChips(me).filter((c) => c.label !== first.label)]

  return (
    <div className="genie">
      <h1>Genie</h1>
      <p>
        Your whole business, asked out loud. Genie reads your real records — the diary, the
        inbox, the money, the reviews, the activity trail — and answers with the numbers.
        <span className="meta"> It can also send quotes and invoices, manage bookings and block out
        time — every action behind a card only you can confirm.</span>
      </p>
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card genie-card">
        <div className="genie-log" ref={logRef}>
          {messages.length === 0 && !busy && (
            <p className="meta genie-empty">
              Try a chip below, or ask anything — "who booked this week?", "what did I quote
              Sarah?", "what changed yesterday?"
            </p>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`gmsg ${m.role}`}>{m.text}</div>
          ))}
          {pending && !busy && (
            <div className="gaction">
              <p className="gaction-summary">{pending.summary}</p>
              <div className="row">
                <button type="button" onClick={() => decide(true)}>Confirm</button>
                <button type="button" className="ghost" onClick={() => decide(false)}>Not now</button>
              </div>
              <p className="meta">Nothing happens until you confirm. The card expires in 10 minutes.</p>
            </div>
          )}
          {busy && <div className="gmsg assistant thinking">Checking your records…</div>}
        </div>

        <div className="genie-chips">
          {chips.map((c) => (
            <button key={c.label} type="button" className="chip" disabled={busy} onClick={() => ask(c.q)}>
              {c.label}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="genie-form">
          <input value={input} onChange={(e) => setInput(e.target.value)} disabled={busy}
            placeholder="Ask about your business…" aria-label="Ask Genie" />
          <button disabled={busy || !input.trim()}>{busy ? '…' : 'Ask'}</button>
        </form>
        {remaining != null && remaining < 50 && (
          <p className="meta" style={{ padding: '6px 2px 0' }}>{remaining} Genie messages left this month.</p>
        )}
      </div>
    </div>
  )
}

export const genieDashboard: DashboardModule = {
  id: 'genie',
  label: 'Genie',
  nav: [{ to: '/genie', label: 'Genie' }],
  routes: ({ me }) => (
    <>
      <Route path="/genie" element={<GeniePage me={me} />} />
    </>
  ),
}

export default genieDashboard
