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

/** The staff audit trail: month-partitioned, append-only, read verbatim. */
export default function Audit() {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [entries, setEntries] = useState<Entry[] | null>(null)
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
          {entries && <span className="meta">{entries.length} entries</span>}
        </div>

        {!entries ? <div className="mt"><Skeleton rows={6} /></div> : entries.length === 0 ? (
          <Empty title="Nothing this month">Staff actions land here the moment they happen.</Empty>
        ) : (
          <div className="scroll-x mt">
            <table>
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Workspace</th><th>Detail</th></tr></thead>
              <tbody>
                {entries.map((e, i) => (
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
                    <td className="meta trunc" style={{ maxWidth: 360 }}>{JSON.stringify(e.detail)}</td>
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
