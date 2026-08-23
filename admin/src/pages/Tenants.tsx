import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Empty, Notice, Skeleton, when } from '@makerbay/web-kit'
import { adminApi, explainAdmin, type TenantSummary } from '../api'

export default function Tenants() {
  const [tenants, setTenants] = useState<TenantSummary[] | null>(null)
  const [q, setQ] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void adminApi('GET', '/admin/v1/tenants')
      .then((r) => setTenants(r.tenants ?? []))
      .catch((e) => { setError(explainAdmin(e)); setTenants([]) })
  }, [])

  const shown = useMemo(() => {
    if (!tenants) return []
    const needle = q.trim().toLowerCase()
    if (!needle) return tenants
    return tenants.filter((t) =>
      [t.name, t.slug, t.tenantId, t.plan].some((v) => String(v).toLowerCase().includes(needle)),
    )
  }, [tenants, q])

  return (
    <>
      <h1>Workspaces</h1>
      <p>Every customer workspace. Open one to see its entitlements and grant access.</p>

      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card">
        <div className="row">
          <input className="grow" placeholder="Search by name, slug or id" value={q}
            onChange={(e) => setQ(e.target.value)} aria-label="Search workspaces" />
          {tenants && <span className="meta">{shown.length} of {tenants.length}</span>}
        </div>

        {!tenants ? <div className="mt"><Skeleton rows={5} /></div> : shown.length === 0 ? (
          <Empty title={q ? 'Nothing matches that search' : 'No workspaces yet'}>
            {q ? 'Try a shorter search, or the workspace id.' : 'The first customer to sign up will appear here.'}
          </Empty>
        ) : (
          <div className="scroll-x mt">
            <table>
              <thead>
                <tr><th>Workspace</th><th>Plan</th><th>Subscription</th><th>Created</th></tr>
              </thead>
              <tbody>
                {shown.map((t) => (
                  <tr key={t.tenantId}>
                    <td>
                      <Link to={`/tenants/${t.tenantId}`}>{t.name}</Link>
                      <div className="meta trunc">{t.slug} · {t.tenantId}</div>
                    </td>
                    <td><span className={`chip ${t.plan === 'pro' ? 'ready' : 'awaiting_upload'}`}>{t.plan}</span></td>
                    <td>
                      {t.subscriptionStatus === 'none'
                        ? <span className="meta">none</span>
                        : <span className={`chip ${t.subscriptionStatus === 'active' ? 'ready' : 'processing'}`}>{t.subscriptionStatus}</span>}
                    </td>
                    <td className="nowrap">{when(t.createdAt)}</td>
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
