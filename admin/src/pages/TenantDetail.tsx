import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
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

/** Metric → [module, limit key]: which cap a usage number counts against. */
const METRIC_LIMIT: Record<string, [string, string]> = {
  'assistant.message': ['assistant', 'messagesPerMonth'],
  'booking.created': ['booking', 'bookingsPerMonth'],
  'reviews.invited': ['reviews', 'reviewsPerMonth'],
  'genie.message': ['genie', 'genieMessagesPerMonth'],
}

/**
 * An action that needs a written reason: click expands an inline panel with
 * the reason input right where the action lives - no browser prompt().
 */
function ReasonAction({ label, danger, hint, busy, onConfirm }: {
  label: string
  danger?: boolean
  hint: string
  busy: boolean
  onConfirm: (reason: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (reason.trim().length < 10) return
    onConfirm(reason.trim())
    setOpen(false); setReason('')
  }
  if (!open) {
    return <button className={danger ? 'danger' : 'ghost'} disabled={busy} onClick={() => setOpen(true)}>{label}</button>
  }
  return (
    <form onSubmit={submit} className="reason-panel" style={{ minWidth: 280 }}>
      <p className="meta" style={{ marginBottom: 6 }}>{hint}</p>
      <div className="row">
        <input className="grow" autoFocus value={reason} minLength={10} required
          placeholder="Reason (10+ characters, goes in the audit log)"
          onChange={(e) => setReason(e.target.value)} aria-label={`Reason for ${label}`} />
        <button className={danger ? 'danger' : undefined} disabled={busy || reason.trim().length < 10}>
          {label}
        </button>
        <button type="button" className="ghost" onClick={() => { setOpen(false); setReason('') }}>Cancel</button>
      </div>
    </form>
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

  if (error && !data) return (
    <>
      <p className="meta"><Link to="/tenants">← All workspaces</Link></p>
      <h1>Workspace</h1>
      <Notice tone="err">{error}</Notice>
    </>
  )

  if (!data) return (
    <>
      <p className="meta"><Link to="/tenants">← All workspaces</Link></p>
      <h1>Workspace</h1>
      <div className="card"><Skeleton rows={6} /></div>
    </>
  )

  const { tenant, webhook, connect, users, moduleState, entitlements, grants, usage } = data
  const moduleIds = Object.keys(entitlements)
  const isSuspended = tenant.status === 'suspended'

  const funnel: Array<{ label: string; done: boolean }> = [
    { label: 'Account created', done: true },
    { label: 'Page published', done: Boolean(moduleState?.presence?.published) },
    { label: 'Knowledge added', done: (moduleState?.assistant.sourceCount ?? 0) > 0 },
    { label: 'Stripe connected', done: Boolean(connect?.payoutsEnabled) },
    { label: 'First usage', done: Object.keys(usage).length > 0 },
  ]

  const card = (title: string, children: ReactNode) => (
    <div className="card"><h2>{title}</h2>{children}</div>
  )

  return (
    <>
      <p className="meta"><Link to="/tenants">← All workspaces</Link></p>

      <div className="pagehead">
        <h1>{tenant.name}</h1>
        <span className={`chip ${isSuspended ? 'failed' : 'ready'}`}>{tenant.status}</span>
        <span className={`chip ${tenant.plan === 'free' ? 'dim' : 'ready'}`}>{tenant.plan}</span>
        {funnel.every((f) => f.done)
          ? <span className="chip ready">fully onboarded</span>
          : <span className="chip warn">{funnel.filter((f) => f.done).length}/{funnel.length} onboarded</span>}
        <span className="spacer" />
        <ReasonAction
          label={isSuspended ? 'Reinstate' : 'Suspend'}
          danger={!isSuspended}
          busy={busy}
          hint={isSuspended
            ? 'Reinstate: public pages return immediately, sign-ins as caches expire.'
            : 'Suspend: public pages disappear and every sign-in is refused.'}
          onConfirm={(why) => void run(async () => {
            const r = await adminApi('POST', `/admin/v1/tenants/${tenantId}/${isSuspended ? 'unsuspend' : 'suspend'}`, { reason: why })
            setNote(r.note ?? 'Done.')
          })}
        />
        <ReasonAction
          label="Add note"
          busy={busy}
          hint="A note on the audit trail - use it when something was changed outside the console."
          onConfirm={(text) => void run(async () => {
            await adminApi('POST', `/admin/v1/tenants/${tenantId}/note`, { text })
            setNote('Noted on the audit trail.')
          })}
        />
      </div>
      <p className="meta">{tenant.slug} · created {when(tenant.createdAt)} · <code>{tenant.tenantId}</code></p>

      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}
      {isSuspended && (
        <Notice tone="warn"><strong>Suspended.</strong> Public pages are hidden and sign-ins are refused.</Notice>
      )}

      <div className="grid2">
        {card('Billing & payments', (
          <dl className="facts">
            <dt>Subscription</dt>
            <dd>
              {tenant.subscriptionStatus}
              {tenant.currentPeriodEnd && ` · renews ${new Date(tenant.currentPeriodEnd).toLocaleDateString()}`}
            </dd>
            <dt>Stripe customer</dt>
            <dd>
              {tenant.stripeCustomerId
                ? <a href={`https://dashboard.stripe.com/customers/${tenant.stripeCustomerId}`} target="_blank" rel="noopener"><code>{tenant.stripeCustomerId}</code> ↗</a>
                : <span className="meta">none</span>}
            </dd>
            <dt>Webhook</dt>
            <dd>
              {webhook?.lastAt
                ? <>{when(webhook.lastAt)} · {webhook.lastType}{webhook.lastLive !== null && ` · ${webhook.lastLive ? 'live' : 'test'}`}</>
                : <span className="meta">no events yet</span>}
            </dd>
            <dt>Get paid (Connect)</dt>
            <dd>
              {connect?.stripeAccountId
                ? <>
                    <a href={`https://dashboard.stripe.com/connect/accounts/${connect.stripeAccountId}`} target="_blank" rel="noopener"><code>{connect.stripeAccountId}</code> ↗</a>{' '}
                    <span className={`chip ${connect.payoutsEnabled ? 'ready' : 'warn'}`}>
                      {connect.payoutsEnabled ? 'payouts on' : 'onboarding incomplete'}
                    </span>
                  </>
                : <span className="meta">not connected</span>}
            </dd>
          </dl>
        ))}

        {card('Onboarding & page', (
          <>
            <ul className="checklist">
              {funnel.map((f) => (
                <li key={f.label}>{f.done ? '✅' : '⬜'} {f.label}</li>
              ))}
            </ul>
            <dl className="facts mt">
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
          </>
        ))}
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
                    <td>
                      <ReasonAction label="Send password reset" busy={busy}
                        hint={`Cognito emails ${u.email ?? 'the user'} a reset code - staff never see a password.`}
                        onConfirm={(why) => void run(async () => {
                          await adminApi('POST', `/admin/v1/users/${u.userId}/reset-password`, { reason: why })
                          setNote(`Cognito emailed ${u.email ?? 'the user'} a reset code.`)
                        })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Usage this month</h2>
        {Object.keys(usage).length === 0 ? <p className="meta">Nothing recorded yet.</p> : (
          <div className="scroll-x">
            <table>
              <thead><tr><th>Metric</th><th className="num">Used</th><th style={{ width: '40%' }}>Against limit</th></tr></thead>
              <tbody>
                {Object.entries(usage).map(([k, v]) => {
                  const map = METRIC_LIMIT[k]
                  const limit = map ? entitlements[map[0]]?.limits?.[map[1]] : undefined
                  const pct = limit ? Math.min(100, Math.round((Number(v) / limit) * 100)) : null
                  return (
                    <tr key={k}>
                      <td>{k}</td>
                      <td className="num">{Math.round(Number(v)).toLocaleString()}{limit ? ` / ${limit.toLocaleString()}` : ''}</td>
                      <td>
                        {pct === null ? <span className="meta">uncapped</span> : (
                          <div className="bar"><div className={pct >= 80 ? 'over' : ''} style={{ width: `${pct}%` }} /></div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid2">
        {card('Effective entitlements', (
          <div className="scroll-x">
            <table>
              <thead><tr><th>Module</th><th>Tier</th><th>Limits</th></tr></thead>
              <tbody>
                {moduleIds.map((id) => (
                  <tr key={id}>
                    <td>{id}</td>
                    <td><span className={`chip ${entitlements[id]?.planTier === 'pro' ? 'ready' : 'dim'}`}>
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
        ))}

        {card('Grants', grants.length === 0 ? (
          <Empty title="No grants on this workspace">
            It is running on the free baseline. Grant a module below to give a pilot or a comp.
          </Empty>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr><th>Module</th><th>Tier</th><th>Source</th><th>Expires</th><th><span className="visually-hidden">Actions</span></th></tr>
              </thead>
              <tbody>
                {grants.map((g) => (
                  <tr key={g.sk}>
                    <td>{g.moduleId}<div className="meta trunc" style={{ maxWidth: 140 }}>{g.reason ?? ''}</div></td>
                    <td>{g.planTier}</td>
                    <td><span className={`chip ${g.source === 'stripe' ? 'ready' : 'processing'}`}>{g.source}</span></td>
                    <td className="nowrap">{g.expiresAt ? when(g.expiresAt) : 'never'}</td>
                    <td>
                      {g.source === 'stripe'
                        ? <span className="meta">cancel in Stripe</span>
                        : <ReasonAction label="Revoke" danger busy={busy}
                            hint={`Revoking the ${g.moduleId} grant takes their access with it.`}
                            onConfirm={(why) => void run(async () => {
                              await adminApi('POST', `/admin/v1/tenants/${tenantId}/grants/revoke`, { sk: g.sk, reason: why })
                              setNote(`Revoked the ${g.moduleId} grant.`)
                            })} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
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
    </>
  )
}

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
