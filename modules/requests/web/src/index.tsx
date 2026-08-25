import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, Route, useParams } from 'react-router-dom'
import {
  Empty,
  Notice,
  Skeleton,
  api,
  explain,
  when,
  type DashboardModule,
} from '@makerbay/web-kit'

interface RequestRow {
  requestId: string
  kind: 'handoff' | 'lead' | 'feedback' | 'missedcall'
  status: 'new' | 'open' | 'closed'
  contactId: string
  name?: string
  email?: string
  phone?: string
  subject: string
  message: string
  transcript?: Array<{ role: string; text: string }>
  replies?: Array<{ at: string; text: string; emailed: boolean; emailError?: string }>
  notifyError?: string
  createdAt: string
}

const KIND_LABEL: Record<string, string> = {
  handoff: 'Wants a person',
  lead: 'Wants contact',
  feedback: 'Feedback',
  missedcall: 'Missed call',
}

const emailWarning = (error?: string) =>
  error === 'sandbox_or_rejected'
    ? 'Email is not switched on for this account yet, so no notification went out. Follow up by hand.'
    : error === 'no_recipient'
      ? 'No email address was given, so nothing could be sent.'
      : error
        ? `The notification could not be sent (${error}).`
        : undefined

function Inbox() {
  const [requests, setRequests] = useState<RequestRow[] | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [status, setStatus] = useState<'new' | 'open' | 'closed' | ''>('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await api('GET', `/v1/requests${status ? `?status=${status}` : ''}`)
      setRequests(r.requests)
      setCounts(r.counts ?? {})
    } catch (e) {
      setError(explain(e))
      setRequests([])
    }
  }, [status])

  useEffect(() => { void load() }, [load])

  return (
    <>
      <h1>Requests</h1>
      <p>Every question your assistant could not close, and everyone who asked to be contacted.</p>

      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="tabs">
        <button className={status === '' ? 'on' : ''} onClick={() => setStatus('')}>
          All
        </button>
        <button className={status === 'new' ? 'on' : ''} onClick={() => setStatus('new')}>
          New{counts.new ? ` (${counts.new})` : ''}
        </button>
        <button className={status === 'open' ? 'on' : ''} onClick={() => setStatus('open')}>
          Open{counts.open ? ` (${counts.open})` : ''}
        </button>
        <button className={status === 'closed' ? 'on' : ''} onClick={() => setStatus('closed')}>
          Closed
        </button>
      </div>

      <div className="card">
        {!requests ? <Skeleton rows={5} /> : requests.length === 0 ? (
          <Empty title={status ? 'Nothing with that status' : 'No requests yet'}
            action={!status ? <Link className="btn" to="/assistant/deploy">Put your assistant live</Link> : undefined}>
            {status
              ? 'Try another tab.'
              : 'When your assistant cannot answer, it offers to take the customer’s details. Those land here.'}
          </Empty>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr><th>From</th><th>About</th><th>Kind</th><th>Status</th><th>When</th></tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.requestId}>
                    <td>
                      <Link to={`/requests/${r.requestId}`}>{r.name || r.email || r.phone || 'Someone'}</Link>
                      {r.email && <div className="meta trunc">{r.email}</div>}
                    </td>
                    <td>{r.subject}</td>
                    <td><span className="meta">{KIND_LABEL[r.kind]}</span></td>
                    <td>
                      <span className={`chip ${r.status === 'new' ? 'processing' : r.status === 'closed' ? 'ready' : 'awaiting_upload'}`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="nowrap">{when(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

function RequestDetail() {
  const { requestId = '' } = useParams()
  const [request, setRequest] = useState<RequestRow | null>(null)
  const [reply, setReply] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setRequest((await api('GET', `/v1/requests/${requestId}`)).request) }
    catch (e) { setError(explain(e)) }
  }, [requestId])

  useEffect(() => { void load() }, [load])

  const run = async (fn: () => Promise<void>) => {
    setError(''); setNote(''); setBusy(true)
    try { await fn(); await load() } catch (e) { setError(explain(e)) } finally { setBusy(false) }
  }

  const send = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const r = await api('POST', `/v1/requests/${requestId}/replies`, { text: reply })
      setReply('')
      setNote(r.emailed
        ? 'Replied, and the email is on its way.'
        : emailWarning(r.emailError) ?? 'Reply saved, but the email did not send.')
    })
  }

  const setStatus = (status: string) =>
    void run(async () => { await api('PATCH', `/v1/requests/${requestId}`, { status }) })

  if (error && !request) return (
    <><p className="meta"><Link to="/requests">← All requests</Link></p><h1>Request</h1>
      <Notice tone="err">{error}</Notice></>
  )
  if (!request) return (
    <><p className="meta"><Link to="/requests">← All requests</Link></p><h1>Request</h1>
      <div className="card"><Skeleton rows={5} /></div></>
  )

  const warn = emailWarning(request.notifyError)

  return (
    <>
      <p className="meta"><Link to="/requests">← All requests</Link></p>
      <h1>{request.subject}</h1>
      <p>
        From {request.name || 'someone'} · {when(request.createdAt)} ·{' '}
        <Link to={`/contacts/${request.contactId}`}>see their history</Link>
      </p>

      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}
      {warn && <Notice tone="warn">{warn}</Notice>}

      <div className="card">
        <h2>What they said</h2>
        <p className="quoted">{request.message}</p>
        <dl className="facts">
          {request.email && <><dt>Email</dt><dd><a href={`mailto:${request.email}`}>{request.email}</a></dd></>}
          {request.phone && <><dt>Phone</dt><dd><a href={`tel:${request.phone}`}>{request.phone}</a></dd></>}
        </dl>
        <label>Status</label>
        <div className="row">
          {['new', 'open', 'closed'].map((s) => (
            <button key={s} className={s === request.status ? '' : 'ghost'} disabled={busy}
              onClick={() => s !== request.status && setStatus(s)}>{s}</button>
          ))}
        </div>
      </div>

      {request.transcript && request.transcript.length > 0 && (
        <div className="card">
          <h2>The conversation before this</h2>
          {request.transcript.map((t, i) => (
            <div key={i} className={`msg ${t.role === 'user' ? 'user' : 'bot'}`}>{t.text}</div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>Reply</h2>
        {request.replies?.length ? (
          <ol className="timeline">
            {request.replies.map((r, i) => (
              <li key={i}>
                <div className="row baseline">
                  <strong className="grow">You replied</strong>
                  <span className="meta nowrap">{when(r.at)}</span>
                </div>
                <p className="meta">{r.text}</p>
                {!r.emailed && <span className="chip failed">not emailed</span>}
              </li>
            ))}
          </ol>
        ) : null}
        <form onSubmit={send} className="mt">
          <textarea rows={4} value={reply} onChange={(e) => setReply(e.target.value)} required
            placeholder="Write your reply. It goes straight to their email." aria-label="Your reply" />
          <div className="mt">
            <button disabled={busy || reply.trim().length < 2}>
              {busy ? 'Sending…' : 'Send reply'}
            </button>
          </div>
        </form>
      </div>
    </>
  )
}

function RequestSettings() {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api('GET', '/v1/requests/config').then((r) => setConfig(r.config)).catch((e) => setError(explain(e)))
  }, [])

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try { await api('PUT', '/v1/requests/config', config); setSaved(true) }
    catch (e) { setError(explain(e)) } finally { setBusy(false) }
  }

  const set = (k: string) => (e: { target: { value: string } }) => {
    setConfig((c) => (c ? { ...c, [k]: e.target.value } : c)); setSaved(false)
  }

  return (
    <>
      <h1>Request settings</h1>
      <p>What the assistant offers when it cannot help, and where the notification goes.</p>

      {saved && <Notice tone="ok" onClose={() => setSaved(false)}>Saved.</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card">
        {!config ? <Skeleton rows={5} /> : (
          <form onSubmit={save}>
            <label htmlFor="notify">Send notifications to</label>
            <input id="notify" type="email" value={String(config.notifyEmail ?? '')} onChange={set('notifyEmail')}
              placeholder="you@your-business.com" />
            <p className="meta">
              On the Trade plan, an email the moment each lead lands. On Free, one summary email
              every morning — a lead never disappears, it just waits for breakfast.{' '}
              <Link to="/billing">See plans</Link>
            </p>

            <label className="pick">
              <input type="checkbox" checked={config.handoffEnabled !== false}
                onChange={(e) => { setConfig({ ...config, handoffEnabled: e.target.checked }); setSaved(false) }} />
              <span>Offer a person when the assistant cannot answer</span>
            </label>

            <label htmlFor="prompt">What the assistant says when it offers</label>
            <input id="prompt" value={String(config.handoffPrompt ?? '')} onChange={set('handoffPrompt')} />

            <label htmlFor="auto">What the customer sees after sending</label>
            <input id="auto" value={String(config.autoReply ?? '')} onChange={set('autoReply')} />

            <h2 className="mt">Form fields <span className="chip processing">TRADE</span></h2>
            <p className="meta">
              What the "Leave your details" form asks for. Name, contact and message are always
              there; choose the rest. Ask only for what you will actually use.
            </p>
            {(() => {
              const f = (config.fields ?? { phone: 'optional', address: 'off', preferredTime: 'off' }) as {
                phone: string; address: string; preferredTime: string; custom?: { label: string; enabled: boolean }
              }
              const setF = (patch: Partial<typeof f>) => {
                setConfig({ ...config, fields: { ...f, ...patch } }); setSaved(false)
              }
              return (
                <>
                  <div className="row">
                    <div className="grow">
                      <label htmlFor="f-phone">Phone</label>
                      <select id="f-phone" value={f.phone} onChange={(e) => setF({ phone: e.target.value })}>
                        <option value="optional">Optional</option>
                        <option value="required">Required</option>
                        <option value="off">Do not ask</option>
                      </select>
                    </div>
                    <div className="grow">
                      <label htmlFor="f-addr">Address / suburb</label>
                      <select id="f-addr" value={f.address} onChange={(e) => setF({ address: e.target.value })}>
                        <option value="off">Do not ask</option>
                        <option value="optional">Optional</option>
                      </select>
                    </div>
                    <div className="grow">
                      <label htmlFor="f-when">Preferred time</label>
                      <select id="f-when" value={f.preferredTime} onChange={(e) => setF({ preferredTime: e.target.value })}>
                        <option value="off">Do not ask</option>
                        <option value="optional">Optional</option>
                      </select>
                    </div>
                  </div>
                  <label className="pick mt">
                    <input type="checkbox" checked={f.custom?.enabled === true}
                      onChange={(e) => setF({ custom: { label: f.custom?.label ?? '', enabled: e.target.checked } })} />
                    <span>Ask one question of your own</span>
                  </label>
                  {f.custom?.enabled && (
                    <input value={f.custom.label} maxLength={80}
                      placeholder="e.g. What suburb is the job in?"
                      onChange={(e) => setF({ custom: { label: e.target.value, enabled: true } })}
                      aria-label="Your custom question" />
                  )}
                </>
              )
            })()}

            <div className="mt"><button disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button></div>
          </form>
        )}
      </div>
    </>
  )
}

export const requestsDashboard: DashboardModule = {
  id: 'requests',
  label: 'Requests',
  nav: [
    { to: '/requests', label: 'Inbox' },
    { to: '/requests/settings', label: 'Settings' },
  ],
  routes: () => (
    <>
      <Route path="/requests" element={<Inbox />} />
      <Route path="/requests/settings" element={<RequestSettings />} />
      <Route path="/requests/:requestId" element={<RequestDetail />} />
    </>
  ),
}

export default requestsDashboard
