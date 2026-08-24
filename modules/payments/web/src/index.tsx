import { useCallback, useEffect, useState } from 'react'
import { Route, useSearchParams } from 'react-router-dom'
import {
  Empty,
  Notice,
  Skeleton,
  api,
  explain,
  when,
  type DashboardModule,
} from '@makerbay/web-kit'

interface ConnectState {
  connected: boolean
  payoutsEnabled: boolean
  detailsSubmitted?: boolean
  requirementsDue?: string[]
}

interface Payment {
  paymentId: string
  kind: 'invoice' | 'quote_deposit'
  refId: string
  amountCents: number
  currency: string
  status: 'pending' | 'paid' | 'refunded'
  description: string
  customerEmail?: string
  createdAt: string
  paidAt?: string
}

const cash = (cents: number, currency: string) => {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`
  }
}

const STATUS_CHIP: Record<string, string> = { pending: 'processing', paid: 'ready', refunded: 'failed' }

function PaymentsPage() {
  const [params] = useSearchParams()
  const [connect, setConnect] = useState<ConnectState | null>(null)
  const [payments, setPayments] = useState<Payment[] | null>(null)
  const [note, setNote] = useState(
    params.get('connect') === 'done' ? 'Welcome back from Stripe. Checking your account status…' : '',
  )
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setConnect(await api('GET', '/v1/payments/connect'))
      setPayments((await api('GET', '/v1/payments')).payments)
    } catch (e) { setError(explain(e)); setPayments([]) }
  }, [])
  useEffect(() => { void load() }, [load])

  const onboard = () =>
    void (async () => {
      setBusy(true); setError('')
      try {
        const r = await api('POST', '/v1/payments/connect', {})
        window.location.href = r.url
      } catch (e) { setError(explain(e)); setBusy(false) }
    })()

  const refund = (p: Payment) => {
    if (!window.confirm(`Refund ${cash(p.amountCents, p.currency)} to the customer? The money comes back out of your account.`)) return
    void (async () => {
      setBusy(true); setError(''); setNote('')
      try {
        await api('POST', `/v1/payments/${p.paymentId}/refund`, {})
        setNote('Refunded. It reaches the customer in a few business days.')
        await load()
      } catch (e) { setError(explain(e)) } finally { setBusy(false) }
    })()
  }

  return (
    <>
      <h1>Get paid</h1>
      <p>
        Card payment on your invoices and quote deposits, straight to your bank
        through Stripe. MakerBay never holds your money.
      </p>
      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card">
        <h2>Your Stripe account</h2>
        {!connect ? <Skeleton rows={2} /> : connect.payoutsEnabled ? (
          <>
            <p><span className="chip ready">Ready to take payments</span></p>
            <p className="meta mt">
              Pay buttons are live on your unpaid invoices, and on accepted quotes if you set a
              deposit percentage under Quotes settings. Payouts arrive on Stripe's schedule for
              your country.
            </p>
          </>
        ) : connect.connected ? (
          <>
            <p><span className="chip processing">Set-up not finished</span></p>
            {connect.requirementsDue && connect.requirementsDue.length > 0 && (
              <p className="meta">Stripe still needs: {connect.requirementsDue.slice(0, 4).join(', ')}{connect.requirementsDue.length > 4 ? '…' : ''}</p>
            )}
            <div className="row mt">
              <button onClick={onboard} disabled={busy}>{busy ? 'Opening Stripe…' : 'Continue set-up'}</button>
              <button className="ghost" onClick={() => void load()} disabled={busy}>Check again</button>
            </div>
          </>
        ) : (
          <>
            <p>
              Connect once and your invoices grow a Pay button. Stripe handles identity and bank
              checks; the money goes to your account, never through ours.
            </p>
            <div className="mt">
              <button onClick={onboard} disabled={busy}>{busy ? 'Opening Stripe…' : 'Connect with Stripe'}</button>
            </div>
            <p className="meta mt">Takes about five minutes. Stripe's standard processing fee applies; MakerBay adds nothing on top.</p>
          </>
        )}
      </div>

      <div className="card">
        <h2>Payments</h2>
        {!payments ? <Skeleton rows={3} /> : payments.length === 0 ? (
          <Empty title="No payments yet">
            Once your account is connected, every paid invoice and deposit lands here.
          </Empty>
        ) : (
          <div className="scroll-x">
            <table>
              <thead><tr><th>What</th><th>Who</th><th className="num">Amount</th><th>Status</th><th>When</th><th /></tr></thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.paymentId}>
                    <td>{p.description}</td>
                    <td>{p.customerEmail || <span className="meta">—</span>}</td>
                    <td className="num">{cash(p.amountCents, p.currency)}</td>
                    <td><span className={`chip ${STATUS_CHIP[p.status]}`}>{p.status}</span></td>
                    <td className="nowrap">{when(p.paidAt ?? p.createdAt)}</td>
                    <td className="nowrap">
                      {p.status === 'paid' && (
                        <button className="danger" disabled={busy} onClick={() => refund(p)}>Refund</button>
                      )}
                    </td>
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

export const paymentsDashboard: DashboardModule = {
  id: 'payments',
  label: 'Get paid',
  nav: [{ to: '/payments', label: 'Payments' }],
  routes: () => (
    <>
      <Route path="/payments" element={<PaymentsPage />} />
    </>
  ),
}

export default paymentsDashboard
