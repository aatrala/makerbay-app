import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api, explain, Notice, Skeleton, type Me } from '@makerbay/web-kit'

interface Config {
  name: string
  greeting: string
  instructions: string
  fallbackMessage: string
  brandColor: string
  helpEnabled?: boolean
  helpTitle?: string
  helpIntro?: string
  helpTheme?: string
  helpPinned?: string[]
  helpCategoryOrder?: string[]
  helpFontHead?: string
  helpAccent2?: string
  helpShowLogo?: boolean
}

type HelpTier = 'free' | 'trade' | 'genie'

export default function Behavior({ me }: { me: Me }) {
  const [config, setConfig] = useState<Config | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void api('GET', '/v1/assistant/config')
      .then((r) => setConfig(r.config))
      .catch((e) => setError(explain(e)))
  }, [])

  const set = (k: keyof Config) => (e: { target: { value: string } }) => {
    setConfig((c) => (c ? { ...c, [k]: e.target.value } : c))
    setSaved(false)
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!config) return
    setError(''); setBusy(true)
    try {
      const r = await api('PUT', '/v1/assistant/config', config)
      setConfig(r.config)
      setSaved(true)
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h1>Behavior</h1>
      <p>Shape how your assistant introduces itself and what it says when it cannot help.</p>

      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}
      {saved && <Notice tone="ok" onClose={() => setSaved(false)}>Saved. Every conversation from now on uses these settings.</Notice>}

      <div className="card">
        {!config ? <Skeleton rows={6} /> : (
          <form onSubmit={save}>
            <label htmlFor="b-name">Assistant name</label>
            <input id="b-name" value={config.name} onChange={set('name')} />
            <p className="meta">Shown at the top of the chat bubble and the hosted page.</p>

            <label htmlFor="b-greeting">Greeting</label>
            <input id="b-greeting" value={config.greeting} onChange={set('greeting')} />
            <p className="meta">The first thing a customer sees before they type anything.</p>

            <label htmlFor="b-instructions">Instructions</label>
            <textarea id="b-instructions" rows={4} value={config.instructions} onChange={set('instructions')}
              placeholder="Friendly and concise. Never discuss pricing — direct people to sales@…" />
            <p className="meta">Tone, style, topics to avoid. Written for the assistant, never shown to customers.</p>

            <label htmlFor="b-fallback">When the answer is not in your knowledge, say</label>
            <input id="b-fallback" value={config.fallbackMessage} onChange={set('fallbackMessage')} />
            <p className="meta">A good fallback offers a way to reach a human.</p>

            <label htmlFor="b-color">Brand colour</label>
            <div className="row">
              <input id="b-color" type="color" className="swatch" value={config.brandColor} onChange={set('brandColor')} />
              <code>{config.brandColor}</code>
            </div>
            <p className="meta">Used for the chat bubble and the customer's message bubbles.</p>

            <div className="mt"><button disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button></div>
          </form>
        )}
      </div>

    </>
  )
}

/**
 * The help centre gets its own tab: buried at the bottom of Behavior nobody
 * found it - the founder included (issue 42).
 */
export function HelpCentrePage({ me }: { me: Me }) {
  const [config, setConfig] = useState<Config | null>(null)
  const [tier, setTier] = useState<HelpTier>('free')
  const [cap, setCap] = useState<{ cap: number; used: number } | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void api('GET', '/v1/assistant/config')
      .then((r) => {
        setConfig(r.config)
        if (r.helpTier) setTier(r.helpTier as HelpTier)
        if (typeof r.sourceCap === 'number') setCap({ cap: r.sourceCap, used: r.sourceCount ?? 0 })
      })
      .catch((e) => setError(explain(e)))
  }, [])

  const set = (k: keyof Config) => (e: { target: { value: string } }) => {
    setConfig((c) => (c ? { ...c, [k]: e.target.value } : c))
    setSaved(false)
  }
  const toggle = (k: keyof Config) => (e: { target: { checked: boolean } }) => {
    setConfig((c) => (c ? { ...c, [k]: e.target.checked } : c))
    setSaved(false)
  }
  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!config) return
    setError(''); setBusy(true)
    try {
      const r = await api('PUT', '/v1/assistant/config', config)
      setConfig(r.config)
      setSaved(true)
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }
  // Instant-save for the appearance/structure controls: themes and pins are
  // picked, not typed, so a Save button would just be a second click.
  const patch = async (partial: Partial<Config>) => {
    if (!config) return
    setError('')
    try {
      const r = await api('PUT', '/v1/assistant/config', { ...config, ...partial })
      setConfig(r.config)
    } catch (err) {
      setError(explain(err))
    }
  }

  return (
    <>
      <h1>Help centre</h1>
      <p>
        Public, Google-indexable help pages built from the knowledge your assistant already has.
      </p>
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}
      {saved && <Notice tone="ok" onClose={() => setSaved(false)}>Saved.</Notice>}
      {!config ? <div className="card"><Skeleton rows={5} /></div> : (
        <>
          <HelpCentre config={config} me={me} set={set} toggle={toggle} save={save} busy={busy} />
          <ThemeCard config={config} tier={tier} patch={patch} slug={me.tenant?.slug ?? ''} />
          <ArticlesCard
            helpEnabled={config.helpEnabled === true}
            slug={me.tenant?.slug ?? ''}
            tier={tier}
            capInfo={cap}
            pinned={config.helpPinned ?? []}
            onTogglePin={(id) => {
              const cur = config.helpPinned ?? []
              const next = cur.includes(id) ? cur.filter((p) => p !== id) : [...cur, id].slice(0, 4)
              void patch({ helpPinned: next })
            }}
          />
          <CategoryOrderCard config={config} tier={tier} patch={patch} />
        </>
      )}
    </>
  )
}

