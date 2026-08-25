import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Empty, Notice, Skeleton, when } from '@makerbay/web-kit'
import { adminApi, explainAdmin, type TenantSummary } from '../api'

/**
 * The workspace directory doubling as a triage queue: health flags mark what
 * needs a look, and one omnibox does everything - an email address jumps
 * straight to its workspace, anything else filters the list. `/` focuses it.
 */
export default function Tenants() {
  const [tenants, setTenants] = useState<Array<TenantSummary & { flags?: string[] }> | null>(null)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const box = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void adminApi('GET', '/admin/v1/tenants')
      .then((r) => setTenants(r.tenants ?? []))
      .catch((e) => { setError(explainAdmin(e)); setTenants([]) })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault()
        box.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const needle = q.trim()
    if (!needle.includes('@') || busy) return
    setBusy(true); setError('')
    void adminApi('GET', `/admin/v1/lookup?email=${encodeURIComponent(needle)}`)
      .then((r) => {
        if (r.tenant?.tenantId) navigate(`/tenants/${r.tenant.tenantId}`)
        else setError('That user exists but has no workspace.')
      })
      .catch((e) => setError(explainAdmin(e)))
      .finally(() => setBusy(false))
  }

  const shown = useMemo(() => {
    if (!tenants) return []
    const needle = q.trim().toLowerCase()
    if (!needle || needle.includes('@')) return tenants
    return tenants.filter((t) =>
      [t.name, t.slug, t.tenantId, t.plan].some((v) => String(v).toLowerCase().includes(needle)),
    )
  }, [tenants, q])

  return (
    <>
      <h1>Workspaces</h1>
      <p>Every customer workspace. Type to filter — or type an email address and press Enter to jump straight to its workspace.</p>

      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card">
        <form onSubmit={submit}>
          <div className="row">
            <input ref={box} className="grow" value={q}
              placeholder="Filter by name, slug or id — or an email address ( / to focus )"
              onChange={(e) => setQ(e.target.value)} aria-label="Find a workspace" />
            {q.includes('@') && <button disabled={busy}>{busy ? 'Looking…' : 'Open workspace'}</button>}
            {tenants && !q.includes('@') && <span className="meta">{shown.length} of {tenants.length}</span>}
          </div>
        </form>

        {!tenants ? <div className="mt"><Skeleton rows={5} /></div> : shown.length === 0 ? (
          <Empty title={q ? 'Nothing matches that search' : 'No workspaces yet'}>
            {q ? 'Try a shorter search, or the workspace id.' : 'The first customer to sign up will appear here.'}
          </Empty>
        ) : (
          <div className="scroll-x mt">
            <table>
              <thead>
                <tr><th>Workspace</th><th>Plan</th><th>Subscription</th><th>Health</th><th>Created</th></tr>
              </thead>
              <tbody>
                {shown.map((t) => (
                  <tr key={t.tenantId} className="rowlink" onClick={() => navigate(`/tenants/${t.tenantId}`)}>
                    <td>
                      <strong>{t.name}</strong>
                      <div className="meta trunc">{t.slug} · {t.tenantId}</div>
                    </td>
                    <td><span className={`chip ${t.plan === 'pro' || t.plan === 'genie' ? 'ready' : 'dim'}`}>{t.plan}</span></td>
                    <td>
                      {t.subscriptionStatus === 'none'
                        ? <span className="meta">none</span>
                        : <span className={`chip ${t.subscriptionStatus === 'active' ? 'ready' : 'processing'}`}>{t.subscriptionStatus}</span>}
                    </td>
                    <td>
                      {(t.flags ?? []).length === 0
                        ? <span className="chip ready">ok</span>
                        : (t.flags ?? []).map((f) => <span key={f} className="chip warn" style={{ marginRight: 4 }}>{f}</span>)}
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
