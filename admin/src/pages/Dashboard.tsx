import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Notice, Skeleton, when } from '@makerbay/web-kit'
import { adminApi, explainAdmin } from '../api'

interface Overview {
  tenants: number
  signups7d: number
  activeSubscriptions: number
  suspended: number
  openTickets: number
  priorityTickets: number
  nearCap: Array<{ tenantId: string; name: string; metric: string; used: number; limit: number }>
  recentAudit: Array<{ ts: string; staffEmail: string; action: string; targetTenantId: string }>
}

/** The numbers a solo founder checks between jobs, on one screen. */
export default function Dashboard() {
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void adminApi('GET', '/admin/v1/overview')
      .then(setData)
      .catch((e) => setError(explainAdmin(e)))
  }, [])

  if (error) return <><h1>Overview</h1><Notice tone="err">{error}</Notice></>
  if (!data) return <><h1>Overview</h1><div className="card"><Skeleton rows={5} /></div></>

  return (
    <>
      <h1>Overview</h1>
      <p>How MakerBay is doing right now.</p>

      <div className="card">
        <div className="statrow">
          <div className="stat"><b>{data.tenants}</b><span>workspaces</span></div>
          <div className="stat"><b>{data.signups7d}</b><span>signups this week</span></div>
          <div className="stat"><b>{data.activeSubscriptions}</b><span>paying subscriptions</span></div>
          <div className="stat"><b>{data.openTickets}</b><span>open tickets{data.priorityTickets > 0 ? ` (${data.priorityTickets} priority)` : ''}</span></div>
          {data.suspended > 0 && <div className="stat"><b>{data.suspended}</b><span>suspended</span></div>}
        </div>
        <div className="row mt">
          <Link className="btn ghost" to="/tickets">Tickets</Link>
          <Link className="btn ghost" to="/tenants">Workspaces</Link>
        </div>
      </div>

      {data.nearCap.length > 0 && (
        <div className="card">
          <h2>Close to their cap</h2>
          <p className="hint">Worth a proactive email before they hit the wall.</p>
          {data.nearCap.map((n) => (
            <div className="row" key={n.tenantId} style={{ padding: '6px 0' }}>
              <Link to={`/tenants/${n.tenantId}`} className="grow">{n.name}</Link>
              <span className="meta">{n.used.toLocaleString()} / {n.limit.toLocaleString()} {n.metric}</span>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>Recent staff activity</h2>
        {data.recentAudit.length === 0 ? <p className="meta">Quiet month so far.</p> : (
          <div className="scroll-x">
            <table>
              <tbody>
                {data.recentAudit.map((e, i) => (
                  <tr key={i}>
                    <td className="nowrap meta">{when(e.ts)}</td>
                    <td className="nowrap">{e.action}</td>
                    <td>
                      {e.targetTenantId && e.targetTenantId !== '-'
                        ? <Link to={`/tenants/${e.targetTenantId}`}><code>{e.targetTenantId.slice(0, 10)}…</code></Link>
                        : <span className="meta">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="meta mt"><Link to="/audit">Full audit log →</Link></p>
      </div>
    </>
  )
}
