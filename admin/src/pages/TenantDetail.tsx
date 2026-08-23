import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Empty, Notice, Skeleton, when } from '@makerbay/web-kit'
import { adminApi, explainAdmin } from '../api'

interface Grant {
  sk: string
  source: string
  moduleId: string
  planTier: string
  status: string
  expiresAt: string | null
  reason: string | null
  grantedBy: string
  createdAt: string
}

interface Detail {
  tenant: {
    tenantId: string
    name: string
    slug: string
    plan: string
    status: string
    subscriptionStatus: string
    currentPeriodEnd: string | null
    stripeCustomerId: string | null
    createdAt: string
  }
  entitlements: Record<string, { planTier: string; limits: Record<string, number>; sources?: string[] }>
  grants: Grant[]
  usage: Record<string, number>
}

const DAYS = [7, 14, 30, 90, 365]

export default function TenantDetail() {
  const { tenantId = '' } = useParams()
  const [data, setData] = useState<Detail | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const [moduleId, setModuleId] = useState('assistant')
  const [planTier, setPlanTier] = useState('pro')
  const [days, setDays] = useState(30)
  const [never, setNever] = useState(false)
  const [reason, setReason] = useState('')

  const load = useCallback(async () => {
    try {
      setData(await adminApi('GET', `/admin/v1/tenants/${tenantId}`))
    } catch (e) {
      setError(explainAdmin(e))
    }
  }, [tenantId])

  useEffect(() => { void load() }, [load])

  const run = async (fn: () => Promise<void>) => {
    setError(''); setNote(''); setBusy(true)
    try { await fn(); await load() } catch (e) { setError(explainAdmin(e)) } finally { setBusy(false) }
  }

  const grant = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const r = await adminApi('POST', `/admin/v1/tenants/${tenantId}/grants`, {
        moduleId, planTier, reason, days, expiresAt: never ? 'never' : undefined,
      })
      setNote(
        `Granted ${r.grant.moduleId} at ${r.grant.planTier}, ` +
        `${r.grant.expiresAt === 'never' ? 'with no expiry' : `expiring ${new Date(r.grant.expiresAt).toLocaleDateString()}`}.`,
      )
      setReason('')
    })
  }

  const revoke = (g: Grant) => {
    const why = prompt(`Why are you revoking this ${g.moduleId} grant? At least 10 characters — it goes in the audit log.`)
    if (why === null) return
    void run(async () => {
      await adminApi('POST', `/admin/v1/tenants/${tenantId}/grants/revoke`, { sk: g.sk, reason: why })
      setNote(`Revoked the ${g.moduleId} grant.`)
    })
  }

  if (error && !data) return (
    <>
      <p className="meta"><Link to="/">← All workspaces</Link></p>
      <h1>Workspace</h1>
      <Notice tone="err">{error}</Notice>
    </>
  )

  if (!data) return (
    <>
      <p className="meta"><Link to="/">← All workspaces</Link></p>
      <h1>Workspace</h1>
      <div className="card"><Skeleton rows={6} /></div>
    </>
  )

  const { tenant, entitlements, grants, usage } = data
  const moduleIds = Object.keys(entitlements)

  return (
    <>
      <p className="meta"><Link to="/">← All workspaces</Link></p>
      <h1>{tenant.name}</h1>
      <p>{tenant.slug} · created {when(tenant.createdAt)}</p>

      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card">
        <h2>Account</h2>
        <dl className="facts">
          <dt>Workspace id</dt><dd><code>{tenant.tenantId}</code></dd>
          <dt>Plan</dt><dd>{tenant.plan}</dd>
          <dt>Status</dt><dd>{tenant.status}</dd>
          <dt>Subscription</dt>
          <dd>
            {tenant.subscriptionStatus}
            {tenant.currentPeriodEnd && ` · renews ${new Date(tenant.currentPeriodEnd).toLocaleDateString()}`}
          </dd>
          <dt>Stripe customer</dt>
          <dd>{tenant.stripeCustomerId ? <code>{tenant.stripeCustomerId}</code> : <span className="meta">none</span>}</dd>
        </dl>
      </div>

      <div className="card">
        <h2>Effective entitlements</h2>
        <p className="hint">What this workspace can actually do right now, after all grants are resolved.</p>
        <div className="scroll-x">
          <table>
            <thead><tr><th>Module</th><th>Tier</th><th>Limits</th></tr></thead>
            <tbody>
              {moduleIds.map((id) => (
                <tr key={id}>
                  <td>{id}</td>
                  <td><span className={`chip ${entitlements[id]?.planTier === 'pro' ? 'ready' : 'awaiting_upload'}`}>
                    {entitlements[id]?.planTier ?? '—'}
                  </span></td>
                  <td className="meta">
                    {Object.entries(entitlements[id]?.limits ?? {})
                      .map(([k, v]) => `${k}: ${Number(v).toLocaleString()}`)
                      .join(' · ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Grants</h2>
        {grants.length === 0 ? (
          <Empty title="No grants on this workspace">
            It is running on the free baseline. Grant a module below to give a pilot or a comp.
          </Empty>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr><th>Module</th><th>Tier</th><th>Source</th><th>Expires</th><th>Reason</th><th><span className="visually-hidden">Actions</span></th></tr>
              </thead>
              <tbody>
                {grants.map((g) => (
                  <tr key={g.sk}>
                    <td>{g.moduleId}</td>
                    <td>{g.planTier}</td>
                    <td>
                      <span className={`chip ${g.source === 'stripe' ? 'ready' : 'processing'}`}>{g.source}</span>
                      <div className="meta trunc">{g.grantedBy}</div>
                    </td>
                    <td className="nowrap">{g.expiresAt ? when(g.expiresAt) : 'never'}</td>
                    <td className="meta">{g.reason ?? '—'}</td>
                    <td className="nowrap">
                      {g.source === 'stripe'
                        ? <span className="meta">cancel in Stripe</span>
                        : <button className="danger" onClick={() => revoke(g)} disabled={busy}>Revoke</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Grant a module</h2>
        <p className="hint">
          For pilots, comps and support fixes. The reason is recorded against your staff account and
          cannot be edited afterwards.
        </p>
        <form onSubmit={grant}>
          <div className="row">
            <div className="grow">
              <label htmlFor="mod">Module</label>
              <select id="mod" value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
                {moduleIds.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </div>
            <div className="grow">
              <label htmlFor="tier">Tier</label>
              <select id="tier" value={planTier} onChange={(e) => setPlanTier(e.target.value)}>
                <option value="pro">pro</option>
                <option value="free">free</option>
              </select>
            </div>
            <div className="grow">
              <label htmlFor="days">Expires after</label>
              <select id="days" value={days} disabled={never} onChange={(e) => setDays(Number(e.target.value))}>
                {DAYS.map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
            </div>
          </div>

          <label className="pick mt">
            <input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} />
            <span>Never expires — a comp that never lapses is real money, so say so deliberately</span>
          </label>

          <label htmlFor="why">Reason</label>
          <input id="why" value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="Pilot for Acme Studio, agreed with them on 23 Aug" required minLength={10} />
          <p className="meta">{reason.trim().length}/10 characters minimum.</p>

          <div className="mt">
            <button disabled={busy || reason.trim().length < 10}>
              {busy ? 'Granting…' : 'Grant access'}
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <h2>Usage this month</h2>
        {Object.keys(usage).length === 0 ? <p className="meta">Nothing recorded yet.</p> : (
          <div className="scroll-x">
            <table>
              <thead><tr><th>Metric</th><th className="num">Quantity</th></tr></thead>
              <tbody>
                {Object.entries(usage).map(([k, v]) => (
                  <tr key={k}><td>{k}</td><td className="num">{Math.round(Number(v)).toLocaleString()}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
