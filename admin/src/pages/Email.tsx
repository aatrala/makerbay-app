import { useState } from 'react'
import { Notice } from '@makerbay/web-kit'
import { adminApi, explainAdmin } from '../api'

/**
 * Proves the active mail provider works: verified domain, DKIM signing, and
 * credentials in place. One provider is live per deploy - SES or Resend - and
 * the test tells you which. Sends only to your own staff address, so this can
 * never become a way to mail arbitrary people.
 */
export default function Email({ staffEmail }: { staffEmail?: string }) {
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [supEmail, setSupEmail] = useState('')
  const [sup, setSup] = useState<{
    email: string; provider?: string; suppressed: boolean; reason?: string; since?: string
  } | null>(null)

  const send = () => {
    setResult(''); setError(''); setBusy(true)
    adminApi('POST', '/admin/v1/email/test', { to: staffEmail })
      .then((r) => setResult(`Sent from ${r.from} to ${r.sent} through ${r.provider ?? 'the active provider'}. Check the raw headers for a DKIM pass.`))
      .catch((e) => setError(explainAdmin(e)))
      .finally(() => setBusy(false))
  }

  const lookup = () => {
    setError(''); setSup(null); setBusy(true)
    adminApi('GET', `/admin/v1/email/suppression?email=${encodeURIComponent(supEmail.trim())}`)
      .then(setSup)
      .catch((e) => setError(explainAdmin(e)))
      .finally(() => setBusy(false))
  }

  const unsuppress = () => {
    if (!sup?.suppressed) return
    if (!window.confirm(`Remove ${sup.email} from the suppression list? This is global across every workspace. If it bounces again it goes straight back on.`)) return
    setBusy(true); setError('')
    adminApi('DELETE', `/admin/v1/email/suppression/${encodeURIComponent(sup.email)}`)
      .then((r) => { setResult(`${r.removed} can receive mail again. ${r.note}`); setSup(null); setSupEmail('') })
      .catch((e) => setError(explainAdmin(e)))
      .finally(() => setBusy(false))
  }

  return (
    <>
      <h1>Email</h1>
      <p>
        Transactional mail for Requests, Bookings, Quotes and Reviews goes out through one provider
        per deploy: Resend today, with SES kept ready. Every message still passes through the same
        sender in core, so the suppression check, daily caps and bounce tracking are the same
        whichever is live.
      </p>

      {result && <Notice tone="ok" onClose={() => setResult('')}>{result}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card">
        <h2>Send a test</h2>
        <p>
          Sends one message to <strong>{staffEmail ?? 'your staff address'}</strong> through the
          active provider, bypassing the product's own sender so it proves the provider and nothing
          else. Only your own address is accepted. If it fails, the message says why: an unverified
          domain, a missing API key, or the SES sandbox.
        </p>
        <button onClick={send} disabled={busy || !staffEmail}>
          {busy ? 'Sending…' : 'Send test email'}
        </button>
      </div>

      <div className="card">
        <h2>Suppression list</h2>
        <p>
          "My customer never got the email" is usually this: one hard bounce and the provider
          suppresses the address until someone removes it. This is the provider's account-wide
          list, so removal is <strong>global across all workspaces</strong>. Per-workspace status
          lives on the contact and clears when the owner corrects the address. Both actions here are
          audited.
        </p>
        <div className="row">
          <input className="grow" type="email" placeholder="customer@example.com" value={supEmail}
            onChange={(e) => setSupEmail(e.target.value)} aria-label="Email to look up" />
          <button onClick={lookup} disabled={busy || !supEmail.includes('@')}>
            {busy ? 'Checking…' : 'Check'}
          </button>
        </div>
        {sup && (
          sup.suppressed ? (
            <div className="mt">
              <Notice tone="warn">
                <strong>{sup.email} is suppressed</strong>
                {sup.provider && <> by {sup.provider}</>}
                {sup.reason && <> — reason: {sup.reason.toLowerCase()}</>}
                {sup.since && <> since {new Date(sup.since).toLocaleDateString()}</>}.
                Mail to it is dropped before sending.
              </Notice>
              <button className="danger" onClick={unsuppress} disabled={busy}>Remove from suppression list</button>
            </div>
          ) : (
            <p className="mt"><span className="chip ready">not suppressed</span>{' '}
              <span className="meta">{sup.provider ?? 'The provider'} will attempt delivery to {sup.email}. If mail still fails, check the contact's status in the workspace and the recipient's spam folder.</span></p>
          )
        )}
      </div>

      <div className="card">
        <h2>Switching providers</h2>
        <p>
          The active provider is a constant in the CDK stack (<code>EMAIL_PROVIDER</code>), so a
          cutover is one edit and a deploy. Both domains are verified with both providers and the
          bounce pipeline understands both, so nothing else changes. SES stays in its sandbox until
          AWS grants production access; while it does, only Resend can reach a customer's inbox.
        </p>
      </div>
    </>
  )
}
