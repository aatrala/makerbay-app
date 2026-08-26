import { useState, type FormEvent } from 'react'
import { createTenant, explain, logout } from '@makerbay/web-kit'

export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      // The server switches on every starter module (assistant, booking,
      // reviews) with the workspace - anything unwanted is one click off
      // under Workspace → Modules.
      await createTenant(name)
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
            Usually your business name. Your AI assistant, booking diary and review
            requests all start switched on — six small steps after this make them yours.
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
