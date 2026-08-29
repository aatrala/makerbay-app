import { useCallback, useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { getBillingSummary, getMe, isLoggedIn, type Me } from '@makerbay/web-kit'
import { enabledModules } from './modules'
import Login from './pages/Login'
import Onboarding from './pages/Onboarding'
import Shell from './pages/Shell'
import Billing from './pages/Billing'
import UsagePage from './pages/UsagePage'
import WorkspacePage from './pages/WorkspacePage'
import ActivityPage from './pages/ActivityPage'
import Support from './pages/Support'
import Home from './pages/Home'

export default function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(isLoggedIn())
  const [stripeMode, setStripeMode] = useState<'test' | 'live' | null>(null)

  const reload = useCallback(async () => {
    if (!isLoggedIn()) { setLoading(false); return }
    try {
      setMe(await getMe())
      // Owner-only; members simply get no badge.
      getBillingSummary()
        .then((b) => setStripeMode(b.billingConfigured ? (b.testMode ? 'test' : 'live') : null))
        .catch(() => setStripeMode(null))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  if (loading) return <div className="auth-wrap"><p>Loading…</p></div>

  if (!isLoggedIn()) return <Login onLoggedIn={() => { setLoading(true); void reload() }} />

  if (!me?.tenant) return <Onboarding onDone={() => { setLoading(true); void reload() }} />

  /*
   * Home is the front door, always (issues 74, 136).
   *
   * It began as a first-run setup checklist and reverted to a module once
   * that was done, which meant that from week two the dashboard opened on
   * whichever module happened to be registered first rather than on anything
   * that needed the owner. Home now leads with what is waiting - people to
   * reply to, today's diary, quotes out, invoices unpaid - and hides the
   * checklist once it is finished, so it stays worth landing on.
   */
  sessionStorage.removeItem('mb.justOnboarded')
  const landing = '/home'

  const modules = enabledModules(me)

  return (
    <Routes>
      <Route element={<Shell me={me} modules={modules} stripeMode={stripeMode} />}>
        <Route path="/" element={<Navigate to={landing} replace />} />
        <Route path="/home" element={<Home me={me} />} />
        {modules.map((m) => m.routes({ me }))}
        <Route path="/usage" element={<UsagePage me={me} />} />
        <Route path="/billing" element={<Billing />} />
        <Route path="/workspace" element={<WorkspacePage me={me} onSaved={() => void reload()} />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/support" element={<Support />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
