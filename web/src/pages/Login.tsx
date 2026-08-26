import { useState, type FormEvent } from 'react'
import { confirmForgotPassword, confirmSignUp, forgotPassword, login, signUp } from '@makerbay/web-kit'

type Mode = 'login' | 'signup' | 'confirm' | 'forgot' | 'reset'

const HEADINGS: Record<Mode, string> = {
  login: 'Sign in',
  signup: 'Create your account',
  confirm: 'Check your email',
  forgot: 'Reset your password',
  reset: 'Check your email',
}

const BUTTONS: Record<Mode, string> = {
  login: 'Sign in',
  signup: 'Create account',
  confirm: 'Verify & sign in',
  forgot: 'Send reset code',
  reset: 'Set new password & sign in',
}

export default function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const go = (m: Mode) => { setMode(m); setError(''); setCode('') }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (mode === 'signup') {
        await signUp(email, password)
        setMode('confirm')
      } else if (mode === 'confirm') {
        await confirmSignUp(email, code)
        await login(email, password)
        onLoggedIn()
      } else if (mode === 'forgot') {
        await forgotPassword(email)
        setPassword('')
        setMode('reset')
      } else if (mode === 'reset') {
        await confirmForgotPassword(email, code, password)
        await login(email, password)
        onLoggedIn()
      } else {
        await login(email, password)
        onLoggedIn()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="logo">Maker<span>Bay</span></div>
        <p>Be found, answered and booked — without lifting a finger.</p>
        <div className="card">
          <h2>{HEADINGS[mode]}</h2>
          <form onSubmit={submit}>
            {(mode === 'login' || mode === 'signup' || mode === 'forgot') && (
              <>
                <label>Email</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
              </>
            )}
            {(mode === 'login' || mode === 'signup') && (
              <>
                <label>Password</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
              </>
            )}
            {mode === 'confirm' && (
              <>
                <p>We sent a verification code to <strong>{email}</strong>.</p>
                <label>Verification code</label>
                <input value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
              </>
            )}
            {mode === 'reset' && (
              <>
                <p>We sent a reset code to <strong>{email}</strong>.</p>
                <label>Reset code</label>
                <input value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
                <label>New password</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
              </>
            )}
            {error && <div className="error">{error}</div>}
            <div className="mt">
              <button disabled={busy}>{busy ? 'Working…' : BUTTONS[mode]}</button>
            </div>
          </form>
        </div>
        <p className="hint">
          {mode === 'login' ? (
            <>
              New to MakerBay? <a href="#" onClick={(e) => { e.preventDefault(); go('signup') }}>Create an account</a>
              {' · '}
              <a href="#" onClick={(e) => { e.preventDefault(); go('forgot') }}>Forgot password?</a>
            </>
          ) : (
            <a href="#" onClick={(e) => { e.preventDefault(); go('login') }}>Back to sign in</a>
          )}
        </p>
      </div>
    </div>
  )
}
