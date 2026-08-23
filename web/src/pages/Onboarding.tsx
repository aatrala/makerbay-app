import { useState, type FormEvent } from 'react'
import { createTenant, enableModule, logout } from '../api'

export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await createTenant(name)
      await enableModule('assistant')
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="logo">Maker<span>Bay</span></div>
        <div className="card">
          <h2>Name your workspace</h2>
          <p>Usually your business name. Your AI assistant will be set up right away.</p>
          <form onSubmit={submit}>
            <label>Business name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="Acme Studio" />
            {error && <div className="error">{error}</div>}
            <div className="mt">
              <button disabled={busy}>{busy ? 'Setting up…' : 'Create workspace'}</button>
            </div>
          </form>
        </div>
        <p className="hint"><a href="#" onClick={(e) => { e.preventDefault(); logout() }}>Sign out</a></p>
      </div>
    </div>
  )
}
