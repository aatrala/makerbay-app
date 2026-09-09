import { useState } from 'react'
import { api, explain, isOwner, logout, Notice, type Me } from '@makerbay/web-kit'

/**
 * The person's own page (issue 158): how they sign in, whether they get the
 * workspace's notifications, and the way out. Passkeys land here next.
 */
export default function AccountPage({ me, onChanged }: { me: Me; onChanged?: () => void }) {
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const owner = isOwner(me)

  const setNotify = async (notify: boolean) => {
    setBusy(true); setError(''); setNote('')
    try {
      await api('PATCH', `/v1/core/people/${me.user.userId}`, { notify })
      setNote(notify ? 'You will get the workspace notifications again.' : 'Notifications are off for you. The owner still gets them.')
      onChanged?.()
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  const leave = async () => {
    if (!window.confirm(`Leave ${me.tenant?.name ?? 'this workspace'}? You will lose access straight away. Anything you added stays with the business.`)) return
    setBusy(true); setError('')
    try {
      await api('POST', '/v1/core/me/leave', {})
      logout()
    } catch (err) {
      setError(explain(err))
      setBusy(false)
    }
  }

  return (
    <>
      <h1>Your account</h1>
      <p>How you sign in to MakerBay, and what you get told about.</p>
      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card">
        <h2>Signing in</h2>
        <p>
          You sign in as <strong>{me.user.email}</strong> with a six-digit code we email you. There is no
          password to remember. Nobody from MakerBay will ever phone, text or email you asking for a code.
        </p>
      </div>

      <div className="card">
        <h2>Notifications</h2>
        <p className="meta">
          New bookings, new enquiries, quotes accepted and payments received, by email.
        </p>
        <label className="row">
          <input type="checkbox" checked={me.user.notify !== false} disabled={busy}
            onChange={(e) => void setNotify(e.target.checked)} />
          <span>Email me about what happens in {me.tenant?.name ?? 'the workspace'}</span>
        </label>
      </div>

      {!owner && (
        <div className="card">
          <h2>Leave {me.tenant?.name ?? 'this workspace'}</h2>
          <p className="meta">
            You will lose access straight away. Quotes, notes and bookings you added stay with the business.
            You can create a workspace of your own afterwards.
          </p>
          <button className="ghost danger" disabled={busy} onClick={() => void leave()}>Leave workspace</button>
        </div>
      )}
    </>
  )
}