const THEME_CHOICES: { key: string; name: string; blurb: string }[] = [
  { key: 'clean', name: 'Clean', blurb: 'The free look - tidy cards, your colour on the trim.' },
  { key: 'bold', name: 'Bold', blurb: 'Your colour full-bleed across the top, chunky cards.' },
  { key: 'editorial', name: 'Editorial', blurb: 'Serif headlines and ruled lists - the professional-services look.' },
  { key: 'ledger', name: 'Ledger', blurb: 'White, ruled rows, monospace dates - reads like a spec sheet.' },
  { key: 'signwriter', name: 'Signwriter', blurb: 'Slab-serif colour bands and numbered lists - the local-firm look.' },
]

function ThemeCard({ config, tier, patch, slug }: {
  config: Config
  tier: HelpTier
  patch: (p: Partial<Config>) => Promise<void>
  slug: string
}) {
  const current = config.helpTheme ?? 'clean'
  return (
    <div className="card">
      <h2>Theme</h2>
      <p className="meta">
        How your help centre looks at <code>help.makerbay.app/{slug}</code>.
        {tier === 'free' && ' Themes beyond Clean come with Trade.'}
      </p>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        {THEME_CHOICES.map((t) => {
          const locked = t.key !== 'clean' && tier === 'free'
          const on = current === t.key
          return (
            <button
              key={t.key}
              type="button"
              className={on ? '' : 'ghost'}
              disabled={locked}
              title={t.blurb}
              onClick={() => void patch({ helpTheme: t.key })}
            >
              {t.name}{locked ? ' 🔒' : ''}
            </button>
          )
        })}
      </div>
      <p className="meta mt">{THEME_CHOICES.find((t) => t.key === current)?.blurb}</p>

      {tier === 'genie' ? (
        <>
          <h3 className="mt">Branding (Genie)</h3>
          <label className="pick">
            <input type="checkbox" checked={config.helpShowLogo !== false}
              onChange={(e) => void patch({ helpShowLogo: e.target.checked })} />
            <span>Show your page photo as the logo in the header</span>
          </label>
          <div className="row mt" style={{ gap: 14, flexWrap: 'wrap' }}>
            <div>
              <label htmlFor="h-font">Heading font (any Google font)</label>
              <input id="h-font" defaultValue={config.helpFontHead ?? ''} placeholder="e.g. Bricolage Grotesque"
                onBlur={(e) => void patch({ helpFontHead: e.target.value.trim() })} />
            </div>
            <div>
              <label htmlFor="h-acc2">Second accent</label>
              <div className="row">
                <input id="h-acc2" type="color" className="swatch" value={config.helpAccent2 ?? config.brandColor}
                  onChange={(e) => void patch({ helpAccent2: e.target.value })} />
                <code>{config.helpAccent2 ?? '—'}</code>
              </div>
            </div>
          </div>
          <p className="meta">On Genie the "powered by MakerBay" line is gone automatically.</p>
        </>
      ) : (
        <p className="meta">
          Genie adds full branding: any font, a second accent, your logo, and no MakerBay line.
        </p>
      )}
    </div>
  )
}

const ALL_CATEGORIES = [
  'Getting started',
  'Services & pricing',
  'Bookings & appointments',
  'Policies & guarantees',
  'Troubleshooting',
  'General',
]

