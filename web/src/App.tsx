import { useCallback, useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { getBillingSummary, getMe, isLoggedIn, type Me } from './api'
import Login from './pages/Login'
import Onboarding from './pages/Onboarding'
import Shell from './pages/Shell'
import Knowledge from './pages/Knowledge'
import Behavior from './pages/Behavior'
import Playground from './pages/Playground'
import DeployPage from './pages/DeployPage'
import Conversations from './pages/Conversations'
import Insights from './pages/Insights'
import Billing from './pages/Billing'
import UsagePage from './pages/UsagePage'

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

  // A workspace created moments ago has no knowledge, so an empty Playground
  // would be the worst possible first screen. Send new owners to Knowledge.
  const fresh = sessionStorage.getItem('mb.justOnboarded') === '1'
  if (fresh) sessionStorage.removeItem('mb.justOnboarded')

  return (
    <Routes>
      <Route element={<Shell me={me} stripeMode={stripeMode} />}>
        <Route path="/" element={<Navigate to={fresh ? '/assistant/knowledge' : '/assistant/playground'} replace />} />
        <Route path="/assistant/knowledge" element={<Knowledge />} />
        <Route path="/assistant/behavior" element={<Behavior />} />
        <Route path="/assistant/playground" element={<Playground />} />
        <Route path="/assistant/deploy" element={<DeployPage me={me} />} />
        <Route path="/assistant/conversations" element={<Conversations />} />
        <Route path="/assistant/insights" element={<Insights />} />
        <Route path="/usage" element={<UsagePage me={me} />} />
        <Route path="/billing" element={<Billing />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
