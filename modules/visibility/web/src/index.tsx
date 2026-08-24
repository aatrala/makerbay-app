import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Route } from 'react-router-dom'
import {
  Notice,
  Skeleton,
  api,
  explain,
  type DashboardModule,
} from '@makerbay/web-kit'

interface VisibilityConfig {
  reviewLink: string
  autoAsk: boolean
  askMessage: string
  checklist: Record<string, boolean>
}

/**
 * The checklist is the product. Google Business Profile is the channel that
 * actually decides local discovery, it is verified against the business so we
 * can never do it for them - but we can make doing it right take twenty
 * minutes instead of never happening.
 */
const STEPS: Array<{ id: string; title: string; body: string }> = [
  {
    id: 'claim',
    title: 'Claim your Google Business Profile',
    body: 'Search your business name on Google. If a panel appears, click "Own this business?". If nothing appears, add it at google.com/business. Verification usually means a phone call or a postcard.',
  },
  {
    id: 'name',
    title: 'Use your exact business name - nothing added',
    body: 'The name on your profile must match your real trading name. Adding suburbs or keywords ("Joe\'s Electrical - Best Emergency Electrician Newtown") is against Google\'s rules and gets profiles suspended.',
  },
  {
    id: 'category',
    title: 'Pick the most specific category',
    body: '"Electrician" beats "Contractor". The primary category is the single strongest signal Google uses for who appears in the map results.',
  },
  {
    id: 'area',
    title: 'Set your service areas, hide your address',
    body: 'If customers come to you, show the address. If you go to them, hide it and list the same suburbs your page lists - a home address on a service business looks wrong to customers and to Google.',
  },
  {
    id: 'hours',
    title: 'Match your hours to your booking hours',
    body: 'Copy the hours you set in Bookings, exactly. Mismatched hours between your profile and your page is the kind of inconsistency that quietly hurts both.',
  },
  {
    id: 'phone',
    title: 'Use one phone number everywhere',
    body: 'The same number on your profile, your page and your van. Google checks consistency; customers check it too without knowing they are doing it.',
  },
  {
    id: 'photos',
    title: 'Add real photos',
    body: 'You at work, the van, finished jobs. Profiles with photos get dramatically more clicks, and stock photos are worse than none.',
  },
  {
    id: 'reviewlink',
    title: 'Get your review link',
    body: 'In your profile dashboard, find "Ask for reviews" and copy the short link (it starts with g.page/r/). Paste it below - it is what every review request we send will use.',
  },
]

function GetFound() {
  const [config, setConfig] = useState<VisibilityConfig | null>(null)
  const [presence, setPresence] = useState<{ phone?: string; areas?: string[] } | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await api('GET', '/v1/visibility/config')
      setConfig(r.config)
      // Their own entered data, surfaced so the checklist is copy-paste.
      const p = await api('GET', '/v1/presence/config').catch(() => null)
      if (p) setPresence({ phone: p.config.phone, areas: p.config.serviceAreas })
    } catch (e) {
      setError(explain(e))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const save = async (patch: Partial<VisibilityConfig>) => {
    setError(''); setBusy(true)
    try {
      const r = await api('PUT', '/v1/visibility/config', { ...config, ...patch })
      setConfig(r.config)
    } catch (e) {
      setError(explain(e))
    } finally {
      setBusy(false)
    }
  }

  const toggleStep = (id: string) => {
    if (!config) return
    void save({ checklist: { ...config.checklist, [id]: !config.checklist[id] } })
  }

  const saveSettings = (e: FormEvent) => {
    e.preventDefault()
    if (!config) return
    void save({ reviewLink: config.reviewLink, autoAsk: config.autoAsk, askMessage: config.askMessage })
      .then(() => setNote('Saved.'))
  }

  const done = config ? STEPS.filter((s) => config.checklist[s.id]).length : 0

  return (
    <>
      <h1>Get found</h1>
      <p>
        Your Google Business Profile is how local customers actually find you, and only you can own
        it. This gets it right in about twenty minutes, then asks your customers for reviews at the
        moment they are most likely to leave one.
      </p>

      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      {!config ? <div className="card"><Skeleton rows={6} /></div> : (
        <>
          <div className="card">
            <div className="row">
              <h2 className="grow">Set up your Google profile</h2>
              <span className="meta">{done} of {STEPS.length} done</span>
            </div>
            {presence?.phone || presence?.areas?.length ? (
              <p className="hint">
                For copy-paste: your number is <code>{presence.phone || 'not set'}</code>
                {presence.areas?.length ? <> and your areas are <code>{presence.areas.join(', ')}</code></> : null}
                {' '}(from Your page).
              </p>
            ) : null}
            <ol className="timeline mt">
              {STEPS.map((s) => (
                <li key={s.id}>
                  <label className="pick">
                    <input type="checkbox" checked={Boolean(config.checklist[s.id])}
                      onChange={() => toggleStep(s.id)} disabled={busy} />
                    <strong>{s.title}</strong>
                  </label>
                  <p className="meta">{s.body}</p>
                </li>
              ))}
            </ol>
            <p className="meta">
              We will never promise you a ranking - anyone who does is selling something. These
              steps are what actually moves the map results, and they compound with every review.
            </p>
          </div>

          <div className="card">
            <h2>Review requests</h2>
            <form onSubmit={saveSettings}>
              <label htmlFor="v-link">Your Google review link</label>
              <input id="v-link" value={config.reviewLink}
                onChange={(e) => setConfig({ ...config, reviewLink: e.target.value })}
                placeholder="https://g.page/r/..." />
              <p className="meta">From step 8 above. Every request we send uses this link.</p>

              <label className="pick">
                <input type="checkbox" checked={config.autoAsk}
                  onChange={(e) => setConfig({ ...config, autoAsk: e.target.checked })} />
                <span>Ask automatically when a booking is marked done</span>
              </label>
              <p className="meta">
                One email, once, right after the job - the moment they are most likely to say yes.
                Never a reminder barrage: nagging costs you the review and the customer.
              </p>

              <label htmlFor="v-msg">The message</label>
              <textarea id="v-msg" rows={3} value={config.askMessage}
                onChange={(e) => setConfig({ ...config, askMessage: e.target.value })} />

              <div className="mt"><button disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
            </form>
            <p className="meta mt">
              You can also ask one customer directly from their page in Contacts once a review link
              is saved.
            </p>
          </div>
        </>
      )}
    </>
  )
}

export const visibilityDashboard: DashboardModule = {
  id: 'visibility',
  label: 'Get found',
  nav: [{ to: '/get-found', label: 'Google & reviews' }],
  routes: () => (
    <>
      <Route path="/get-found" element={<GetFound />} />
    </>
  ),
}

export default visibilityDashboard
