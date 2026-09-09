import { useCallback, useEffect, useState } from 'react'
import {
  AuthError,
  addPasskey,
  api,
  explain,
  hasPlatformAuthenticator,
  isOwner,
  listPasskeys,
  logout,
  Notice,
  passkeysPossible,
  removePasskey,
  renamePasskey,
  settlePasskeyOffer,
  thisDeviceName,
  when,
  type Me,
  type Passkey,
} from '@makerbay/web-kit'

/**
 * The person's own page (issue 158): how they sign in, whether they get the
 * workspace's notifications, and the way out.
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
        {passkeysPossible() && <Passkeys onNote={setNote} onError={setError} />}
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

/**
 * The devices that can sign in with a fingerprint, face or PIN (issue 158
 * part B1). "Passkeys" appears once, as the small heading, after the plain
 * sentence. Every add and remove also emails the account; the list here is
 * where a device nobody recognises gets removed.
 */
function Passkeys({ onNote, onError }: { onNote: (s: string) => void; onError: (s: string) => void }) {
  const [keys, setKeys] = useState<Passkey[] | null>(null)
  const [busy, setBusy] = useState('')
  const [canAdd, setCanAdd] = useState(false)

  const load = useCallback(async () => {
    try { setKeys(await listPasskeys()) } catch { setKeys([]) }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => { void hasPlatformAuthenticator().then(setCanAdd) }, [])

  const fail = (err: unknown) => {
    if (err instanceof AuthError && err.code === 'PASSKEY_CANCELLED') return
    if (err instanceof AuthError && (err.status === 403 || err.code === 'SESSION_NOT_FRESH')) {
      onError('For safety, changing how you sign in needs a recent sign-in. Sign out, sign back in, and try again.')
      return
    }
    onError(err instanceof Error ? err.message : 'Something went wrong.')
  }

  const add = async () => {
    setBusy('add'); onError(''); onNote('')
    try {
      const name = window.prompt('What should this device be called?', thisDeviceName())
      if (name === null) return
      await addPasskey(name.trim() || thisDeviceName())
      settlePasskeyOffer()
      onNote('Done. This device can sign in with its fingerprint, face or PIN from now on. We have emailed you to confirm.')
      await load()
    } catch (err) {
      fail(err)
    } finally {
      setBusy('')
    }
  }

  const rename = async (k: Passkey) => {
    const name = window.prompt('New name for this device', k.name ?? '')
    if (name === null || !name.trim()) return
    setBusy(k.id); onError('')
    try {
      await renamePasskey(k.id, name.trim())
      await load()
    } catch (err) {
      fail(err)
    } finally {
      setBusy('')
    }
  }

  const remove = async (k: Passkey) => {
    const label = k.name || 'this device'
    if (!window.confirm(`Remove ${label}? It will need an emailed code to sign in from now on.`)) return
    setBusy(k.id); onError(''); onNote('')
    try {
      await removePasskey(k.id)
      onNote(`${label} removed. We have emailed you to confirm.`)
      await load()
    } catch (err) {
      fail(err)
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="mt">
      <h3>Fingerprint and face sign-in</h3>
      <p className="meta">
        A device on this list can sign in with its fingerprint, face or PIN instead of a code.
        Remove any device you do not recognise. <span className="hint">(These are passkeys.)</span>
      </p>
      {keys === null ? (
        <p className="meta">Loading…</p>
      ) : keys.length === 0 ? (
        <p className="meta">No devices yet.</p>
      ) : (
        <ul className="plain">
          {keys.map((k) => (
            <li key={k.id} className="row baseline">
              <strong>{k.name || 'Unnamed device'}</strong>
              <span className="meta">added {when(k.createdAt)}{k.backedUp ? ', synced across your devices' : ''}</span>
              <span className="row">
                <button className="ghost" disabled={busy !== ''} onClick={() => void rename(k)}>Rename</button>
                <button className="ghost danger" disabled={busy !== ''} onClick={() => void remove(k)}>Remove</button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {canAdd ? (
        <button className="ghost mt-sm" disabled={busy !== ''} onClick={() => void add()}>
          {busy === 'add' ? 'Waiting for the device…' : keys && keys.length > 0 ? 'Add this device too' : 'Use this device’s fingerprint or face'}
        </button>
      ) : (
        <p className="meta">This device has no fingerprint, face or PIN sign-in built in, so it will keep using a code.</p>
      )}
    </div>
  )
}
