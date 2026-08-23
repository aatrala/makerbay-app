import { useState, type FormEvent } from 'react'
import { createTenant, enableModule, explain, logout } from '@makerbay/web-kit'

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
      // A brand-new workspace has nothing to answer from, so send the owner
      // to Knowledge rather than an empty Playground. App.tsx reads this.
      sessionStorage.setItem('mb.justOnboarded', '1')
      onDone()
    } catch (err) {
      setError(explain(err))
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="logo">Maker<span>Bay</span></div>
        <div className="card">
          <h2>Name your workspace</h2>
          <p>
            Usually your business name. We will switch on your AI assistant straight away —
            the next step is showing it your website so it can start answering.
          </p>
          <form onSubmit={submit}>
            <label htmlFor="biz">Business name</label>
            <input id="biz" value={name} onChange={(e) => setName(e.target.value)} required autoFocus
              placeholder="Acme Studio" />
            {error && <div className="error">{error}</div>}
            <div className="mt">
              <button disabled={busy}>{busy ? 'Setting up…' : 'Create workspace'}</button>
            </div>
          </form>
        </div>
        <p className="meta center">
          <a href="#" onClick={(e) => { e.preventDefault(); logout() }}>Sign out</a>
        </p>
      </div>
    </div>
  )
}
