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
}

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
          <ArticlesCard helpEnabled={config.helpEnabled === true} slug={me.tenant?.slug ?? ''} />
        </>
      )}
    </>
  )
}

interface ArticleSource {
  sourceId: string
  name: string
  status: string
  published?: boolean
  helpMeta?: { title: string; description: string; category: string }
}

/**
 * The articles themselves, right where the owner looks for them (issue 64
 * day 1). The old flow hid publishing on the Knowledge page, so a centre
 * full of ready sources sat empty and nothing here said why.
 */
function ArticlesCard({ helpEnabled, slug }: { helpEnabled: boolean; slug: string }) {
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
      <h2>Articles</h2>
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}
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
              </span>
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
