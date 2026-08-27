import { useEffect, useState, type FormEvent } from 'react'
import { Route } from 'react-router-dom'
import { api, explain, Notice, Skeleton, type DashboardModule, type Me } from '@makerbay/web-kit'

/**
 * "Set it up for me" - the review screen is the product.
 *
 * Two rules from docs/spec-concierge.md drive the whole layout. Seeing it is
 * the point, so the changes are shown as a field-level before-and-after built
 * on the server, never as prose an agent wrote about its own work. And the
 * page must say what it did NOT touch, because telling someone what you left
 * alone is how a change list stops feeling dangerous.
 */

interface DiffRow { field: string; label: string; from: string; to: string }
interface Artifact {
  sk: string
  diff: DiffRow[]
  provenance: Record<string, { url: string; excerpt: string }>
  status: 'staged' | 'applied' | 'rejected'
}
interface Job {
  jobId: string
  status: 'working' | 'ready' | 'confirmed' | 'released' | 'needs_you' | 'needs_person' | 'failed'
  plan: { sourceUrls: string[] }
  createdAt: string
}

/**
 * The $99 session is a booking in the MakerBay HQ workspace, taken through
 * the same booking and deposit flow any tradie's customer uses. That is the
 * whole reason it needs no payment code: MakerBay already knows how to sell a
 * booked slot. Set the service up once in the HQ workspace (45 minutes, $99,
 * deposit on) and this link sells it.
 */
const SESSION_URL = 'https://makerbay.app/p/makerbay-hq'

const JOBS: Array<{ kind: string; label: string; blurb: string; untouched: string[] }> = [
  {
    kind: 'presence.page',
    label: 'Your page',
    blurb: 'Headline, intro, phone, email and the areas you cover.',
    untouched: ['Headline', 'Intro', 'Phone', 'Email', 'Areas you cover'],
  },
  {
    kind: 'booking.services',
    label: 'Services and prices',
    blurb: 'The jobs you do and what they cost, added to your list.',
    untouched: ['Services'],
  },
  {
    kind: 'assistant.knowledge',
    label: 'What your assistant knows',
    blurb: 'Walks your whole site and adds the pages, so the assistant can answer from them.',
    untouched: ['Pages'],
  },
  {
    kind: 'help.centre',
    label: 'Your help centre',
    blurb: 'Switches it on and titles it, using your own words about the business.',
    untouched: ['Help centre', 'Title', 'Intro'],
  },
  {
    kind: 'quotes.documents',
    label: 'How your quotes look',
    blurb: 'A short prefix so your quotes read SP-Q-001 rather than Q-001.',
    untouched: ['Document prefix'],
  },
]

