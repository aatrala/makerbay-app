import { useEffect, useState } from 'react'
import { ApiError, api, explain, resetBilling, Notice, Skeleton, when } from '@makerbay/web-kit'

interface Plan {
  id: string
  name: string
  monthlyPriceCents: number
  includedMessages: number
  overageCentsPerMessage: number
}

interface Summary {
  plan: Plan
  plans: Plan[]
  usage: { messages: number; includedMessages: number; overageMessages: number; estimatedOverageCents: number }
  subscription: { status: string; currentPeriodEnd: string | null; hasCustomer: boolean }
  webhook: { lastAt: string | null; lastType: string | null; lastLive: boolean | null }
  billingConfigured: boolean
  testMode: boolean | null
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })

export default function Billing() {
  const [data, setData] = useState<Summary | null>(null)
  const [notConfigured, setNotConfigured] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [resetMsg, setResetMsg] = useState('')
  const [resetTone, setResetTone] = useState<'ok' | 'err'>('ok')

  useEffect(() => {
    api('GET', '/v1/core/billing/summary')
      .then(setData)
      .catch((e) => {
        if (e instanceof ApiError && e.code === 'billing_not_configured') setNotConfigured(true)
        else setError(explain(e))
      })
  }, [])

  const go = async (path: string, body: Record<string, unknown> = {}) => {
    setBusy(true)
    setError('')
    try {
      const r = await api('POST', path, body)
      window.location.href = r.url
    } catch (e) {
      setError(explain(e))
      setBusy(false)
    }
  }

  const reset = async () => {
    if (!confirm('Return this workspace to the Free plan and detach it from Stripe?')) return
    setResetMsg('')
    try {
      const r = await resetBilling()
      setResetTone('ok')
      setResetMsg(`Back on the ${r.plan} plan. Modules updated: ${r.modulesReset.join(', ') || 'none'}. Reloading…`)
      setTimeout(() => window.location.reload(), 1400)
    } catch (e) {
      setResetTone('err')
      setResetMsg(
        e instanceof ApiError && e.code === 'subscription_active'
          ? 'This workspace has an active subscription. Cancel it in the billing portal first, then reset.'
          : explain(e),
      )
    }
  }

  if (notConfigured || (data && !data.billingConfigured)) {
    return (
      <>
        <h1>Billing</h1>
        <div className="card">
          <h2>Billing is not connected yet</h2>
          <p>
            Everyone stays on the Free plan and nothing is charged. To switch it on, add your Stripe
            keys to the <code>makerbay/stripe</code> secret in AWS Secrets Manager and reload this page.
          </p>
        </div>
      </>
    )
  }

  if (error && !data) return (<><h1>Billing</h1><Notice tone="err">{error}</Notice></>)

  if (!data) return (
    <>
      <h1>Billing</h1>
      <p>Your plan, what you have used this month, and what it will cost.</p>
      <div className="card"><Skeleton rows={4} /></div>
    </>
  )

  const { plan, plans, usage, subscription, webhook, testMode } = data
  // A live workspace still hearing test-mode events has its webhook pointed
  // at the wrong endpoint, which is silent until an invoice goes missing.
  const modeMismatch = webhook.lastLive !== null && testMode !== null && webhook.lastLive === testMode
  const pro = plans.find((p) => p.id === 'pro')!
  const genie = plans.find((p) => p.id === 'genie')
  const onPro = plan.id === 'pro'
  const onGenie = plan.id === 'genie'
  const pct = Math.min(100, Math.round((usage.messages / Math.max(1, usage.includedMessages)) * 100))

  return (
    <>
      <h1>Billing</h1>
      <p>Your plan, what you have used this month, and what it will cost.</p>

      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      {testMode && (
        <Notice tone="warn">
          <strong>Stripe test mode.</strong> Checkout uses test cards — no real money moves.
          Use card 4242 4242 4242 4242 with any future expiry and CVC.
        </Notice>
      )}

      <div className="card">
        <h2>Current plan: {plan.name}</h2>
        <div className="row baseline">
          <span className="stat grow">
            {usage.messages.toLocaleString()}
            <span className="stat-of"> of {usage.includedMessages.toLocaleString()} included messages</span>
          </span>
          <span className="meta">{pct}% used</span>
        </div>
        <div className="bar"><div className={pct >= 90 ? 'over' : ''} style={{ width: `${pct}%` }} /></div>
        {usage.overageMessages > 0 && (
          <p className="hint mt">
            {usage.overageMessages.toLocaleString()} messages beyond your plan — estimated additional
            charge <strong>{money(usage.estimatedOverageCents)}</strong> on your next invoice.
          </p>
        )}
        {subscription.status !== 'none' && (
          <p className="meta mt">
            Subscription <strong>{subscription.status}</strong>
            {subscription.currentPeriodEnd && ` · renews ${day(subscription.currentPeriodEnd)}`}
          </p>
        )}
      </div>

      <div className="card">
        <h2>Connection to Stripe</h2>
        {webhook.lastAt ? (
          <>
            <p className="meta">
              Last update received {when(webhook.lastAt)}
              {webhook.lastType && ` · ${webhook.lastType}`}
              {webhook.lastLive !== null && ` · ${webhook.lastLive ? 'live' : 'test'} mode`}
            </p>
            {modeMismatch && (
              <Notice tone="warn">
                <strong>Your webhook is pointed at the wrong mode.</strong> This workspace is billing
                in {testMode ? 'test' : 'live'} mode, but the last event Stripe sent was
                {' '}{webhook.lastLive ? 'live' : 'test'} mode. Add a
                {' '}{testMode ? 'test' : 'live'}-mode endpoint in Stripe for
                {' '}<code>api.makerbay.app/v1/billing/webhook</code> and put its signing secret in
                the <code>makerbay/stripe</code> secret.
              </Notice>
            )}
          </>
        ) : (
          <p className="meta">
            Stripe has not sent a subscription event to this workspace yet. That is expected until
            someone subscribes. If a subscription exists and this still says nothing, the webhook
            endpoint is missing or its signing secret does not match.
          </p>
        )}
      </div>

      {!onPro && !onGenie && (
        <div className="card">
          <h2>Upgrade to {pro.name} — everything switched on</h2>
          <p>
            Unlimited bookings, review invites, quotes and invoices, your own domain, and{' '}
            {pro.includedMessages.toLocaleString()} assistant messages a month. Month to month,
            cancel any time.
          </p>
          <div className="row">
            <button onClick={() => void go('/v1/core/billing/checkout', { interval: 'month' })} disabled={busy}>
              {busy ? 'Opening Stripe…' : `${money(pro.monthlyPriceCents)} / month`}
            </button>
            <button className="ghost" onClick={() => void go('/v1/core/billing/checkout', { interval: 'year' })} disabled={busy}>
              {money(29000)} / year — 2 months free
            </button>
          </div>
          <p className="meta mt">
            Monthly includes pay-as-you-go beyond the message allowance at{' '}
            {money(pro.overageCentsPerMessage)} each. Annual pauses politely at the allowance
            instead — no surprise catch-up bills.
          </p>
        </div>
      )}

      {genie && !onGenie && (
        <div className="card">
          <h2>Upgrade to {genie.name} — your business, run from a conversation</h2>
          <p>
            Everything in Trade, plus Genie with 2,500 messages a month: briefings, answers with
            your real numbers, and actions — send a quote, chase an invoice, block out time —
            each behind a card only you can confirm. Month to month, cancel any time.
          </p>
          <button onClick={() => void go('/v1/core/billing/checkout', { plan: 'genie' })} disabled={busy}>
            {busy ? 'Opening Stripe…' : `${money(genie.monthlyPriceCents)} / month`}
          </button>
          <p className="meta mt">
            Every plan includes a Genie taster — 25 messages a month on Free, 250 on Trade — so
            you can try it before upgrading.
          </p>
        </div>
      )}

      {subscription.hasCustomer && (
        <div className="card">
          <h2>Manage billing</h2>
          <p>Update your card, download invoices, or cancel — handled securely by Stripe.</p>
          <button className="ghost" onClick={() => void go('/v1/core/billing/portal')} disabled={busy}>
            Open billing portal
          </button>
        </div>
      )}

      <div className="card">
        <h2>Reset billing link</h2>
        <p>
          Detaches this workspace from Stripe and returns it to the Free plan. Use it to clear stale
          test-mode details after switching keys. It does <strong>not</strong> cancel anything at
          Stripe — cancel in the billing portal first.
        </p>
        <button className="danger" onClick={() => void reset()}>Reset billing link</button>
        {resetMsg && <p className={resetTone === 'err' ? 'error' : 'hint mt'}>{resetMsg}</p>}
      </div>
    </>
  )
}
