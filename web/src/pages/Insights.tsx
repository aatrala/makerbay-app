import { useEffect, useState } from 'react'
import { api } from '../api'

interface InsightsData {
  totals: {
    conversations: number
    answers: number
    unanswered: number
    resolutionRate: number | null
    thumbsUp: number
    thumbsDown: number
  }
  daily: Array<{ day: string; conversations: number; answers: number; unanswered: number }>
  topUnanswered: string[]
}

export default function Insights() {
  const [data, setData] = useState<InsightsData | null>(null)

  useEffect(() => { void api('GET', '/v1/assistant/insights').then(setData) }, [])
  if (!data) return <p>Loading…</p>

  const { totals, daily, topUnanswered } = data
  const peak = Math.max(1, ...daily.map((d) => d.answers))

  return (
    <>
      <h1>Insights</h1>
      <p>What your customers are asking, and how well the assistant is handling it.</p>

      <div className="card">
        <h2>At a glance</h2>
        <table>
          <tbody>
            <tr><td>Conversations</td><td><strong>{totals.conversations}</strong></td></tr>
            <tr><td>Questions answered from your knowledge</td><td><strong>{totals.answers - totals.unanswered}</strong></td></tr>
            <tr><td>Questions it couldn't answer</td><td><strong>{totals.unanswered}</strong></td></tr>
            <tr>
              <td>Resolution rate</td>
              <td><strong>{totals.resolutionRate === null ? '—' : `${totals.resolutionRate}%`}</strong></td>
            </tr>
            <tr><td>Customer feedback</td><td><strong>{totals.thumbsUp} 👍 · {totals.thumbsDown} 👎</strong></td></tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Activity</h2>
        {daily.length === 0 ? <p>No activity yet.</p> : daily.map((d) => (
          <div key={d.day} className="row" style={{ marginBottom: 8 }}>
            <span style={{ width: 96, fontSize: 13 }}>{d.day.slice(5)}</span>
            <div className="grow">
              <div className="bar" style={{ height: 14 }}>
                <div style={{ width: `${Math.round((d.answers / peak) * 100)}%` }} />
              </div>
            </div>
            <span className="hint" style={{ width: 130, textAlign: 'right' }}>
              {d.answers} answered{d.unanswered > 0 ? `, ${d.unanswered} missed` : ''}
            </span>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Questions your assistant couldn't answer</h2>
        <p>These are the gaps in your knowledge. Answer them once on the Conversations screen and it will handle them from then on.</p>
        {topUnanswered.length === 0 ? <p className="hint">None — every question was answered.</p> : (
          <ul>{topUnanswered.map((q, i) => <li key={i} style={{ marginBottom: 6 }}>{q}</li>)}</ul>
        )}
      </div>
    </>
  )
}
