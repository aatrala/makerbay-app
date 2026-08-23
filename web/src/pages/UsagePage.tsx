import { useEffect, useState } from 'react'
import { api, type Me } from '../api'

export default function UsagePage({ me }: { me: Me }) {
  const [totals, setTotals] = useState<Record<string, number>>({})
  const [month, setMonth] = useState('')

  useEffect(() => {
    void api('GET', '/v1/core/usage').then((r) => {
      setTotals(r.totals ?? {})
      setMonth(r.month ?? '')
    })
  }, [])

  const limits = me.entitlements?.modules.assistant?.limits ?? {}
  const messages = totals['assistant.message'] ?? 0
  const messageLimit = limits.messagesPerMonth ?? 200
  const pct = Math.min(100, Math.round((messages / messageLimit) * 100))

  return (
    <>
      <h1>Usage</h1>
      <p>Month to date ({month}) on the <strong>{me.tenant?.plan}</strong> plan.</p>
      <div className="card">
        <h2>Assistant messages</h2>
        <div className="row">
          <span className="grow">{messages} of {messageLimit} messages</span>
          <span className="hint">{pct}%</span>
        </div>
        <div className="bar"><div style={{ width: `${pct}%` }} /></div>
      </div>
      <div className="card">
        <h2>All metrics</h2>
        {Object.keys(totals).length === 0 ? <p>No usage yet this month.</p> : (
          <table>
            <thead><tr><th>Metric</th><th>Quantity</th></tr></thead>
            <tbody>
              {Object.entries(totals).map(([k, v]) => (
                <tr key={k}><td>{k}</td><td>{Math.round(v).toLocaleString()}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
