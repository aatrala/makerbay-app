import { useState } from 'react'
import { api, ApiError, explain, logout, type Invitation } from '@makerbay/web-kit'

/**
 * "Join Southside Plumbing?" (issue 158). Shown before anything else when
 * an invitation is waiting for the signed-in address - before Onboarding
 * for someone with no workspace, before the dashboard for someone with one.
 * No link brought them here; they typed the address, signed in, and this
 * was waiting, which is what the invitation email promised.
 */
export default function JoinPrompt({ invitations, onDone, onSkip }: {
  invitations: Invitation[]
  onDone: () => void
  onSkip: () => void
}) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [closeOffer, setCloseOffer] = useState<{ id: string; name: string; message: string; empty: boolean } | null>(null)
  const inv = invitations[0]

  const accept = async (closeExisting = false) => {
    setBusy('accept'); setError('')
    try {
      await api('POST', `/v1/core/me/invitations/${inv.invitationId}/accept`, closeExisting ? { closeExisting: true } : {})
      onDone()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'has_workspace') {
        // The server explains the situation in a sentence; the choice depends
        // on whether the workspace they already have is empty.
        const detail = (err as ApiError & { detail?: string }).detail ?? ''
        setCloseOffer({ id: inv.invitationId, name: inv.businessName, message: detail, empty: detail.startsWith('You have an empty workspace') })
      } else {
        setError(explain(err))
      }
    } finally {
      setBusy('')
    }
  }

  const decline = async () => {
    setBusy('decline'); setError('')
    try {
      await api('POST', `/v1/core/me/invitations/${inv.invitationId}/decline`, {})
      onSkip()
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="logo">Maker<span>Bay</span></div>
        <div className="card">
          <h2>Join {inv.businessName}?</h2>
          <p>
            {inv.inviterEmail ?? 'The owner'} has added you to <strong>{inv.businessName}</strong> on MakerBay.
            You will see their diary, enquiries, quotes and customers.
          </p>
          {closeOffer && (
            <div className="error" style={{ background: 'var(--warn-bg, #fff7ed)' }}>
              <p>{closeOffer.message}</p>
              {closeOffer.empty && (
                <button disabled={busy !== ''} onClick={() => void accept(true)}>
                  {busy === 'accept' ? 'Joining…' : `Close my empty workspace and join ${closeOffer.name}`}
                </button>
              )}
            </div>
          )}
          {error && <div className="error">{error}</div>}
          {!closeOffer && (
            <div className="row mt">
              <button disabled={busy !== ''} onClick={() => void accept()}>{busy === 'accept' ? 'Joining…' : 'Yes, join'}</button>
              <button className="ghost" disabled={busy !== ''} onClick={() => void decline()}>{busy === 'decline' ? '…' : 'No thanks'}</button>
            </div>
          )}
          {closeOffer && !closeOffer.empty && (
            <div className="row mt">
              <button className="ghost" onClick={onSkip}>Not now</button>
            </div>
          )}
        </div>
        <p className="meta center">
          Signed in as the invited address. <a href="#" onClick={(e) => { e.preventDefault(); logout() }}>Sign out</a>
        </p>
      </div>
    </div>
  )
}
