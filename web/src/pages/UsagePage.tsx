import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, explain, type Me } from '../api'
import { Notice, Skeleton } from '../ui'

// Metric keys are a stable API contract; these are the names people use.
// An unmapped key falls back to a readable form of the key itself.
const LABELS: Record<string, string> = {
  'assistant.message': 'Questions answered',
  'assistant.tokens': 'AI processing units',
  'assistant.search': 'Knowledge searches',
  'assistant.ingest.documents': 'Documents processed',
  'assistant.scrape': 'Web pages fetched',
}

const label = (key: string) =>
  LABELS[key] ?? key.replace(/^[a-z]+\./, '').replace(/[._]/g, ' ').replace(/^./, (c) => c.toUpperCase())

export default function UsagePage({ me }: { me: Me }) {
  const [totals, setTotals] = useState<Record<string, number> | null>(null)
  const [month, setMonth] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void api('GET', '/v1/core/usage')
      .then((r) => { setTotals(r.totals ?? {}); setMonth(r.month ?? '') })
      .catch((e) => { setError(explain(e)); setTotals({}) })
  }, [])

  const limits = me.entitlements?.modules.assistant?.limits ?? {}
  const messages = totals?.['assistant.message'] ?? 0
  const messageLimit = limits.messagesPerMonth ?? 200
  const pct = Math.min(100, Math.round((messages / messageLimit) * 100))
  const left = Math.max(0, messageLimit - messages)
  const monthName = month
    ? new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    : ''

  return (
    <>
      <h1>Usage</h1>
      <p>{monthName || 'This month'} so far, on the <strong>{me.tenant?.plan}</strong> plan.</p>

      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card">
        <h2>Assistant messages</h2>
        {!totals ? <Skeleton rows={2} /> : (
          <>
            <div className="row baseline">
              <span className="stat grow">{messages.toLocaleString()}<span className="stat-of"> of {messageLimit.toLocaleString()}</span></span>
              <span className="meta">{pct}% used</span>
            </div>
            <div className="bar"><div className={pct >= 90 ? 'over' : ''} style={{ width: `${pct}%` }} /></div>
            <p className="meta mt">
              {left > 0
                ? `${left.toLocaleString()} message${left === 1 ? '' : 's'} left this month. It resets on the 1st.`
                : 'You have used every included message this month.'}
              {' '}
              {pct >= 80 && <Link to="/billing">Change plan</Link>}
            </p>
          </>
        )}
      </div>

      <div className="card">
        <h2>All metrics</h2>
        {!totals ? <Skeleton rows={3} /> : Object.keys(totals).length === 0 ? (
          <p className="meta">Nothing recorded yet this month.</p>
        ) : (
          <div className="scroll-x">
            <table>
              <thead><tr><th>Metric</th><th className="num">Quantity</th></tr></thead>
              <tbody>
                {Object.entries(totals).map(([k, v]) => (
                  <tr key={k}>
                    <td>{label(k)}</td>
                    <td className="num">{Math.round(v).toLocaleString()}</td>
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
