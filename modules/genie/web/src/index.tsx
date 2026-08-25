import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Route } from 'react-router-dom'
import { api, explain, Notice, type DashboardModule, type Me } from '@makerbay/web-kit'

interface Msg { role: 'user' | 'assistant'; text: string; tools?: string[] }
interface Pending { actionId: string; summary: string }

/**
 * Markdown-lite for Genie's answers: bold, bullet lists and paragraphs -
 * enough hierarchy to scan a briefing, small enough to never surprise.
 * Built with React nodes, so escaping stays automatic.
 */
function renderRich(text: string) {
  const bold = (line: string, key: number) => {
    const parts = line.split(/\*\*([^*]+)\*\*/g)
    return (
      <span key={key}>
        {parts.map((p, i) => (i % 2 === 1 ? <strong key={i}>{p}</strong> : p))}
      </span>
    )
  }
  const lines = text.split('\n')
  const out: JSX.Element[] = []
  let list: string[] = []
  const flush = () => {
    if (!list.length) return
    out.push(
      <ul key={out.length} className="grich-list">
        {list.map((li, i) => <li key={i}>{bold(li, i)}</li>)}
      </ul>,
    )
    list = []
  }
  lines.forEach((raw, i) => {
    const line = raw.trimEnd()
    const m = /^\s*[-•]\s+(.*)$/.exec(line)
    if (m) { list.push(m[1]); return }
    flush()
    if (line.trim()) out.push(<p key={`p${i}`} className="grich-p">{bold(line, i)}</p>)
  })
  flush()
  return out.length ? out : text
}

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
  const [moreOpen, setMoreOpen] = useState(false)
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
        setMessages((m) => [...m, { role: 'assistant', text: r.text, tools: r.toolsUsed }])
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
  const started = messages.length > 0

  // The permanent quick row: the four asks that earn a standing button.
  // Everything else lives behind + once a conversation has started.
  const mods = me?.entitlements?.modules ?? {}
  const quick = [
    firstChip(),
    ...(mods.booking ? [{ label: 'Diary', q: 'What is in the diary today and tomorrow?' }] : []),
    ...(mods.quotes || mods.payments ? [{ label: 'Money', q: 'What money came in recently, and what is still owed?' }] : []),
    ...(mods.booking ? [{ label: 'Block time', q: 'I want to block out some time in my diary.' }] : []),
  ].filter((c, i, all) => all.findIndex((x) => x.label === c.label) === i).slice(0, 4)
  const extra = moduleChips(me).filter((c) => !quick.some((qc) => qc.label === c.label))

  return (
    <div className="genie">
      <div className="genie-head">
        <h1>Genie</h1>
        {!started && (
          <p>
            Your whole business, asked out loud — real records, real numbers, and actions
            behind a card only you can confirm.
          </p>
        )}
      </div>
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card genie-card">
        <div className="genie-log" ref={logRef}>
          {!started && !busy && (
            <p className="meta genie-empty">
              Try a button below, or ask anything — "who booked this week?", "what did I quote
              Sarah?", "what changed yesterday?"
            </p>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`gmsg ${m.role}`}>
              {m.role === 'assistant' ? renderRich(m.text) : m.text}
              {m.role === 'assistant' && (m.tools?.length ?? 0) > 0 && (
                <div className="gtools">checked: {m.tools!.filter((t) => !t.includes('_')).join(', ') || m.tools!.join(', ')}</div>
              )}
            </div>
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
          {quick.map((c) => (
            <button key={c.label} type="button" className="chip" disabled={busy} onClick={() => ask(c.q)}>
              {c.label}
            </button>
          ))}
          {extra.length > 0 && (
            <button type="button" className="chip" disabled={busy} aria-expanded={moreOpen}
              onClick={() => setMoreOpen(!moreOpen)}>
              {moreOpen ? '−' : '+'}
            </button>
          )}
          {moreOpen && extra.map((c) => (
            <button key={c.label} type="button" className="chip" disabled={busy}
              onClick={() => { setMoreOpen(false); ask(c.q) }}>
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
