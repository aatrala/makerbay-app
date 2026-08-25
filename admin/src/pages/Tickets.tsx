import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Empty, Notice, Skeleton, when } from '@makerbay/web-kit'
import { adminApi, explainAdmin } from '../api'

interface Ticket {
  tenantId: string
  ticketId: string
  subject: string
  category: string
  status: 'open' | 'answered' | 'closed'
  priority: 'standard' | 'priority'
  messages: Array<{ from: string; text: string; at: string; by?: string }>
  tenantName?: string
  openedByEmail?: string
  updatedAt: string
}

/** The support queue: open first, priority first, most recent first. */
export default function Tickets() {
  const [tickets, setTickets] = useState<Ticket[] | null>(null)
  const [filter, setFilter] = useState<'active' | 'all'>('active')
  const [open, setOpen] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setTickets((await adminApi('GET', '/admin/v1/tickets')).tickets ?? []) }
    catch (e) { setError(explainAdmin(e)); setTickets([]) }
  }, [])
  useEffect(() => { void load() }, [load])

  const run = (fn: () => Promise<void>) =>
    void (async () => {
      setBusy(true); setError(''); setNote('')
      try { await fn(); await load() } catch (e) { setError(explainAdmin(e)) } finally { setBusy(false) }
    })()

  const shown = (tickets ?? []).filter((t) => filter === 'all' || t.status !== 'closed')
  const current = shown.find((t) => t.ticketId === open) ?? null

  return (
    <>
      <h1>Tickets</h1>
      <p>Support and feedback from every workspace. Replies land in the customer's dashboard and inbox.</p>
      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card">
        <div className="tabs">
          <button className={filter === 'active' ? 'on' : ''} onClick={() => setFilter('active')}>Needs attention</button>
          <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>Everything</button>
        </div>
        {!tickets ? <div className="mt"><Skeleton rows={4} /></div> : shown.length === 0 ? (
          <Empty title={filter === 'active' ? 'Inbox zero' : 'No tickets yet'}>
            When a customer writes in from their dashboard it appears here.
          </Empty>
        ) : (
          <div className="scroll-x mt">
            <table>
              <thead><tr><th>Ticket</th><th>Workspace</th><th>Status</th><th>Updated</th></tr></thead>
              <tbody>
                {shown.map((t) => (
                  <tr key={t.ticketId} className="rowlink" onClick={() => { setOpen(t.ticketId); setReply('') }}>
                    <td>
                      {t.priority === 'priority' && <span className="chip warn" style={{ marginRight: 6 }}>priority</span>}
                      <strong>{t.subject}</strong>
                      <div className="meta">{t.category} · {t.messages.length} message{t.messages.length === 1 ? '' : 's'}</div>
                    </td>
                    <td className="nowrap">
                      <Link to={`/tenants/${t.tenantId}`} onClick={(e) => e.stopPropagation()}>{t.tenantName ?? t.tenantId}</Link>
                    </td>
                    <td><span className={`chip ${t.status === 'open' ? 'failed' : t.status === 'answered' ? 'processing' : 'dim'}`}>{t.status}</span></td>
                    <td className="nowrap">{when(t.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {current && (
        <div className="card">
          <div className="row">
            <h2 className="grow">{current.subject}</h2>
            <button className="ghost" onClick={() => setOpen(null)}>Close panel</button>
          </div>
          <p className="meta">
            {current.tenantName} · {current.openedByEmail ?? 'no email'} · {current.category}
          </p>
          {current.messages.map((m, i) => (
            <div key={i} className="reason-panel" style={{ borderLeftColor: m.from === 'staff' ? 'var(--accent)' : '#a8a29e' }}>
              <p className="meta">{m.from === 'staff' ? `You (${m.by ?? 'staff'})` : m.by ?? 'Customer'} · {when(m.at)}</p>
              <p style={{ whiteSpace: 'pre-wrap' }}>{m.text}</p>
            </div>
          ))}
          <label htmlFor="tk-reply" className="mt">Reply</label>
          <textarea id="tk-reply" rows={4} value={reply} onChange={(e) => setReply(e.target.value)}
            placeholder="Goes to their dashboard and their inbox." />
          <div className="row mt">
            <button disabled={busy || reply.trim().length < 2}
              onClick={() => run(async () => {
                await adminApi('POST', `/admin/v1/tickets/${current.tenantId}/${current.ticketId}/reply`, { message: reply })
                setReply(''); setNote('Replied - the customer has it in their dashboard and inbox.')
              })}>
              {busy ? 'Sending…' : 'Send reply'}
            </button>
            {current.status !== 'closed' && (
              <button className="ghost" disabled={busy}
                onClick={() => run(async () => {
                  await adminApi('POST', `/admin/v1/tickets/${current.tenantId}/${current.ticketId}/close`, {})
                  setNote('Closed. A customer reply re-opens it.'); setOpen(null)
                })}>
                Close ticket
              </button>
            )}
          </div>
        </div>
      )}
    </>
  )
}
