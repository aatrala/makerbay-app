import { useState, type FormEvent } from 'react'
import {
  AuthError,
  authProvider,
  confirmForgotPassword,
  confirmSignUp,
  forgotPassword,
  login,
  sendCode,
  signInWithCode,
  signUp,
  startUpstreamSignIn,
} from '@makerbay/web-kit'

/**
 * Two sign-ins live here during the transition (issue 157). Which one a
 * browser gets is `authProvider()`: the code sign-in on Better Auth, or
 * the password sign-in on Cognito that every account was created with.
 * The wrapper is the only thing that knows there are two.
 */
export default function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  return authProvider() === 'better-auth'
    ? <CodeLogin onLoggedIn={onLoggedIn} />
    : <PasswordLogin onLoggedIn={onLoggedIn} />
}

function Frame({ heading, children, hint }: { heading: string; children: React.ReactNode; hint: React.ReactNode }) {
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="logo">Maker<span>Bay</span></div>
        <p>Be found, answered and booked — without lifting a finger.</p>
        <div className="card">
          <h2>{heading}</h2>
          {children}
        </div>
        <p className="hint">{hint}</p>
      </div>
    </div>
  )
}

// ── Better Auth: a code by email ─────────────────────────────────────────

function CodeLogin({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // The server's code picks the sentence; its message is the fallback.
  const fail = (err: unknown) =>
    setError(
      err instanceof AuthError
        ? explainAuth(err.code, err.message)
        : err instanceof Error ? explainAuth(err.message) : 'Something went wrong',
    )

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (step === 'email') {
        await sendCode(email)
        setStep('code')
      } else {
        await signInWithCode(email, code)
        onLoggedIn()
      }
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const usePassword = async () => {
    setError('')
    setBusy(true)
    try {
      await startUpstreamSignIn('cognito')
    } catch (err) {
      fail(err)
      setBusy(false)
    }
  }

  return (
    <Frame
      heading={step === 'email' ? 'Sign in or create your account' : 'Check your email'}
      hint={
        step === 'email' ? (
          <>
            Already have a MakerBay password?{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); void usePassword() }}>Sign in with it</a>
          </>
        ) : (
          <a href="#" onClick={(e) => { e.preventDefault(); setStep('email'); setCode(''); setError('') }}>Use a different email</a>
        )
      }
    >
      <form onSubmit={submit}>
        {step === 'email' ? (
          <>
            <p>We will email you a six-digit code. No password to remember.</p>
            <label>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus autoComplete="email" />
          </>
        ) : (
          <>
            <p>We sent a code to <strong>{email}</strong>. It works once and expires in ten minutes.</p>
            <label>Code</label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              required
              autoFocus
            />
          </>
        )}
        {error && <div className="error">{error}</div>}
        <div className="mt">
          <button disabled={busy || (step === 'code' && code.length !== 6)}>
            {busy ? 'Working…' : step === 'email' ? 'Email me a code' : 'Sign in'}
          </button>
        </div>
      </form>
    </Frame>
  )
}

/** Better Auth's error codes, as sentences. */
function explainAuth(code: string, message?: string): string {
  const map: Record<string, string> = {
    INVALID_OTP: 'That code is not right. Check the email and try again.',
    OTP_EXPIRED: 'That code has expired. Ask for a new one.',
    TOO_MANY_ATTEMPTS: 'Too many tries. Ask for a new code.',
    USER_NOT_FOUND: 'We could not find an account for that email.',
    http_429: 'Slow down a little - try again in a minute.',
    http_500: 'Our side had a problem sending the code. Try again in a moment.',
  }
  if (map[code]) return map[code]
  // A code-shaped string is never shown raw; a sentence from the server is.
  if (message && !/^[A-Z_]+$|^http_\d+$/.test(message)) return message
  return /^[A-Z_]+$|^http_\d+$/.test(code) ? 'Something went wrong. Try again.' : code
}

// ── Cognito: password ────────────────────────────────────────────────────

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

function PasswordLogin({ onLoggedIn }: { onLoggedIn: () => void }) {
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
    <Frame
      heading={HEADINGS[mode]}
      hint={
        mode === 'login' ? (
          <>
            New to MakerBay? <a href="#" onClick={(e) => { e.preventDefault(); go('signup') }}>Create an account</a>
            {' · '}
            <a href="#" onClick={(e) => { e.preventDefault(); go('forgot') }}>Forgot password?</a>
          </>
        ) : (
          <a href="#" onClick={(e) => { e.preventDefault(); go('login') }}>Back to sign in</a>
        )
      }
    >
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
    </Frame>
  )
}
