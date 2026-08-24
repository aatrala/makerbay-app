import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, Route } from 'react-router-dom'
import SharePage from './SharePage'
import QrBlock from './Qr'
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
  accentColor?: string
  themeStyle?: 'fresh' | 'warm' | 'bold'
}

interface Indexing {
  directive: 'index' | 'noindex'
  complete: boolean
  missing: string[]
  ownSite: boolean
}

interface ChecklistItem {
  key: string
  label: string
  done: boolean
  soon?: boolean
  to: string
}

const THEME_LABELS: Record<string, string> = {
  fresh: 'Fresh — clean and light',
  warm: 'Warm — cream paper, serif headings',
  bold: 'Bold — dark header, strong type',
}

function PagePage() {
  const [config, setConfig] = useState<PresenceConfig | null>(null)
  const [indexing, setIndexing] = useState<Indexing | null>(null)
  const [checklist, setChecklist] = useState<ChecklistItem[]>([])
  const [pageUrl, setPageUrl] = useState('')
  const [areas, setAreas] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [previewMode, setPreviewMode] = useState<'desktop' | 'mobile'>('desktop')
  const [previewNonce, setPreviewNonce] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      const r = await api('GET', '/v1/presence/config')
      setConfig(r.config)
      setIndexing(r.indexing)
      setChecklist(r.checklist ?? [])
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
      setChecklist(r.checklist ?? [])
      setPreviewNonce((n) => n + 1)
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

      <AddressCard pageUrl={pageUrl} onChanged={load} />

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

      {checklist.length > 0 && (
        <div className="card">
          <h2>Page checklist</h2>
          <p className="meta">
            The path from "page exists" to "page earns work". {checklist.filter((c) => c.done).length} of{' '}
            {checklist.filter((c) => !c.soon).length} done.
          </p>
          <ul className="checklist">
            {checklist.map((c) => (
              <li key={c.key} className={c.done ? 'done' : c.soon ? 'soon' : ''}>
                <span aria-hidden="true">{c.done ? '✓' : c.soon ? '·' : '○'}</span>{' '}
                {c.soon ? (
                  <span className="meta">{c.label} — coming with payments setup</span>
                ) : c.done || !c.to ? (
                  c.label
                ) : (
                  <Link to={c.to}>{c.label}</Link>
                )}
              </li>
            ))}
          </ul>
        </div>
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

              <h2 className="mt">Look</h2>
              <div className="row">
                <div className="grow">
                  <label htmlFor="p-theme">Style</label>
                  <select id="p-theme" value={config.themeStyle ?? 'fresh'}
                    onChange={(e) => setConfig((c) => (c ? { ...c, themeStyle: e.target.value as PresenceConfig['themeStyle'] } : c))}>
                    {(['fresh', 'warm', 'bold'] as const).map((t) => (
                      <option key={t} value={t}>{THEME_LABELS[t]}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="p-accent">Accent colour</label>
                  <input id="p-accent" type="color" value={config.accentColor ?? '#c2410c'}
                    onChange={(e) => setConfig((c) => (c ? { ...c, accentColor: e.target.value } : c))}
                    style={{ width: 64, height: 38, padding: 2 }} />
                </div>
              </div>
              <p className="meta">Buttons, links and highlights use the accent. Save, then check the preview below.</p>

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

          <div className="card">
            <div className="preview-head">
              <h2>Preview</h2>
              <div className="preview-controls">
                <div className="tabs seg">
                  <button type="button" className={previewMode === 'desktop' ? 'on' : ''}
                    onClick={() => setPreviewMode('desktop')}>Desktop</button>
                  <button type="button" className={previewMode === 'mobile' ? 'on' : ''}
                    onClick={() => setPreviewMode('mobile')}>Phone</button>
                </div>
                <button type="button" className="ghost" onClick={() => setPreviewNonce((n) => n + 1)}>Refresh</button>
                <a className="btn ghost" href={pageUrl} target="_blank" rel="noopener">Open ↗</a>
              </div>
            </div>
            <p className="meta">
              The real live page, as a visitor sees it. Saves can take a couple of minutes to
              appear — the page is cached.
            </p>
            <div className={`preview-stage${previewMode === 'mobile' ? ' phone' : ''}`}>
              <div className={previewMode === 'mobile' ? 'phone-frame' : 'desktop-frame'}>
                <iframe
                  title="Page preview"
                  src={`${pageUrl}?preview=${previewNonce}`}
                />
              </div>
            </div>
          </div>
        </>
      )}

      {config && <DomainCard />}

      {!config && !error && <div className="card"><Skeleton rows={6} /></div>}
    </>
  )
}

/**
 * The page address, editable in place. The slug is workspace-wide (chat and
 * help centre share it), so this calls the workspace endpoint - but the
 * owner should not have to know that to change their address.
 */
function AddressCard({ pageUrl, onChanged }: { pageUrl: string; onChanged: () => Promise<void> }) {
  const currentSlug = pageUrl.split('/p/')[1] ?? ''
  const [editing, setEditing] = useState(false)
  const [slug, setSlug] = useState(currentSlug)
  const [check, setCheck] = useState<{ available: boolean; message?: string } | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { setSlug(currentSlug) }, [currentSlug])

  useEffect(() => {
    const wanted = slug.trim().toLowerCase()
    if (!editing || !wanted || wanted === currentSlug) { setCheck(null); return }
    const t = setTimeout(() => {
      void api('GET', `/v1/core/workspace/slug?check=${encodeURIComponent(wanted)}`)
        .then(setCheck)
        .catch(() => setCheck(null))
    }, 400)
    return () => clearTimeout(t)
  }, [editing, slug, currentSlug])

  const save = (e: FormEvent) => {
    e.preventDefault()
    const wanted = slug.trim().toLowerCase()
    if (wanted === currentSlug) { setEditing(false); return }
    if (!window.confirm('Change your address? Every link you have already shared stops working immediately.')) return
    setBusy(true); setError(''); setNote('')
    void api('PATCH', '/v1/core/workspace', { slug: wanted })
      .then(async () => {
        setNote('Address changed. Update your Google profile and anything printed.')
        setEditing(false)
        await onChanged()
      })
      .catch((err) => setError(explain(err)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="card">
      <h2>Your address</h2>
      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}
      {!editing ? (
        <>
          <div className="row">
            <input className="grow" readOnly value={pageUrl} onFocus={(e) => e.target.select()}
              aria-label="Your page address" />
            <a className="btn" href={pageUrl} target="_blank" rel="noopener">Open</a>
            <button className="ghost" onClick={() => setEditing(true)}>Edit</button>
          </div>
          <p className="meta mt">
            Put this on your van, your invoices and your Google Business Profile. It is free and it
            stays free. The same address serves your chat and help centre — or connect your own
            domain below.
          </p>
          <QrBlock url={pageUrl} label="Your page" />
        </>
      ) : (
        <form onSubmit={save}>
          <div className="row">
            <span className="meta nowrap">makerbay.app/p/</span>
            <input className="grow" autoFocus value={slug} aria-label="New address"
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
              maxLength={40} />
            <button disabled={busy || (check != null && !check.available)}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="ghost" disabled={busy}
              onClick={() => { setEditing(false); setSlug(currentSlug); setError('') }}>
              Cancel
            </button>
          </div>
          <p className="meta" aria-live="polite">
            {slug.trim().toLowerCase() === currentSlug
              ? 'Lowercase letters, numbers and hyphens.'
              : check == null
                ? 'Checking availability…'
                : check.available
                  ? '✓ Available. Saving breaks every link you have already shared - the old address is released immediately.'
                  : check.message ?? 'That address is already in use.'}
          </p>
        </form>
      )}
    </div>
  )
}

interface DomainState {
  domain: string | null
  status?: 'pending_validation' | 'pending_dns' | 'active'
  validation?: { name: string; value: string }
  target?: string
  message?: string
  /** Whether this workspace may connect a domain; absent means legacy true. */
  pro?: boolean
}

function DomainCard() {
  const [state, setState] = useState<DomainState | null>(null)
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [proBlocked, setProBlocked] = useState(false)

  const load = useCallback(async () => {
    try { setState(await api('GET', '/v1/presence/domain')) }
    catch (e) { setError(explain(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  const run = (fn: () => Promise<void>) =>
    void (async () => {
      setBusy(true); setError(''); setNote('')
      try { await fn() } catch (e) {
        const msg = explain(e)
        if (msg.includes('Presence Pro')) setProBlocked(true)
        setError(msg)
      } finally { setBusy(false) }
    })()

  const add = (e: FormEvent) => {
    e.preventDefault()
    run(async () => {
      const r = await api('PUT', '/v1/presence/domain', { domain: input.trim() })
      setState(r); setNote(r.message ?? '')
    })
  }

  const STATUS_TEXT: Record<string, string> = {
    pending_validation: 'Waiting for DNS validation',
    pending_dns: 'Certificate issued — point your domain',
    active: 'Live',
  }

  return (
    <div className="card">
      <h2>Your own domain</h2>
      <p className="meta">
        Serve this page on a domain you own — yourbusiness.com.au instead of
        makerbay.app. Part of Presence Pro. The free makerbay.app page stays either way.
      </p>
      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone={proBlocked ? 'warn' : 'err'} onClose={() => setError('')}>{error}</Notice>}

      {!state ? <Skeleton rows={2} /> : !state.domain ? (
        state.pro === false ? (
          <Notice tone="warn">
            <strong>Custom domains are part of Presence Pro</strong> — included in the Trade plan.
            Your free makerbay.app page keeps working either way.{' '}
            <Link to="/billing">See plans</Link>
          </Notice>
        ) : (
        <form onSubmit={add}>
          <div className="row">
            <input className="grow" value={input} placeholder="yourbusiness.com.au"
              onChange={(e) => setInput(e.target.value)} aria-label="Your domain" />
            <button disabled={busy || !input.trim()}>{busy ? 'Working…' : 'Connect domain'}</button>
          </div>
          <p className="meta">You will add two DNS records at your domain provider: one to prove you own it, one to point it here.</p>
        </form>
        )
      ) : (
        <>
          <p>
            <strong>{state.domain}</strong>{' '}
            <span className={`chip ${state.status === 'active' ? 'ready' : 'processing'}`}>
              {STATUS_TEXT[state.status ?? ''] ?? state.status}
            </span>
          </p>
          {state.message && <p className="meta">{state.message}</p>}
          {state.status === 'pending_validation' && state.validation && (
            <>
              <label className="mt">Add this CNAME record at your DNS provider</label>
              <div className="row">
                <input className="grow" readOnly value={state.validation.name} onFocus={(e) => e.target.select()} aria-label="Record name" />
              </div>
              <div className="row">
                <input className="grow" readOnly value={state.validation.value} onFocus={(e) => e.target.select()} aria-label="Record value" />
              </div>
            </>
          )}
          {state.status !== 'pending_validation' && state.target && (
            <>
              <label className="mt">Point your domain here (CNAME)</label>
              <div className="row">
                <input className="grow" readOnly value={state.target} onFocus={(e) => e.target.select()} aria-label="CNAME target" />
              </div>
            </>
          )}
          <div className="row mt">
            <button className="ghost" disabled={busy} onClick={() => run(async () => { setState(await api('GET', '/v1/presence/domain')) })}>
              Check status
            </button>
            <button className="ghost" disabled={busy}
              onClick={() => {
                if (window.confirm(`Swap ${state.domain} for a different domain? The current one stops serving your page.`)) {
                  run(async () => {
                    setState(await api('DELETE', '/v1/presence/domain'))
                    setNote('Removed. Enter the new domain below. If it was connected here before, give it a few minutes first.')
                  })
                }
              }}>
              Use a different domain
            </button>
            <button className="danger" disabled={busy}
              onClick={() => { if (window.confirm('Remove this domain? The page stays on makerbay.app.')) run(async () => { setState(await api('DELETE', '/v1/presence/domain')) }) }}>
              Remove domain
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export const presenceDashboard: DashboardModule = {
  id: 'presence',
  label: 'Your page',
  nav: [
    { to: '/page', label: 'Edit page' },
    { to: '/page/share', label: 'Share' },
  ],
  routes: ({ me }) => (
    <>
      <Route path="/page" element={<PagePage />} />
      <Route path="/page/share" element={<SharePage me={me} />} />
    </>
  ),
}

export default presenceDashboard
