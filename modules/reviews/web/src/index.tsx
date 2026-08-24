import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Route } from 'react-router-dom'
import {
  Empty,
  Notice,
  Skeleton,
  api,
  explain,
  when,
  type DashboardModule,
} from '@makerbay/web-kit'

interface Review {
  reviewId: string
  status: 'invited' | 'published' | 'hidden'
  name?: string
  email?: string
  rating?: number
  text?: string
  serviceName?: string
  createdAt: string
  respondedAt?: string
}

interface Stats {
  invited: number
  responded: number
  average: number | null
}

const Stars = ({ n }: { n: number }) => (
  <span aria-label={`${n} stars`} className="nowrap">
    {'★'.repeat(n)}
    <span className="meta">{'★'.repeat(5 - n)}</span>
  </span>
)

function ReviewsList() {
  const [reviews, setReviews] = useState<Review[] | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await api('GET', '/v1/reviews')
      setReviews(r.reviews); setStats(r.stats)
    } catch (e) { setError(explain(e)); setReviews([]) }
  }, [])
  useEffect(() => { void load() }, [load])

  const moderate = (reviewId: string, status: 'hidden' | 'published') =>
    void (async () => {
      setBusy(true); setError('')
      try { await api('PATCH', `/v1/reviews/${reviewId}`, { status }); await load() }
      catch (e) { setError(explain(e)) } finally { setBusy(false) }
    })()

  const responded = (reviews ?? []).filter((r) => r.rating)
  const pending = (reviews ?? []).filter((r) => r.status === 'invited')

  return (
    <>
      <h1>Reviews</h1>
      <p>
        Asked at the right moment — just after a job is done — and shown on your
        MakerBay page. Every respondent is offered the Google link too, whatever
        they scored: gating reviews breaks Google’s rules and we don’t do it.
      </p>
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      {stats && (
        <div className="card">
          <div className="row baseline stat-row">
            <div>
              <div className="stat">{stats.average ?? '—'}</div>
              <div className="meta">average rating</div>
            </div>
            <div>
              <div className="stat">{stats.responded}</div>
              <div className="meta">reviews received</div>
            </div>
            <div>
              <div className="stat">{stats.invited}</div>
              <div className="meta">awaiting a reply</div>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <h2>What customers said</h2>
        {!reviews ? <Skeleton rows={4} /> : responded.length === 0 ? (
          <Empty title="No reviews yet">
            Mark a booking completed, or ask a contact directly from their page —
            the invite goes out by email with a one-minute form.
          </Empty>
        ) : (
          responded.map((r) => (
            <div key={r.reviewId} className="mt">
              <div className="row">
                <Stars n={r.rating ?? 0} />
                <strong>{r.name || r.email}</strong>
                {r.serviceName && <span className="meta">{r.serviceName}</span>}
                <span className="grow" />
                <span className="meta nowrap">{r.respondedAt ? when(r.respondedAt) : ''}</span>
              </div>
              {r.text && <p>{r.text}</p>}
              <div className="row">
                {r.status === 'published' ? (
                  <button className="ghost" disabled={busy} onClick={() => moderate(r.reviewId, 'hidden')}>
                    Hide from public page
                  </button>
                ) : (
                  <button className="ghost" disabled={busy} onClick={() => moderate(r.reviewId, 'published')}>
                    Show on public page
                  </button>
                )}
                {r.status === 'hidden' && <span className="chip failed">hidden</span>}
              </div>
            </div>
          ))
        )}
        {responded.length > 0 && (
          <p className="meta mt">
            You can hide a review from your page or bring it back — never edit it.
            The words are the customer’s.
          </p>
        )}
      </div>

      <AskCard onSent={load} />

      {pending.length > 0 && (
        <div className="card">
          <h2>Waiting on a reply</h2>
          <div className="scroll-x">
            <table>
              <thead><tr><th>Who</th><th>Asked</th></tr></thead>
              <tbody>
                {pending.map((r) => (
                  <tr key={r.reviewId}>
                    <td>{r.name || r.email}</td>
                    <td className="nowrap">{when(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}

function AskCard({ onSent }: { onSent: () => Promise<void> }) {
  const [contacts, setContacts] = useState<Array<{ contactId: string; name?: string; email?: string }>>([])
  const [contactId, setContactId] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api('GET', '/v1/contacts')
      .then((r) => setContacts((r.contacts ?? []).filter((c: { email?: string }) => c.email)))
      .catch(() => setContacts([]))
  }, [])

  const ask = (e: FormEvent) => {
    e.preventDefault()
    if (!contactId) return
    setBusy(true); setError(''); setNote('')
    void api('POST', '/v1/reviews/invite', { contactId })
      .then(async (r) => {
        setNote(r.sent ? 'Asked — the email is on its way.' : 'Invite created, but the email could not be sent yet.')
        setContactId('')
        await onSent()
      })
      .catch((err) => setError(explain(err)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="card">
      <h2>Ask someone now</h2>
      <p className="meta">For a job that finished outside the diary. One email, one polite ask.</p>
      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}
      <form onSubmit={ask}>
        <div className="row">
          <select className="grow" value={contactId} onChange={(e) => setContactId(e.target.value)}
            aria-label="Which customer">
            <option value="">Pick a customer…</option>
            {contacts.map((c) => (
              <option key={c.contactId} value={c.contactId}>{c.name || c.email}</option>
            ))}
          </select>
          <button disabled={busy || !contactId}>{busy ? 'Sending…' : 'Ask for a review'}</button>
        </div>
      </form>
    </div>
  )
}

function ReviewsSettings() {
  const [config, setConfig] = useState<{ autoAsk: boolean; askMessage: string } | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api('GET', '/v1/reviews/config')
      .then((r) => setConfig(r.config))
      .catch((e) => setError(explain(e)))
  }, [])

  const save = (e: FormEvent) => {
    e.preventDefault()
    if (!config) return
    setBusy(true); setError(''); setNote('')
    void api('PUT', '/v1/reviews/config', config)
      .then(() => setNote('Saved.'))
      .catch((err) => setError(explain(err)))
      .finally(() => setBusy(false))
  }

  return (
    <>
      <h1>Review settings</h1>
      <p>How and when customers are asked.</p>
      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      {!config ? <div className="card"><Skeleton rows={3} /></div> : (
        <div className="card">
          <form onSubmit={save}>
            <label className="row">
              <input type="checkbox" checked={config.autoAsk}
                onChange={(e) => setConfig({ ...config, autoAsk: e.target.checked })} />
              <span>Ask automatically when a booking is marked completed</span>
            </label>
            <p className="meta">One ask per completed job, never a barrage.</p>
            <label htmlFor="ask-msg">The message customers receive</label>
            <textarea id="ask-msg" rows={3} maxLength={400} value={config.askMessage}
              onChange={(e) => setConfig({ ...config, askMessage: e.target.value })} />
            <div className="mt"><button disabled={busy}>Save</button></div>
          </form>
        </div>
      )}
    </>
  )
}

export const reviewsDashboard: DashboardModule = {
  id: 'reviews',
  label: 'Reviews',
  nav: [
    { to: '/reviews', label: 'Reviews' },
    { to: '/reviews/settings', label: 'Settings' },
  ],
  routes: () => (
    <>
      <Route path="/reviews" element={<ReviewsList />} />
      <Route path="/reviews/settings" element={<ReviewsSettings />} />
    </>
  ),
}

export default reviewsDashboard
