import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { adminApi, isSignedIn, signOut } from './api'
import SignIn from './pages/SignIn'
import Tenants from './pages/Tenants'
import TenantDetail from './pages/TenantDetail'
import Email from './pages/Email'
import Audit from './pages/Audit'
import Platform from './pages/Platform'
import Dashboard from './pages/Dashboard'
import Tickets from './pages/Tickets'

interface Whoami {
  staff: { staffEmail?: string; staffSub: string }
  platform: string
  modules: string[]
}

export default function App() {
  const [who, setWho] = useState<Whoami | null>(null)
  const [checked, setChecked] = useState(!isSignedIn())
  const [acctOpen, setAcctOpen] = useState(false)
  const acctRef = useRef<HTMLDivElement>(null)
  const location = useLocation()

  useEffect(() => { setAcctOpen(false) }, [location.pathname])
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (acctRef.current && !acctRef.current.contains(e.target as Node)) setAcctOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const load = useCallback(async () => {
    if (!isSignedIn()) { setChecked(true); return }
    try { setWho(await adminApi('GET', '/admin/v1/whoami')) } finally { setChecked(true) }
  }, [])

  useEffect(() => { void load() }, [load])

  if (!checked) return <div className="auth-wrap"><p>Loading…</p></div>
  if (!isSignedIn()) return <SignIn onSignedIn={() => { setChecked(false); void load() }} />

  return (
    <div className="shell staff">
      <aside className="side">
        <div className="side-head">
          <div className="logo">Maker<span>Bay</span></div>
        </div>
        <div className="side-body">
          <nav>
            <div className="navlabel">Staff</div>
            <Link className={location.pathname === '/' ? 'active' : ''} to="/">Overview</Link>
            <Link className={location.pathname.startsWith('/tenants') ? 'active' : ''} to="/tenants">Workspaces</Link>
            <Link className={location.pathname === '/tickets' ? 'active' : ''} to="/tickets">Tickets</Link>
            <Link className={location.pathname === '/email' ? 'active' : ''} to="/email">Email</Link>
            <Link className={location.pathname === '/audit' ? 'active' : ''} to="/audit">Audit log</Link>
            <Link className={location.pathname === '/platform' ? 'active' : ''} to="/platform">Platform</Link>
          </nav>
          <div className="spacer" />
          <div className="modebadge staff">STAFF CONSOLE</div>
          <div className="account" ref={acctRef}>
            {acctOpen && (
              <div className="acct-pop">
                <a href="https://app.makerbay.app" target="_blank" rel="noopener">Customer app ↗</a>
                <a href="https://makerbay.app/changelog" target="_blank" rel="noopener">Changelog ↗</a>
                <div className="sep" />
                <button className="linkish" onClick={signOut}>Sign out</button>
                <span className="ver">platform v{who?.platform}</span>
              </div>
            )}
            <button className="acct-btn" aria-expanded={acctOpen} onClick={() => setAcctOpen(!acctOpen)}>
              <span className="av">{(who?.staff.staffEmail ?? '?').trim().charAt(0).toUpperCase()}</span>
              <span className="who">
                <strong>{who?.staff.staffEmail?.split('@')[0] ?? 'Staff'}</strong>
                <small>staff · owner</small>
              </span>
              <span className="chev">{acctOpen ? '▾' : '▴'}</span>
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/tenants" element={<Tenants />} />
          <Route path="/tenants/:tenantId" element={<TenantDetail />} />
          <Route path="/tickets" element={<Tickets />} />
          <Route path="/email" element={<Email staffEmail={who?.staff.staffEmail} />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/platform" element={<Platform />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
