import { useEffect, useState } from 'react'
import { api, resetBilling } from '../api'

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
  billingConfigured: boolean
  testMode: boolean | null
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

export default function Billing() {
  const [data, setData] = useState<Summary | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [resetMsg, setResetMsg] = useState('')

  useEffect(() => {
    api('GET', '/v1/core/billing/summary')
      .then(setData)
      .catch((e) => setError(e?.message === 'billing_not_configured' ? 'not_configured' : 'error'))
  }, [])

  const go = async (path: string) => {
    setBusy(true)
    setError('')
    try {
      const r = await api('POST', path, {})
      window.location.href = r.url
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error')
      setBusy(false)
    }
  }

  if (error === 'not_configured' || (data && !data.billingConfigured)) {
    return (
      <>
        <h1>Billing</h1>
        <div className="card">
          <h2>Billing isn't connected yet</h2>
          <p>Add your Stripe keys to the <code>makerbay/stripe</code> secret in AWS Secrets Manager, then reload this page. Until then everyone stays on the Free plan and nothing is charged.</p>
        </div>
      </>
    )
  }
  if (!data) return <p>{error ? 'Could not load billing.' : 'Loading…'}</p>

  const { plan, plans, usage, subscription, testMode } = data
  const pro = plans.find((p) => p.id === 'pro')!
  const onPro = plan.id === 'pro'
  const pct = Math.min(100, Math.round((usage.messages / Math.max(1, usage.includedMessages)) * 100))

  return (
    <>
      <h1>Billing</h1>
      <p>Your plan, what you've used this month, and what it will cost.</p>

      {testMode === false && (
        <div className="card" style={{ background: '#e9f9f1', borderColor: '#b5e5cf' }}>
          <strong>Live mode.</strong> Real cards are charged and real money moves.
        </div>
      )}

      {testMode && (
        <div className="card" style={{ background: '#fdf1d7', borderColor: '#eed9a5' }}>
          <strong>Stripe test mode.</strong> Checkout uses test cards — no real money moves. Use card 4242 4242 4242 4242 with any future expiry and CVC.
        </div>
      )}

      <div className="card">
        <h2>Current plan: {plan.name}</h2>
        <div className="row">
          <span className="grow">{usage.messages.toLocaleString()} of {usage.includedMessages.toLocaleString()} included messages</span>
          <span className="hint">{pct}%</span>
        </div>
        <div className="bar"><div style={{ width: `${pct}%` }} /></div>
        {usage.overageMessages > 0 && (
          <p className="hint mt">
            {usage.overageMessages.toLocaleString()} messages beyond your plan ·
            estimated additional charge <strong>{money(usage.estimatedOverageCents)}</strong>
          </p>
        )}
        {subscription.status !== 'none' && (
          <p className="hint mt">
            Subscription <strong>{subscription.status}</strong>
            {subscription.currentPeriodEnd && ` · renews ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`}
          </p>
        )}
      </div>

      {!onPro && (
        <div className="card">
          <h2>Upgrade to {pro.name}</h2>
          <p>
            {money(pro.monthlyPriceCents)} per month including {pro.includedMessages.toLocaleString()} messages,
            then {money(pro.overageCentsPerMessage)} per additional message. Cancel any time.
          </p>
          <button onClick={() => void go('/v1/core/billing/checkout')} disabled={busy}>
            {busy ? 'Opening Stripe…' : `Upgrade to ${pro.name}`}
          </button>
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
          Detaches this workspace from Stripe and returns it to the Free plan. Use it to clear
          stale test-mode details after switching keys. It does <strong>not</strong> cancel
          anything at Stripe — cancel in the billing portal first.
        </p>
        <button
          className="danger"
          onClick={async () => {
            setResetMsg('')
            try {
              const r = await resetBilling()
              setResetMsg(`Reset to ${r.plan}. Modules updated: ${r.modulesReset.join(', ') || 'none'}.`)
              setTimeout(() => window.location.reload(), 1200)
            } catch (e) {
              setResetMsg(
                e instanceof Error && e.message === 'subscription_active'
                  ? 'This workspace has an active subscription — cancel it in the billing portal first.'
                  : 'Reset failed.',
              )
            }
          }}
        >
          Reset billing link
        </button>
        {resetMsg && <p className="hint mt">{resetMsg}</p>}
      </div>

      {error && error !== 'not_configured' && <div className="error">Something went wrong: {error}</div>}
    </>
  )
}
