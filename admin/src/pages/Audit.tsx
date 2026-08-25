import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Empty, Notice, Skeleton, when } from '@makerbay/web-kit'
import { adminApi, explainAdmin } from '../api'

interface Entry {
  ts: string
  staffEmail: string
  action: string
  targetTenantId: string
  detail: Record<string, unknown>
  result: string
}

/** The human half of a detail blob: reason, email, subject - what a reader
 *  actually wants; the full JSON stays one click away. */
const primaryDetail = (d: Record<string, unknown> | undefined): string => {
  if (!d) return ''
  return [d.reason, d.text, d.subject, d.email, d.moduleId]
    .filter((v) => typeof v === 'string' && v)
    .join(' · ')
}

const shownCount = (entries: Array<{ action: string }>, filter: string) =>
  entries.filter((e) => !filter || e.action === filter).length

/** The staff audit trail: month-partitioned, append-only, read verbatim. */
export default function Audit() {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [actionFilter, setActionFilter] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setEntries(null)
    try {
      const r = await adminApi('GET', `/admin/v1/audit?month=${month}`)
      setEntries(r.entries ?? [])
    } catch (e) { setError(explainAdmin(e)); setEntries([]) }
  }, [month])
  useEffect(() => { void load() }, [load])

  return (
    <>
      <h1>Audit log</h1>
      <p>Every staff action, append-only. The console cannot edit or delete this trail.</p>
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card">
        <div className="row">
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
            aria-label="Month" style={{ maxWidth: 180 }} />
          <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}
            aria-label="Filter by action" style={{ maxWidth: 220 }}>
            <option value="">All actions</option>
            {[...new Set((entries ?? []).map((e) => e.action))].sort().map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          {entries && <span className="meta">{shownCount(entries, actionFilter)} entries</span>}
        </div>

        {!entries ? <div className="mt"><Skeleton rows={6} /></div> : entries.length === 0 ? (
          <Empty title="Nothing this month">Staff actions land here the moment they happen.</Empty>
        ) : (
          <div className="scroll-x mt">
            <table>
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Workspace</th><th>Detail</th></tr></thead>
              <tbody>
                {entries.filter((e) => !actionFilter || e.action === actionFilter).map((e, i) => (
                  <tr key={i}>
                    <td className="nowrap">{when(e.ts)}</td>
                    <td className="nowrap">{e.staffEmail}</td>
                    <td className="nowrap">
                      {e.action}
                      {e.result !== 'ok' && <span className="chip failed" style={{ marginLeft: 6 }}>{e.result}</span>}
                    </td>
                    <td className="nowrap">
                      {e.targetTenantId && e.targetTenantId !== '-'
                        ? <Link to={`/tenants/${e.targetTenantId}`}><code>{e.targetTenantId.slice(0, 10)}…</code></Link>
                        : <span className="meta">—</span>}
                    </td>
                    <td style={{ maxWidth: 380 }}>
                      {primaryDetail(e.detail) && <span>{primaryDetail(e.detail)}</span>}
                      {Object.keys(e.detail ?? {}).length > 0 && (
                        <details>
                          <summary className="meta" style={{ cursor: 'pointer' }}>full detail</summary>
                          <pre className="meta" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{JSON.stringify(e.detail, null, 1)}</pre>
                        </details>
                      )}
                    </td>
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
