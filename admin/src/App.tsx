import { useCallback, useEffect, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { adminApi, isSignedIn, signOut } from './api'
import SignIn from './pages/SignIn'
import Tenants from './pages/Tenants'
import TenantDetail from './pages/TenantDetail'

interface Whoami {
  staff: { staffEmail?: string; staffSub: string }
  platform: string
  modules: string[]
}

export default function App() {
  const [who, setWho] = useState<Whoami | null>(null)
  const [checked, setChecked] = useState(!isSignedIn())
  const location = useLocation()

  const load = useCallback(async () => {
    if (!isSignedIn()) { setChecked(true); return }
    try { setWho(await adminApi('GET', '/admin/v1/whoami')) } finally { setChecked(true) }
  }, [])

  useEffect(() => { void load() }, [load])

  if (!checked) return <div className="auth-wrap"><p>Loading…</p></div>
  if (!isSignedIn()) return <SignIn onSignedIn={() => { setChecked(false); void load() }} />

  return (
    <div className="shell">
      <aside className="side">
        <div className="side-head">
          <div className="logo">Maker<span>Bay</span></div>
        </div>
        <div className="side-body">
          <nav>
            <div className="navlabel">Staff</div>
            <Link className={location.pathname === '/' ? 'active' : ''} to="/">Workspaces</Link>
          </nav>
          <div className="spacer" />
          <div className="modebadge staff">STAFF CONSOLE</div>
          <div className="whoami">
            <strong>{who?.staff.staffEmail ?? 'Staff'}</strong>
            <span>platform {who?.platform}</span>
            <button className="linkish" onClick={signOut}>Sign out</button>
          </div>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Tenants />} />
          <Route path="/tenants/:tenantId" element={<TenantDetail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
