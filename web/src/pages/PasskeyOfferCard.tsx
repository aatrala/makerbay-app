import { useEffect, useState } from 'react'
import {
  AuthError,
  addPasskey,
  declinePasskeyOffer,
  hasPlatformAuthenticator,
  listPasskeys,
  passkeyOfferPending,
  settlePasskeyOffer,
  thisDeviceName,
} from '@makerbay/web-kit'

/**
 * "Sign in with your fingerprint next time" (issue 158 part B1).
 *
 * Shown at the top of Home after a code sign-in, on a device that has a
 * fingerprint, face or PIN built in, for an account with no passkey yet.
 * Nothing is rendered until all three are known, so a device that cannot
 * do this never sees a card that will not work. "Not now" is remembered per
 * browser; the card comes back after the third code sign-in since.
 */
export default function PasskeyOfferCard() {
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!passkeyOfferPending()) return
    let alive = true
    void (async () => {
      if (!(await hasPlatformAuthenticator())) return
      try {
        const existing = await listPasskeys()
        if (existing.length > 0) { settlePasskeyOffer(); return }
      } catch {
        return
      }
      if (alive) setShow(true)
    })()
    return () => { alive = false }
  }, [])

  if (!show) return null

  const accept = async () => {
    setBusy(true); setError('')
    try {
      await addPasskey(thisDeviceName())
      settlePasskeyOffer()
      setSaved(true)
    } catch (err) {
      if (err instanceof AuthError && err.code === 'PASSKEY_CANCELLED') {
        setError('')
      } else if (err instanceof AuthError && err.code === 'PASSKEY_EXISTS') {
        settlePasskeyOffer()
        setSaved(true)
      } else {
        setError(err instanceof Error ? err.message : 'Something went wrong. You can set this up later under Your account.')
      }
    } finally {
      setBusy(false)
    }
  }

  const decline = () => {
    declinePasskeyOffer()
    setShow(false)
  }

  if (saved) {
    return (
      <div className="card tint-ok">
        <h2>Done. Next time, just your fingerprint.</h2>
        <p className="meta">
          This device can now sign in without a code. You can rename or remove it any time under Your account.
        </p>
        <button className="ghost" onClick={() => setShow(false)}>Close</button>
      </div>
    )
  }

  return (
    <div className="card">
      <h2>Sign in with your fingerprint next time</h2>
      <p>No code to wait for, on this device only. Your emailed code keeps working everywhere else.</p>
      {error && <div className="error">{error}</div>}
      <div className="row mt">
        <button disabled={busy} onClick={() => void accept()}>{busy ? 'Waiting for the device…' : 'Use fingerprint'}</button>
        <button className="ghost" disabled={busy} onClick={decline}>Not now</button>
      </div>
    </div>
  )
}