function CategoryOrderCard({ config, tier, patch }: {
  config: Config
  tier: HelpTier
  patch: (p: Partial<Config>) => Promise<void>
}) {
  const custom = (config.helpCategoryOrder ?? []).filter((c) => ALL_CATEGORIES.includes(c))
  const order = [...custom, ...ALL_CATEGORIES.filter((c) => !custom.includes(c))]
  const move = (i: number, dir: -1 | 1) => {
    const next = [...order]
    const j = i + dir
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    void patch({ helpCategoryOrder: next })
  }
  if (tier === 'free') {
    return (
      <div className="card">
        <h2>Category order</h2>
        <p className="meta">Reorder how categories appear on your help centre - comes with Trade.</p>
      </div>
    )
  }
  return (
    <div className="card">
      <h2>Category order</h2>
      <p className="meta">Top to bottom on your help centre index. Empty categories never show.</p>
      {order.map((c, i) => (
        <div key={c} className="row" style={{ borderTop: '1px solid var(--line)', padding: '6px 0' }}>
          <span className="grow">{c}</span>
          <button className="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${c} up`}>↑</button>
          <button className="ghost" disabled={i === order.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${c} down`}>↓</button>
        </div>
      ))}
    </div>
  )
}

interface ArticleSource {
  sourceId: string
  name: string
  status: string
  published?: boolean
  helpBodyKey?: string
  helpMeta?: { title: string; description: string; category: string }
}

/**
 * The articles themselves, right where the owner looks for them (issue 64
 * day 1). The old flow hid publishing on the Knowledge page, so a centre
 * full of ready sources sat empty and nothing here said why.
 */
function ArticlesCard({ helpEnabled, slug, tier, capInfo, pinned, onTogglePin }: {
  helpEnabled: boolean
  slug: string
  tier: HelpTier
  capInfo: { cap: number; used: number } | null
  pinned: string[]
  onTogglePin: (sourceId: string) => void
}) {
  const [sources, setSources] = useState<ArticleSource[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')

  const load = async () => {
    try { setSources((await api('GET', '/v1/assistant/sources')).sources ?? []) }
    catch (e) { setError(explain(e)); setSources([]) }
  }
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!sources) return <div className="card"><Skeleton rows={4} /></div>

  const published = sources.filter((s) => s.published && s.status === 'ready')
  const ready = sources.filter((s) => !s.published && s.status === 'ready')

  const setPublished = async (id: string, published: boolean) => {
    setBusy(true); setError('')
    try {
      await api('POST', `/v1/assistant/sources/${id}/publish`, { published })
      await load()
    } catch (e) { setError(explain(e)) } finally { setBusy(false) }
  }

  const setAll = async (list: ArticleSource[], published: boolean) => {
    setBusy(true); setError('')
    const verb = published ? 'Publishing' : 'Unpublishing'
    try {
      for (let i = 0; i < list.length; i++) {
        setProgress(`${verb} ${i + 1} of ${list.length}…`)
        await api('POST', `/v1/assistant/sources/${list[i].sourceId}/publish`, { published })
      }
      await load()
    } catch (e) { setError(explain(e)) } finally { setBusy(false); setProgress('') }
  }

  return (
    <div className="card">
      <div className="row baseline">
        <h2 className="grow">Articles</h2>
        {capInfo && (
          <span className="meta">{capInfo.used} of {capInfo.cap} sources used</span>
        )}
      </div>
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}
      {capInfo && capInfo.used >= capInfo.cap && (
        <Notice tone="warn">
          <strong>Source limit reached.</strong> New uploads and website crawls stop here - a crawl
          that hit this cap silently dropped its remaining pages. Trade raises the cap to 60, Genie
          to 150 (Billing), or remove sources you no longer need.
        </Notice>
      )}
      {helpEnabled && published.length === 0 && ready.length > 0 && (
        <Notice tone="warn">
          <strong>Your help centre is live but empty</strong> — none of your {ready.length} ready
          sources are published. Publishing writes each one a customer-facing title and category.
        </Notice>
      )}

      {published.length > 0 && (
        <>
          <div className="row baseline">
            <p className="meta grow">Live in your help centre ({published.length}):</p>
            {published.some((s) => !s.helpBodyKey) && (
              <button
                className="ghost"
                disabled={busy}
                title="Rewrites each article body with real headings, steps and tips. Titles and categories are untouched."
                onClick={() => void setAll(published.filter((s) => !s.helpBodyKey), true)}
              >
                {progress || `Improve formatting (${published.filter((s) => !s.helpBodyKey).length})`}
              </button>
            )}
            {published.length > 1 && (
              <button className="ghost" disabled={busy} onClick={() => void setAll(published, false)}>
                {progress || 'Unpublish all'}
              </button>
            )}
          </div>
          {published.map((s) => (
            <div key={s.sourceId} className="row" style={{ borderTop: '1px solid var(--line)', padding: '8px 0' }}>
              <span className="grow">
                <strong>{s.helpMeta?.title ?? s.name}</strong>
                <span className="meta"> · {s.helpMeta?.category ?? 'General'}</span>
                {pinned.includes(s.sourceId) && <span className="meta"> · ★ pinned</span>}
              </span>
              {tier !== 'free' && (
                <button
                  className="ghost"
                  disabled={busy || (!pinned.includes(s.sourceId) && pinned.length >= 4)}
                  title="Pinned articles lead the Popular strip on your help centre (up to 4)"
                  onClick={() => onTogglePin(s.sourceId)}
                >
                  {pinned.includes(s.sourceId) ? 'Unpin' : 'Pin'}
                </button>
              )}
              <button className="ghost" disabled={busy} onClick={() => void setPublished(s.sourceId, false)}>Unpublish</button>
            </div>
          ))}
        </>
      )}

      {ready.length > 0 && (
        <>
          <div className="row mt baseline">
            <p className="meta grow">Ready to publish ({ready.length}):</p>
            {ready.length > 1 && (
              <button className="ghost" disabled={busy} onClick={() => void setAll(ready, true)}>
                {progress || 'Publish all'}
              </button>
            )}
          </div>
          {ready.map((s) => (
            <div key={s.sourceId} className="row" style={{ borderTop: '1px solid var(--line)', padding: '8px 0' }}>
              <span className="grow trunc">{s.name}</span>
              <button disabled={busy} onClick={() => void setPublished(s.sourceId, true)}>Publish</button>
            </div>
          ))}
        </>
      )}

      {published.length === 0 && ready.length === 0 && (
        <p className="meta">
          Nothing to publish yet — add documents under Knowledge and they will appear here once
          processed.
        </p>
      )}
      <p className="meta mt">
        Fine-tune an article's title, description or category from{' '}
        <Link to="/assistant/knowledge">Knowledge</Link> → Article.
      </p>
    </div>
  )
}

/**
 * The help centre turns knowledge into public, indexable pages. It is off by
 * default and every article is published individually: a workspace's
 * documents are private until they say otherwise, twice.
 */
function HelpCentre({ config, me, set, toggle, save, busy }: {
  config: Config
  me: Me
  set: (k: keyof Config) => (e: { target: { value: string } }) => void
  toggle: (k: keyof Config) => (e: { target: { checked: boolean } }) => void
  save: (e: FormEvent) => void
  busy: boolean
}) {
  const url = `https://help.makerbay.app/${me.tenant?.slug ?? ''}`
  return (
    <div className="card">
      <h2>Public help centre</h2>
      <p>
        Turn the documents you have already uploaded into public help pages that Google can index.
        Nothing is published until you switch this on <em>and</em> mark each article as published
        under <Link to="/assistant/knowledge">Knowledge</Link>.
      </p>

      <form onSubmit={save}>
        <label className="pick">
          <input type="checkbox" checked={config.helpEnabled ?? false} onChange={toggle('helpEnabled')} />
          <span>Publish a help centre at <code>{url}</code></span>
        </label>

        {config.helpEnabled && (
          <>
            <label htmlFor="h-title">Help centre title</label>
            <input id="h-title" value={config.helpTitle ?? ''} onChange={set('helpTitle')}
              placeholder={`${config.name} help centre`} />

            <label htmlFor="h-intro">Introduction</label>
            <input id="h-intro" value={config.helpIntro ?? ''} onChange={set('helpIntro')}
              placeholder="Answers to the questions we are asked most often." />

            <p className="meta">
              When you publish an article, a customer-facing title, description and category are
              written for it automatically — a filename is not a headline. The centre groups by
              category and gains search at four articles.
            </p>
            <p className="meta">
              Submit <code>{url}/sitemap.xml</code> to Google Search Console so your articles are
              found. Each page links back to your assistant for anything it does not cover.
            </p>
            <p className="mt">
              <a className="btn ghost" href={url} target="_blank" rel="noopener">Open my help centre</a>
            </p>
          </>
        )}

        <div className="mt"><button disabled={busy}>{busy ? 'Saving…' : 'Save help centre settings'}</button></div>
      </form>
    </div>
  )
}
