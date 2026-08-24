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
  webhook?: { lastAt: string | null; lastType: string | null; lastLive: boolean | null }
  connect?: { stripeAccountId: string | null; payoutsEnabled: boolean; onboardedAt: string | null }
  users?: Array<{ userId: string; email: string | null; role: string; createdAt: string }>
  moduleState?: {
    presence: { published: boolean; customDomain: string | null; domainStatus: string | null } | null
    assistant: { sourceCount: number | null }
  }
  entitlements: Record<string, { planTier: string; limits: Record<string, number>; sources?: string[] }>
  grants: Grant[]
  usage: Record<string, number>
}

const DAYS = [7, 14, 30, 90, 365]

/**
 * Read-only assistant conversations for "the AI answered wrong" tickets.
 * Loaded only on request and audited server-side on every view - reading
 * customer conversations is not a casual browse.
 */
function ConversationViewer({ tenantId }: { tenantId: string }) {
  const [sessions, setSessions] = useState<Array<{
    sessionId: string; count: number; lastAt: string; preview: string; thumbsDown: number
  }> | null>(null)
  const [open, setOpen] = useState<{ sessionId: string; messages: Array<{ role: string; text: string; feedback: string | null }> } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const loadList = () => {
    setBusy(true); setError('')
    void adminApi('GET', `/admin/v1/tenants/${tenantId}/conversations`)
      .then((r) => setSessions(r.sessions ?? []))
      .catch((e) => setError(explainAdmin(e)))
      .finally(() => setBusy(false))
  }
  const loadOne = (sessionId: string) => {
    setBusy(true); setError('')
    void adminApi('GET', `/admin/v1/tenants/${tenantId}/conversations?sessionId=${sessionId}`)
      .then((r) => setOpen({ sessionId, messages: r.messages ?? [] }))
      .catch((e) => setError(explainAdmin(e)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="card">
      <h2>Assistant conversations</h2>
      <p className="hint">
        Read-only, for wrong-answer tickets. Thumbs-down sessions sort first. Every view is
        written to the audit log.
      </p>
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}
      {!sessions ? (
        <button className="ghost" onClick={loadList} disabled={busy}>
          {busy ? 'Loading…' : 'Load recent conversations'}
        </button>
      ) : sessions.length === 0 ? (
        <p className="meta">No conversations in the recent window.</p>
      ) : (
        <div className="scroll-x">
          <table>
            <thead><tr><th>Last activity</th><th>Messages</th><th>Preview</th><th /></tr></thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.sessionId}>
                  <td className="nowrap">{s.lastAt ? when(s.lastAt) : '—'}</td>
                  <td className="nowrap">
                    {s.count}{s.thumbsDown > 0 && <span className="chip failed" style={{ marginLeft: 6 }}>{s.thumbsDown} 👎</span>}
                  </td>
                  <td className="meta trunc" style={{ maxWidth: 320 }}>{s.preview}</td>
                  <td className="nowrap">
                    <button className="ghost" disabled={busy} onClick={() => loadOne(s.sessionId)}>Read</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <div className="mt">
          <div className="row">
            <h2 className="grow" style={{ fontSize: 14 }}>Session <code>{open.sessionId.slice(0, 12)}…</code></h2>
            <button className="ghost" onClick={() => setOpen(null)}>Close</button>
          </div>
          {open.messages.map((m, i) => (
            <p key={i} style={{ margin: '6px 0' }}>
              <strong>{m.role === 'user' ? 'Customer' : 'Assistant'}:</strong>{' '}
              {m.text}
              {m.feedback === 'down' && <span className="chip failed" style={{ marginLeft: 6 }}>👎</span>}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

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

  const resetUser = (userId: string, email: string | null) => {
    const why = prompt(`Send ${email ?? userId} a password-reset code? Give a reason (10+ characters) — it goes in the audit log.`)
    if (why === null) return
    void run(async () => {
      await adminApi('POST', `/admin/v1/users/${userId}/reset-password`, { reason: why })
      setNote(`Cognito emailed ${email ?? 'the user'} a reset code.`)
    })
  }

  const suspend = (next: boolean) => {
    const why = prompt(next
      ? 'Suspend this workspace? Public pages disappear and every sign-in is refused. Reason (10+ characters):'
      : 'Reinstate this workspace? Reason (10+ characters):')
    if (why === null) return
    void run(async () => {
      const r = await adminApi('POST', `/admin/v1/tenants/${tenantId}/${next ? 'suspend' : 'unsuspend'}`, { reason: why })
      setNote(r.note ?? (next ? 'Suspended.' : 'Reinstated.'))
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

  const { tenant, webhook, connect, users, moduleState, entitlements, grants, usage } = data
  const moduleIds = Object.keys(entitlements)
  const isSuspended = tenant.status === 'suspended'

  return (
    <>
      <p className="meta"><Link to="/">← All workspaces</Link></p>
      <h1>{tenant.name}</h1>
      <p>{tenant.slug} · created {when(tenant.createdAt)}</p>

      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      {isSuspended && (
        <Notice tone="warn">
          <strong>Suspended.</strong> Public pages are hidden and sign-ins are refused.
        </Notice>
      )}

      <div className="card">
        <h2>Account</h2>
        <dl className="facts">
          <dt>Workspace id</dt><dd><code>{tenant.tenantId}</code></dd>
          <dt>Plan</dt><dd>{tenant.plan}</dd>
          <dt>Status</dt>
          <dd><span className={`chip ${isSuspended ? 'failed' : 'ready'}`}>{tenant.status}</span></dd>
          <dt>Subscription</dt>
          <dd>
            {tenant.subscriptionStatus}
            {tenant.currentPeriodEnd && ` · renews ${new Date(tenant.currentPeriodEnd).toLocaleDateString()}`}
          </dd>
          <dt>Stripe customer</dt>
          <dd>{tenant.stripeCustomerId ? <code>{tenant.stripeCustomerId}</code> : <span className="meta">none</span>}</dd>
          <dt>Stripe webhook</dt>
          <dd>
            {webhook?.lastAt
              ? <>{when(webhook.lastAt)} · {webhook.lastType}{webhook.lastLive !== null && ` · ${webhook.lastLive ? 'live' : 'test'} mode`}</>
              : <span className="meta">no events yet</span>}
          </dd>
          <dt>Get paid (Connect)</dt>
          <dd>
            {connect?.stripeAccountId
              ? <>
                  <code>{connect.stripeAccountId}</code>{' '}
                  <span className={`chip ${connect.payoutsEnabled ? 'ready' : 'processing'}`}>
                    {connect.payoutsEnabled ? 'payouts on' : 'onboarding incomplete'}
                  </span>
                </>
              : <span className="meta">not connected</span>}
          </dd>
          <dt>Public page</dt>
          <dd>
            {moduleState?.presence
              ? <>
                  {moduleState.presence.published ? 'published' : 'not published'}
                  {moduleState.presence.customDomain &&
                    <> · {moduleState.presence.customDomain} ({moduleState.presence.domainStatus ?? 'unknown'})</>}
                </>
              : <span className="meta">not set up</span>}
          </dd>
          <dt>Knowledge sources</dt>
          <dd>{moduleState?.assistant.sourceCount ?? <span className="meta">unknown</span>}</dd>
        </dl>
        <div className="mt">
          {isSuspended
            ? <button onClick={() => suspend(false)} disabled={busy}>Reinstate workspace</button>
            : <button className="danger" onClick={() => suspend(true)} disabled={busy}>Suspend workspace</button>}
        </div>
      </div>

      <div className="card">
        <h2>People</h2>
        {!users?.length ? <p className="meta">No users on this workspace.</p> : (
          <div className="scroll-x">
            <table>
              <thead><tr><th>Email</th><th>Role</th><th>Joined</th><th><span className="visually-hidden">Actions</span></th></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.userId}>
                    <td>{u.email ?? <code>{u.userId}</code>}</td>
                    <td>{u.role}</td>
                    <td className="nowrap">{when(u.createdAt)}</td>
                    <td className="nowrap">
                      <button className="ghost" disabled={busy} onClick={() => resetUser(u.userId, u.email)}>
                        Send password reset
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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

      <ConversationViewer tenantId={tenantId} />

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