function SetupPage({ me }: { me: Me }) {
  const [url, setUrl] = useState('')
  const [kind, setKind] = useState(JOBS[0].kind)
  const [busy, setBusy] = useState(false)
  const [job, setJob] = useState<Job | null>(null)
  const [artifact, setArtifact] = useState<Artifact | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<Job[] | null>(null)
  const [showSource, setShowSource] = useState<string | null>(null)
  const [claiming, setClaiming] = useState(false)

  const refresh = () =>
    api('GET', '/v1/setup/jobs')
      .then((r) => setHistory(r.jobs ?? []))
      .catch(() => setHistory([]))

  useEffect(() => { void refresh() }, [])

  // Someone who built a draft on makerbay.app before signing up arrives here
  // with ?claim=<token>. Claiming stages it as an ordinary job they still have
  // to confirm - signing up is not consent to publish.
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('claim')
    if (!token) return
    // Take it out of the address bar immediately: it is a credential, and one
    // sitting in a URL gets pasted into support tickets and shared screens.
    window.history.replaceState({}, '', window.location.pathname)
    setClaiming(true)
    api('POST', '/v1/setup/claim', { token })
      .then((r) => {
        if (r.job) setJob(r.job)
        setNote(r.message ?? 'Brought over.')
        return api('GET', `/v1/setup/jobs/${r.job?.jobId}`)
      })
      .then((r) => { if (r?.artifacts?.[0]) setArtifact(r.artifacts[0]) })
      .catch((err) => setError(explain(err)))
      .finally(() => { setClaiming(false); void refresh() })
  }, [])

  const start = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError(null); setNote(null); setArtifact(null); setJob(null)
    try {
      const r = await api('POST', '/v1/setup/jobs', { url: url.trim(), kind })
      setJob(r.job)
      if (r.artifact) setArtifact(r.artifact)
      if (r.message) setNote(r.message)
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  const confirm = async () => {
    if (!job) return
    setBusy(true); setError(null)
    try {
      await api('POST', `/v1/setup/jobs/${job.jobId}/confirm`)
      setJob({ ...job, status: 'confirmed' })
      setArtifact(null)
      setNote('Done. Your page has it now, and you can change any of it yourself in Your page.')
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  const release = async () => {
    if (!job) return
    setBusy(true); setError(null)
    try {
      await api('POST', `/v1/setup/jobs/${job.jobId}/release`)
      setJob({ ...job, status: 'released' })
      setArtifact(null)
      setNote('Left alone. Nothing was changed on your page.')
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  const chosen = JOBS.find((j) => j.kind === kind) ?? JOBS[0]
  const changed = artifact?.diff.map((d) => d.label) ?? []
  const untouched = chosen.untouched.filter((f) => !changed.includes(f))

  return (
    <div className="stack">
      <div className="card">
        <h1>Set it up for me</h1>
        <p className="meta">
          Paste your website, your Facebook page or your Google listing, and we will build your
          page from it. Nothing goes live until you have read the changes and said yes.
        </p>
        <p className="meta">
          You can do all of this yourself in <a href="/page">Your page</a>, and it takes about ten
          minutes. This is the same job, done for you.
        </p>

        <div className="row mt" style={{ gap: 8, flexWrap: 'wrap' }}>
          {JOBS.map((j) => (
            <button
              key={j.kind}
              type="button"
              className={j.kind === kind ? 'chip on' : 'chip'}
              onClick={() => setKind(j.kind)}
              disabled={busy}
              aria-pressed={j.kind === kind}
            >
              {j.label}
            </button>
          ))}
        </div>
        <p className="meta">{chosen.blurb}</p>
        <p className="meta">
          Or <a href={SESSION_URL} target="_blank" rel="noopener">book 45 minutes with a person</a> for
          $99 and do it together on a call.
        </p>

        <form onSubmit={start} className="row mt" style={{ gap: 8 }}>
          <input
            className="grow"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={busy}
            placeholder="yourbusiness.com.au"
            aria-label="Your website, Facebook page or Google listing"
          />
          <button disabled={busy || url.trim().length < 4}>
            {busy ? 'Reading…' : `Do ${chosen.label.toLowerCase()}`}
          </button>
        </form>
        {error && <Notice tone="err">{error}</Notice>}
        {note && <Notice tone="ok">{note}</Notice>}
      </div>

      {claiming && (
        <div className="card">
          <h2>Bringing your draft over</h2>
          <Skeleton rows={2} />
          <p className="meta">
            The page you built before signing up. Nothing goes live until you have read it and said so.
          </p>
        </div>
      )}

      {busy && !artifact && (
        <div className="card">
          <h2>Reading {url}</h2>
          <Skeleton rows={3} />
          <p className="meta">
            This takes under a minute. We are reading the page, working out what it says about your
            business, and drafting the changes. Nothing is saved yet.
          </p>
        </div>
      )}

      {artifact && job?.status === 'ready' && (
        <div className="card">
          <h2>{artifact.diff.length} change{artifact.diff.length === 1 ? '' : 's'}, ready for you</h2>
          <p className="meta">
            Read from {job.plan.sourceUrls[0]}. Nothing is on your page yet.
          </p>

          <table className="mt">
            <thead>
              <tr><th>On your page</th><th>Now</th><th>We suggest</th><th /></tr>
            </thead>
            <tbody>
              {artifact.diff.map((d) => (
                <tr key={d.field}>
                  <td><strong>{d.label}</strong></td>
                  <td className="meta">{d.from}</td>
                  <td>{d.to}</td>
                  <td>
                    <button
                      type="button"
                      className="link"
                      onClick={() => setShowSource(showSource === d.field ? null : d.field)}
                    >
                      {showSource === d.field ? 'Hide source' : 'Where from?'}
                    </button>
                    {showSource === d.field && (
                      <p className="meta" style={{ maxWidth: '42ch', marginTop: 4 }}>
                        From {artifact.provenance[d.field]?.url}:
                        <br />
                        <em>{artifact.provenance[d.field]?.excerpt.slice(0, 200)}…</em>
                      </p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {untouched.length > 0 && (
            <p className="meta mt">
              <strong>Not changed:</strong> {untouched.join(', ').toLowerCase()}. Anything you have
              already written yourself is left exactly as it is.
            </p>
          )}

          <div className="row mt" style={{ gap: 8 }}>
            <button onClick={confirm} disabled={busy}>Looks right, use it</button>
            <button onClick={release} disabled={busy} className="secondary">Not right</button>
          </div>
          <p className="meta mt">
            If you use it and change your mind, Your page keeps every version and putting it back
            is one tap, on any plan.
          </p>
        </div>
      )}

      {job && (job.status === 'needs_you' || job.status === 'failed' || job.status === 'needs_person') && (
        <div className="card">
          <h2>Rather have someone do it with you?</h2>
          <p className="meta">
            Book 45 minutes and a person sets it up on your screen while you watch, including the
            parts that are not in MakerBay at all. $99, and it is refunded if we do not finish
            what we agreed.
          </p>
          <p>
            <a className="btn" href={SESSION_URL} target="_blank" rel="noopener">Book a time</a>
          </p>
        </div>
      )}

      <div className="card">
        <h2>Earlier</h2>
        {!history ? <Skeleton rows={2} /> : history.length === 0 ? (
          <p className="meta">Nothing yet. Your first one will show up here.</p>
        ) : (
          history.map((j) => (
            <div key={j.jobId} className="row" style={{ borderTop: '1px solid var(--line)', padding: '8px 0' }}>
              <span className="grow">
                {j.plan.sourceUrls[0]}
                <span className="meta"> · {new Date(j.createdAt).toLocaleDateString()}</span>
              </span>
              <span className={`chip ${j.status === 'confirmed' ? 'ok' : ''}`}>
                {j.status === 'confirmed' ? 'used'
                  : j.status === 'released' ? 'not used'
                  : j.status === 'needs_you' ? 'needs you'
                  : j.status}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export const setupDashboard: DashboardModule = {
  id: 'setup',
  label: 'Set it up for me',
  nav: [{ to: '/setup', label: 'Set it up for me' }],
  routes: ({ me }) => (
    <>
      <Route path="/setup" element={<SetupPage me={me} />} />
    </>
  ),
}

export default setupDashboard
