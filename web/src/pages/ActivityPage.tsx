import { useCallback, useEffect, useState } from 'react'
import { api, explain, Empty, Notice, Skeleton, when } from '@makerbay/web-kit'

interface Entry {
  ts: string
  actor?: { type: string; id: string; label?: string }
  origin: string
  action: string
  moduleId: string
  summary: string
}

const MODULE_LABEL: Record<string, string> = {
  platform: 'Workspace', assistant: 'Assistant', booking: 'Bookings',
  quotes: 'Quotes', reviews: 'Reviews', payments: 'Get paid',
  visibility: 'Get found', voice: 'Missed calls', requests: 'Requests',
  presence: 'Your page', genie: 'Genie',
}

const monthLabel = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })

const shiftMonth = (m: string, by: number) => {
  const d = new Date(`${m}-01T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + by)
  return d.toISOString().slice(0, 7)
}

/**
 * The workspace activity trail: everything that happened, one sentence per
 * event, whoever (or whatever) did it. This is also what Genie will cite
 * when it answers "what happened yesterday?" - same table, same words.
 */
export default function ActivityPage() {
  const now = new Date().toISOString().slice(0, 7)
  const [month, setMonth] = useState(now)
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async (m: string) => {
    setEntries(null)
    try { setEntries((await api('GET', `/v1/core/activity?month=${m}`)).entries) }
    catch (e) { setError(explain(e)); setEntries([]) }
  }, [])
  useEffect(() => { void load(month) }, [load, month])

  return (
    <>
      <h1>Activity</h1>
      <p>
        Everything that happened in this workspace - actions by you, by customers,
        and by MakerBay itself. Traceability, not telemetry: one plain sentence each.
      </p>
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card">
        <div className="row">
          <button className="ghost" onClick={() => setMonth(shiftMonth(month, -1))}>←</button>
          <strong className="grow" style={{ textAlign: 'center' }}>{monthLabel(month)}</strong>
          <button className="ghost" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= now}>→</button>
        </div>

        {!entries ? <div className="mt"><Skeleton rows={5} /></div> : entries.length === 0 ? (
          <Empty title="Nothing recorded this month">
            Activity starts appearing as things happen - bookings, quotes, payments,
            settings changes. The trail keeps 13 months.
          </Empty>
        ) : (
          <ul className="checklist mt">
            {entries.map((e, i) => (
              <li key={i}>
                <span aria-hidden="true">·</span>{' '}
                <strong>{MODULE_LABEL[e.moduleId] ?? e.moduleId}</strong> — {e.summary}
                <span className="meta">
                  {' '}· {when(e.ts)}
                  {e.actor?.label ? ` · ${e.actor.label}` : e.actor?.type === 'user' ? ' · you' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
