import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, explain, type Me, Notice, Skeleton } from '@makerbay/web-kit'

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

interface Funnel {
  sent: number; opened: number; settled: number
  sentCents: number; settledCents: number; currency: string
}
interface Chase {
  id: string; label: string; who: string
  totalCents: number; currency: string; age: number; reason: string
}
interface Insights {
  quotes: Funnel
  invoices: Funnel
  chase: Chase[]
  viewTrackingSince: string
}

const CASH_LOCALE: Record<string, string> = {
  AUD: 'en-AU', NZD: 'en-NZ', GBP: 'en-GB', USD: 'en-US', CAD: 'en-CA',
  EUR: 'en-IE', INR: 'en-IN', SGD: 'en-SG', ZAR: 'en-ZA', AED: 'en-AE',
}
const cash = (cents: number, currency = 'AUD') => {
  const code = String(currency ?? 'AUD').toUpperCase()
  try {
    return new Intl.NumberFormat(CASH_LOCALE[code] ?? 'en', { style: 'currency', currency: code })
      .format(cents / 100)
  } catch { return `${code} ${(cents / 100).toFixed(2)}` }
}

const pctOf = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)

export default function UsagePage({ me }: { me: Me }) {
  const [totals, setTotals] = useState<Record<string, number> | null>(null)
  const [month, setMonth] = useState('')
  const [insights, setInsights] = useState<Insights | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void api('GET', '/v1/core/usage')
      .then((r) => { setTotals(r.totals ?? {}); setMonth(r.month ?? '') })
      .catch((e) => { setError(explain(e)); setTotals({}) })
    // Quotes may not be switched on, and a missing module must not put an
    // error banner across a page that is mostly about something else.
    void api('GET', '/v1/quotes/insights')
      .then((r) => setInsights(r as Insights))
      .catch(() => setInsights(null))
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

      {insights && (insights.quotes.sent > 0 || insights.invoices.sent > 0) && (
        <div className="card">
          <h2>Your quotes and invoices</h2>
          {/*
            Usage above counts what the platform did. This counts what
            CUSTOMERS did, which is the question an owner actually has.
          */}
          <p className="meta">
            How far your documents are getting. Counted when a customer opens the page,
            not when you send it.
          </p>

          <div className="scroll-x mt">
            <table>
              <thead>
                <tr>
                  <th>Document</th>
                  <th className="num">Sent</th>
                  <th className="num">Opened</th>
                  <th className="num">Accepted / paid</th>
                  <th className="num">Value won</th>
                </tr>
              </thead>
              <tbody>
                {([['Quotes', insights.quotes], ['Invoices', insights.invoices]] as const)
                  .filter(([, f]) => f.sent > 0)
                  .map(([name, f]) => (
                    <tr key={name}>
                      <td>{name}</td>
                      <td className="num">{f.sent}</td>
                      <td className="num">{f.opened} <span className="meta">({pctOf(f.opened, f.sent)}%)</span></td>
                      <td className="num">{f.settled} <span className="meta">({pctOf(f.settled, f.sent)}%)</span></td>
                      <td className="num">{cash(f.settledCents, f.currency)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          {insights.chase.length > 0 && (
            <>
              <h3 className="mt">Worth a phone call</h3>
              {/*
                The distinction this whole view exists for: never opened is a
                DELIVERY problem - the link did not arrive - and opened with no
                answer is a PRICE problem. Opposite responses, and the quotes
                list showed the same "sent" chip for both.
              */}
              <p className="meta">Oldest first. Nobody has answered these.</p>
              <div className="scroll-x mt">
                <table>
                  <thead><tr><th>Who</th><th>Document</th><th className="num">Amount</th><th>Waiting</th><th>What happened</th></tr></thead>
                  <tbody>
                    {insights.chase.map((c) => (
                      <tr key={c.id}>
                        <td>{c.who}</td>
                        <td>{c.label}</td>
                        <td className="num">{cash(c.totalCents, c.currency)}</td>
                        <td>{c.age === 0 ? 'today' : `${c.age}d`}</td>
                        <td>
                          <span className={`chip ${c.reason.startsWith('overdue') ? 'failed' : c.reason === 'never opened' ? 'warn' : ''}`}>
                            {c.reason}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <p className="meta mt">
            Opens have only been counted since {new Date(insights.viewTrackingSince)
              .toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}.
            Anything sent before then shows as not opened because there is no record either way,
            not because nobody looked.
          </p>
        </div>
      )}

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
