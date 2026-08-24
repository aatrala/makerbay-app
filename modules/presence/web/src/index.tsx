import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, Route } from 'react-router-dom'
import {
  Notice,
  Skeleton,
  api,
  explain,
  type DashboardModule,
} from '@makerbay/web-kit'

interface PresenceConfig {
  headline: string
  intro: string
  serviceAreas: string[]
  phone: string
  email: string
  photoKey?: string
  showBooking: boolean
  showAssistant: boolean
  published: boolean
  websiteUrl?: string
}

interface Indexing {
  directive: 'index' | 'noindex'
  complete: boolean
  missing: string[]
  ownSite: boolean
}

function PagePage() {
  const [config, setConfig] = useState<PresenceConfig | null>(null)
  const [indexing, setIndexing] = useState<Indexing | null>(null)
  const [pageUrl, setPageUrl] = useState('')
  const [areas, setAreas] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      const r = await api('GET', '/v1/presence/config')
      setConfig(r.config)
      setIndexing(r.indexing)
      setPageUrl(r.pageUrl)
      setAreas((r.config.serviceAreas ?? []).join(', '))
    } catch (e) {
      setError(explain(e))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const run = async (fn: () => Promise<void>) => {
    setError(''); setNote(''); setBusy(true)
    try { await fn() } catch (e) { setError(explain(e)) } finally { setBusy(false) }
  }

  const save = (e: FormEvent) => {
    e.preventDefault()
    if (!config) return
    void run(async () => {
      const r = await api('PUT', '/v1/presence/config', {
        ...config,
        serviceAreas: areas.split(',').map((s) => s.trim()).filter(Boolean),
      })
      setConfig(r.config)
      setIndexing(r.indexing)
      setNote('Saved. The live page updates within a few minutes.')
    })
  }

  const uploadPhoto = (file: File) =>
    void run(async () => {
      const r = await api('POST', '/v1/presence/photo', { contentType: file.type })
      const put = await fetch(r.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type },
        body: file,
      })
      if (!put.ok) throw new Error('upload_failed')
      await api('POST', '/v1/presence/photo/confirm', { photoKey: r.photoKey })
      if (fileRef.current) fileRef.current.value = ''
      setNote('Photo uploaded. It appears on the page within a few minutes.')
      await load()
    })

  const set = (k: keyof PresenceConfig) => (e: { target: { value: string } }) =>
    setConfig((c) => (c ? { ...c, [k]: e.target.value } : c))

  const toggle = (k: keyof PresenceConfig) => (e: { target: { checked: boolean } }) =>
    setConfig((c) => (c ? { ...c, [k]: e.target.checked } : c))

  return (
    <>
      <h1>Your page</h1>
      <p>
        A real web page for your business, built from what you have already set up. Your services
        and hours come from <Link to="/booking/services">Bookings</Link>; change them there and the
        page changes too.
      </p>

      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card">
        <h2>Your address</h2>
        <div className="row">
          <input className="grow" readOnly value={pageUrl} onFocus={(e) => e.target.select()}
            aria-label="Your page address" />
          <a className="btn" href={pageUrl} target="_blank" rel="noopener">Open</a>
        </div>
        <p className="meta mt">
          Put this on your van, your invoices and your Google Business Profile. It is free and it
          stays free.
        </p>
      </div>

      {indexing && !indexing.ownSite && (
        indexing.complete ? (
          <Notice tone="ok">
            <strong>Search engines can index this page.</strong> It has everything they treat as a
            real business: an intro, a photo and priced services.
          </Notice>
        ) : (
          <Notice tone="warn">
            <strong>Hidden from search engines until it is finished.</strong> A half-empty page
            ranked under your name does more harm than none. Still missing:{' '}
            {indexing.missing.join(', ')}.
          </Notice>
        )
      )}
      {indexing?.ownSite && (
        <Notice tone="ok">
          You have your own website, so this page stays out of search results and links to your
          site instead — we never compete with you for your own name. It still works as a booking
          and chat page.
        </Notice>
      )}

      {config && (
        <>
          <div className="card">
            <h2>Photo</h2>
            <p className="hint">
              One good photo — you at work, your van, your shopfront. It is the difference between
              a page that looks real and one that looks abandoned.
            </p>
            {config.photoKey && (
              <p><img src={`https://chat.makerbay.app/${config.photoKey}?v=${Date.now()}`}
                alt="Your page photo" style={{ maxWidth: '100%', maxHeight: 220, borderRadius: 10 }} /></p>
            )}
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp"
              onChange={(e) => e.target.files?.[0] && uploadPhoto(e.target.files[0])} disabled={busy}
              aria-label="Upload a photo" />
          </div>

          <div className="card">
            <h2>Words</h2>
            <form onSubmit={save}>
              <label htmlFor="p-headline">Headline</label>
              <input id="p-headline" value={config.headline} onChange={set('headline')}
                placeholder="Emergency electrician, Coimbatore" />
              <p className="meta">One line, under your business name. What you do and where.</p>

              <label htmlFor="p-intro">About your business</label>
              <textarea id="p-intro" rows={4} value={config.intro} onChange={set('intro')}
                placeholder="Twenty years of residential electrical work. Licensed, insured, and honest about what a job costs before it starts." />
              <p className="meta">
                A few sentences in your own words. We never write this for you — a customer can tell,
                and so can a search engine.
              </p>

              <label htmlFor="p-areas">Areas you serve</label>
              <input id="p-areas" value={areas} onChange={(e) => setAreas(e.target.value)}
                placeholder="Kalapatti, Saravanampatti, Peelamedu" />

              <div className="row">
                <div className="grow">
                  <label htmlFor="p-phone">Phone</label>
                  <input id="p-phone" value={config.phone} onChange={set('phone')} />
                </div>
                <div className="grow">
                  <label htmlFor="p-email">Email</label>
                  <input id="p-email" type="email" value={config.email} onChange={set('email')} />
                </div>
              </div>

              <label htmlFor="p-site">Your own website, if you have one</label>
              <input id="p-site" value={config.websiteUrl ?? ''} onChange={set('websiteUrl')}
                placeholder="https://your-business.com" />
              <p className="meta">
                If you fill this in, your MakerBay page links to it and stays out of search results,
                so the two never compete.
              </p>

              <label className="pick">
                <input type="checkbox" checked={config.showBooking} onChange={toggle('showBooking')} />
                <span>Show the booking button (when Bookings is on)</span>
              </label>
              <label className="pick">
                <input type="checkbox" checked={config.showAssistant} onChange={toggle('showAssistant')} />
                <span>Show the ask-a-question link (when the assistant has knowledge)</span>
              </label>
              <label className="pick">
                <input type="checkbox" checked={config.published} onChange={toggle('published')} />
                <span>Page is live — unticking makes the address return "not found"</span>
              </label>

              <div className="mt"><button disabled={busy}>{busy ? 'Saving…' : 'Save page'}</button></div>
            </form>
          </div>
        </>
      )}

      {!config && !error && <div className="card"><Skeleton rows={6} /></div>}
    </>
  )
}

export const presenceDashboard: DashboardModule = {
  id: 'presence',
  label: 'Your page',
  nav: [{ to: '/page', label: 'Edit page' }],
  routes: () => (
    <>
      <Route path="/page" element={<PagePage />} />
    </>
  ),
}

export default presenceDashboard
