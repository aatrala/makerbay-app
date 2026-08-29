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
  entitlement: { planTier: string; overage: 'billed' | 'block'; sources: string[] }
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

  const [savingOverage, setSavingOverage] = useState(false)

  const setOverage = (on: boolean) => {
    setSavingOverage(true)
    void api('PATCH', '/v1/core/workspace', { overageOptIn: on })
      .then(() => api('GET', '/v1/core/billing/summary').then(setData))
      .catch((err) => setError(explain(err)))
      .finally(() => setSavingOverage(false))
  }

  useEffect(() => {
    api('GET', '/v1/core/billing/summary')
      .then(setData)
      .catch((e) => {
        if (e instanceof ApiError && e.code === 'billing_not_configured') setNotConfigured(true)
        else setError(explain(e))
      })
  }, [])

  // Coming BACK from Stripe with the browser's back button restores this
  // page from the back/forward cache exactly as it was left: buttons
  // disabled, still saying "Opening Stripe…" - forever (issue 55). A
  // bfcache restore fires pageshow with persisted=true; reset and reload.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return
      setBusy(false)
      void api('GET', '/v1/core/billing/summary').then(setData).catch(() => {})
    }
    window.addEventListener('pageshow', onShow)
    return () => window.removeEventListener('pageshow', onShow)
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

  const { plan, plans, usage, subscription, webhook, testMode, entitlement } = data
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
        {usage.overageMessages > 0 && entitlement?.overage === 'billed' && (
          <p className="hint mt">
            {usage.overageMessages.toLocaleString()} messages beyond your plan — estimated additional
            charge <strong>{money(usage.estimatedOverageCents)}</strong> on your next invoice.
          </p>
        )}
        {usage.overageMessages > 0 && entitlement?.overage !== 'billed' && (
          <p className="hint mt">
            You reached your included messages and we stopped there, as agreed. Nothing extra has
            been charged. Turn on pay-as-you-go below if you would rather keep going.
          </p>
        )}

        {/*
          * The opt-in the pricing page has always promised (issue 138).
          *
          * "$0.02 each, opt-in — the default is a polite stop" was on the page
          * while the code billed every paid workspace automatically. This is
          * the control that makes the sentence true, and it defaults to off.
          */}
        {entitlement?.planTier && entitlement.planTier !== 'free' && (
          <div className="card mt">
            <label className="pick">
              <input
                type="checkbox"
                checked={entitlement.overage === 'billed'}
                disabled={savingOverage}
                onChange={(e) => setOverage(e.target.checked)}
              />
              <span>
                <strong>Keep going past my included messages</strong>
                <br />
                <span className="meta">
                  {money(plan.overageCentsPerMessage)} per extra message, added to your next
                  invoice. Leave this off and we stop at your allowance and tell you — never a
                  surprise bill.
                </span>
              </span>
            </label>
          </div>
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
              {money(pro.monthlyPriceCents * 10)} / year — 2 months free
            </button>
          </div>
          <p className="meta mt">
            <strong>Founding offer:</strong> the first 100 workspaces pay $19/month, or
            $190/year — applied automatically at checkout whichever term you pick, and yours
            for as long as you stay.
          </p>
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
          <div className="row">
            <button onClick={() => void go('/v1/core/billing/checkout', { plan: 'genie', interval: 'month' })} disabled={busy}>
              {busy ? 'Opening Stripe…' : `${money(genie.monthlyPriceCents)} / month`}
            </button>
            {/* Genie was month-only on the reasoning that nobody should prepay
                a year of something new. It is now the same age as the rest,
                and a customer who wanted to commit could not (issue 145). */}
            <button className="ghost" onClick={() => void go('/v1/core/billing/checkout', { plan: 'genie', interval: 'year' })} disabled={busy}>
              {money(genie.monthlyPriceCents * 10)} / year — 2 months free
            </button>
          </div>
          <p className="meta mt">
            Every plan includes a Genie taster — 25 messages a month on Free, 250 on Trade — so
            you can try it before upgrading. Annual pauses politely at the allowance rather
            than billing beyond it, the same as Trade.
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
