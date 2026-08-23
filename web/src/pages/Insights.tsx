import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, explain } from '../api'
import { Empty, Notice, Skeleton } from '../ui'

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
  const [error, setError] = useState('')

  useEffect(() => {
    void api('GET', '/v1/assistant/insights').then(setData).catch((e) => setError(explain(e)))
  }, [])

  if (error) return (<><h1>Insights</h1><Notice tone="err">{error}</Notice></>)

  if (!data) return (
    <>
      <h1>Insights</h1>
      <p>What your customers are asking, and how well the assistant is handling it.</p>
      <div className="card"><Skeleton rows={5} /></div>
      <div className="card"><Skeleton rows={4} /></div>
    </>
  )

  const { totals, daily, topUnanswered } = data
  const peak = Math.max(1, ...daily.map((d) => d.answers))
  const answered = totals.answers - totals.unanswered

  return (
    <>
      <h1>Insights</h1>
      <p>What your customers are asking, and how well the assistant is handling it.</p>

      {totals.conversations === 0 ? (
        <div className="card">
          <Empty title="No conversations to measure yet"
            action={<Link className="btn" to="/assistant/deploy">Put your assistant live</Link>}>
            Once customers start asking questions, this screen shows how many the assistant handled
            on its own and where your knowledge has gaps.
          </Empty>
        </div>
      ) : (
        <>
          <div className="card">
            <h2>At a glance</h2>
            <div className="row baseline stat-row">
              <div>
                <div className="stat">{totals.resolutionRate === null ? '—' : `${totals.resolutionRate}%`}</div>
                <div className="meta">answered without help</div>
              </div>
              <div>
                <div className="stat">{totals.conversations.toLocaleString()}</div>
                <div className="meta">conversations</div>
              </div>
              <div>
                <div className="stat">{answered.toLocaleString()}</div>
                <div className="meta">questions answered</div>
              </div>
              <div>
                <div className="stat">{totals.unanswered.toLocaleString()}</div>
                <div className="meta">it could not answer</div>
              </div>
              <div>
                <div className="stat">{totals.thumbsUp} · {totals.thumbsDown}</div>
                <div className="meta">👍 and 👎 from customers</div>
              </div>
            </div>
          </div>

          <div className="card">
            <h2>Activity</h2>
            {daily.length === 0 ? <p className="meta">No activity in the last two weeks.</p> : daily.map((d) => (
              <div key={d.day} className="row day-row">
                <span className="day-label">
                  {new Date(`${d.day}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                </span>
                <div className="grow">
                  <div className="bar tall"><div style={{ width: `${Math.round((d.answers / peak) * 100)}%` }} /></div>
                </div>
                <span className="meta day-count">
                  {d.answers} answered{d.unanswered > 0 ? `, ${d.unanswered} missed` : ''}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="card">
        <h2>Questions your assistant could not answer</h2>
        <p>
          These are the gaps in your knowledge. Answer one on the{' '}
          <Link to="/assistant/conversations">Conversations</Link> screen and it will handle that
          question from then on.
        </p>
        {topUnanswered.length === 0 ? (
          <p className="meta">None — every question was answered from your knowledge.</p>
        ) : (
          <ul className="gaps">{topUnanswered.map((q, i) => <li key={i}>{q}</li>)}</ul>
        )}
      </div>
    </>
  )
}
