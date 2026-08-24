import { useState } from 'react'
import { Notice } from '@makerbay/web-kit'
import { adminApi, explainAdmin } from '../api'

/**
 * Proves the SES setup works: verified domain, DKIM signing, config set, and
 * whether the account is still in the sandbox. Sends only to your own staff
 * address, so this can never become a way to mail arbitrary people.
 */
export default function Email({ staffEmail }: { staffEmail?: string }) {
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const send = () => {
    setResult(''); setError(''); setBusy(true)
    adminApi('POST', '/admin/v1/email/test', { to: staffEmail })
      .then((r) => setResult(`Sent from ${r.from} to ${r.sent}. Check the raw headers for a DKIM pass.`))
      .catch((e) => setError(explainAdmin(e)))
      .finally(() => setBusy(false))
  }

  return (
    <>
      <h1>Email</h1>
      <p>Transactional mail for Requests, Bookings and Quotes goes out through SES on this domain.</p>

      {result && <Notice tone="ok" onClose={() => setResult('')}>{result}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card">
        <h2>Send a test</h2>
        <p>
          Sends one message to <strong>{staffEmail ?? 'your staff address'}</strong>. Only your own
          address is accepted. If it fails, the account is almost certainly still in the SES
          sandbox.
        </p>
        <button onClick={send} disabled={busy || !staffEmail}>
          {busy ? 'Sending…' : 'Send test email'}
        </button>
      </div>

      <div className="card">
        <h2>Getting out of the sandbox</h2>
        <p>
          A new SES account can only send to addresses it has verified, and is capped at 200
          messages a day. Production access is a support request in the SES console under Account
          dashboard, and it is reviewed by a person — allow a day or two.
        </p>
        <p className="meta">
          Have ready: what the mail is for (appointment confirmations, quotes and enquiry replies),
          how recipients opted in (they are the customers of our customers, who asked for the
          service), and how bounces and complaints are handled.
        </p>
      </div>
    </>
  )
}
