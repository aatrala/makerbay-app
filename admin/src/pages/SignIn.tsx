import { useState, type FormEvent } from 'react'
import { completeMfaSetup, explainAdmin, startSignIn, submitMfa, type AuthStep } from '../api'

export default function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
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
      setError(explainAdmin(e))
    } finally {
      setBusy(false)
    }
  }

  const password_ = (e: FormEvent) => {
    e.preventDefault()
    void run(() => startSignIn(email, password))
  }

  const mfa = (e: FormEvent) => {
    e.preventDefault()
    void run(() =>
      step?.challenge === 'MFA_SETUP'
        ? completeMfaSetup(email, password, step.session!, code)
        : submitMfa(email, step!.session!, code),
    )
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="logo">Maker<span>Bay</span> staff</div>

        {!step ? (
          <div className="card">
            <h2>Sign in</h2>
            <p>This console is for MakerBay staff. Everything you do here is recorded.</p>
            <form onSubmit={password_}>
              <label htmlFor="email">Email</label>
              <input id="email" type="email" autoComplete="username" value={email}
                onChange={(e) => setEmail(e.target.value)} required autoFocus />
              <label htmlFor="pw">Password</label>
              <input id="pw" type="password" autoComplete="current-password" value={password}
                onChange={(e) => setPassword(e.target.value)} required />
              {error && <div className="error">{error}</div>}
              <div className="mt"><button disabled={busy}>{busy ? 'Checking…' : 'Continue'}</button></div>
            </form>
          </div>
        ) : (
          <div className="card">
            <h2>{step.challenge === 'MFA_SETUP' ? 'Set up your authenticator' : 'Authenticator code'}</h2>
            {step.challenge === 'MFA_SETUP' ? (
              <>
                <p>
                  Add this secret to your authenticator app, then enter the six-digit code it shows.
                  MFA is required on every staff account.
                </p>
                <pre className="code">{step.secretCode}</pre>
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
                <button type="button" className="ghost" onClick={() => { setStep(null); setError('') }}>Start over</button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
