import { useState, type FormEvent } from 'react'
import { confirmSignUp, login, signUp } from '@makerbay/web-kit'

type Mode = 'login' | 'signup' | 'confirm'

export default function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

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
        <p>Modular business tools for SMBs.</p>
        <div className="card">
          <h2>
            {mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create your account' : 'Check your email'}
          </h2>
          <form onSubmit={submit}>
            {mode !== 'confirm' && (
              <>
                <label>Email</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
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
            {error && <div className="error">{error}</div>}
            <div className="mt">
              <button disabled={busy}>
                {busy ? 'Working…' : mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Verify & sign in'}
              </button>
            </div>
          </form>
        </div>
        <p className="hint">
          {mode === 'login' ? (
            <>New to MakerBay? <a href="#" onClick={(e) => { e.preventDefault(); setMode('signup'); setError('') }}>Create an account</a></>
          ) : (
            <a href="#" onClick={(e) => { e.preventDefault(); setMode('login'); setError('') }}>Back to sign in</a>
          )}
        </p>
      </div>
    </div>
  )
}
