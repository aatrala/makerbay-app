import { useEffect, useRef, useState, type FormEvent } from 'react'
import QRCode from 'qrcode'
import {
  PASSWORD_RULES,
  completeMfaSetup,
  explainAuth,
  passwordProblem,
  setNewPassword,
  startSignIn,
  submitMfa,
  type AuthStep,
} from '../api'

/** The otpauth QR every authenticator app scans - typing 52 base32
 *  characters by hand is the alternative, and nobody should. */
function TotpQr({ email, secret }: { email: string; secret: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!ref.current || !secret) return
    const uri = `otpauth://totp/${encodeURIComponent('MakerBay Staff')}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent('MakerBay Staff')}`
    void QRCode.toCanvas(ref.current, uri, { width: 190, margin: 2 })
  }, [email, secret])
  if (!secret) return null
  return <canvas ref={ref} style={{ display: 'block', margin: '10px auto', borderRadius: 8 }} />
}

export default function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fresh, setFresh] = useState('')
  const [confirm, setConfirm] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<AuthStep | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<AuthStep>) => {
    setError(''); setBusy(true)
    try {
      const next = await fn()
      if (next.done) onSignedIn()
      else { setStep(next); setCode('') }
    } catch (e) {
      setError(explainAuth(e))
    } finally {
      setBusy(false)
    }
  }

  const restart = () => { setStep(null); setError(''); setFresh(''); setConfirm(''); setCode('') }

  const withPassword = (e: FormEvent) => {
    e.preventDefault()
    void run(() => startSignIn(email, password))
  }

  // A newly created account must replace its temporary password before it can
  // authenticate at all. The password is typed here and goes straight to
  // Cognito; nothing else ever sees it.
  const choosePassword = (e: FormEvent) => {
    e.preventDefault()
    const problem = passwordProblem(fresh)
    if (problem) return setError(problem)
    if (fresh !== confirm) return setError('Those two passwords do not match.')
    void run(async () => {
      const next = await setNewPassword(email, step!.session!, fresh)
      // Later steps sign in again, so remember what it is now.
      setPassword(fresh)
      return next
    })
  }

  const mfa = (e: FormEvent) => {
    e.preventDefault()
    void run(() =>
      step?.challenge === 'MFA_SETUP'
        ? completeMfaSetup(email, password, step.session!, code)
        : submitMfa(email, step!.session!, code),
    )
  }

  const challenge = step?.challenge

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="logo">Maker<span>Bay</span> staff</div>

        {!step && (
          <div className="card">
            <h2>Sign in</h2>
            <p>This console is for MakerBay staff. Everything you do here is recorded.</p>
            <form onSubmit={withPassword}>
              <label htmlFor="email">Email</label>
              <input id="email" type="email" autoComplete="username" value={email}
                onChange={(e) => setEmail(e.target.value)} required autoFocus />
              <label htmlFor="pw">Password</label>
              <input id="pw" type="password" autoComplete="current-password" value={password}
                onChange={(e) => setPassword(e.target.value)} required />
              {error && <div className="error">{error}</div>}
              <div className="mt"><button disabled={busy}>{busy ? 'Checking…' : 'Continue'}</button></div>
              <p className="meta mt">
                First time here? Sign in with the temporary password you were issued and you will be
                asked to choose a new one.
              </p>
            </form>
          </div>
        )}

        {challenge === 'NEW_PASSWORD_REQUIRED' && (
          <div className="card">
            <h2>Choose your password</h2>
            <p>
              That was a temporary password. Pick a permanent one now — it is sent straight to
              Cognito and stored nowhere else.
            </p>
            <form onSubmit={choosePassword}>
              <label htmlFor="new-pw">New password</label>
              <input id="new-pw" type="password" autoComplete="new-password" value={fresh}
                onChange={(e) => setFresh(e.target.value)} required autoFocus />
              <label htmlFor="confirm-pw">Confirm password</label>
              <input id="confirm-pw" type="password" autoComplete="new-password" value={confirm}
                onChange={(e) => setConfirm(e.target.value)} required />
              <p className="meta">{PASSWORD_RULES.describe}</p>
              {error && <div className="error">{error}</div>}
              <div className="mt row">
                <button disabled={busy || !fresh || !confirm}>{busy ? 'Saving…' : 'Set password'}</button>
                <button type="button" className="ghost" onClick={restart}>Start over</button>
              </div>
            </form>
          </div>
        )}

        {(challenge === 'MFA_SETUP' || challenge === 'SOFTWARE_TOKEN_MFA') && (
          <div className="card">
            <h2>{challenge === 'MFA_SETUP' ? 'Set up your authenticator' : 'Authenticator code'}</h2>
            {challenge === 'MFA_SETUP' ? (
              <>
                <p>
                  You do not need anything set up beforehand — this screen IS the setup. Install any
                  authenticator app (Google Authenticator, Microsoft Authenticator, Authy, or a
                  password manager like Bitwarden/1Password), scan this code with it, then enter the
                  six-digit code it shows. MFA is required on every staff account.
                </p>
                <TotpQr email={email} secret={step?.secretCode ?? ''} />
                <p className="meta">No camera? Add the secret by hand instead:</p>
                <pre className="code">{step?.secretCode}</pre>
              </>
            ) : (
              <p>Enter the six-digit code from your authenticator app.</p>
            )}
            <form onSubmit={mfa}>
              <label htmlFor="code">Code</label>
              <input id="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}"
                maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                required autoFocus />
              {error && <div className="error">{error}</div>}
              <div className="mt row">
                <button disabled={busy || code.length !== 6}>{busy ? 'Verifying…' : 'Sign in'}</button>
                <button type="button" className="ghost" onClick={restart}>Start over</button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
