import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, explain } from '../api'
import { Empty, Notice, Skeleton, bytes, when } from '../ui'

interface Source {
  sourceId: string
  name: string
  type: 'file' | 'text' | 'url'
  status: 'awaiting_upload' | 'processing' | 'ready' | 'failed'
  sizeBytes?: number
  charCount?: number
  sourceUrl?: string
  fetchedAt?: string
  warning?: string
  createdAt: string
}

interface Preview {
  name: string
  type: string
  status: string
  sizeBytes: number | null
  charCount: number | null
  sourceUrl: string | null
  fetchedAt: string | null
  createdAt: string
  excerpt: string | null
  truncated: boolean
  viewUrl?: string
}

type Tab = 'website' | 'file' | 'text'

export default function Knowledge() {
  const [sources, setSources] = useState<Source[]>([])
  const [loaded, setLoaded] = useState(false)
  const [tab, setTab] = useState<Tab>('website')
  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [siteUrl, setSiteUrl] = useState('')
  const [found, setFound] = useState<string[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      const r = await api('GET', '/v1/assistant/sources')
      setSources(r.sources ?? [])
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void load()
    // Ingestion is asynchronous, so status chips need to catch up on their own.
    const t = setInterval(() => { void load() }, 12000)
    return () => clearInterval(t)
  }, [load])

  const run = async (fn: () => Promise<void>) => {
    setError(''); setNote(''); setBusy(true)
    try { await fn(); await load() } catch (e) {
      setError(explain(e))
    } finally { setBusy(false) }
  }

  const addText = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api('POST', '/v1/assistant/sources', { type: 'text', name: name || 'Pasted text', text })
      setText(''); setName('')
      setNote('Added. It will be ready to answer from in a minute or two.')
    })
  }

  const addUrl = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api('POST', '/v1/assistant/sources', { type: 'url', url })
      setUrl('')
      setNote('Page added. It will be ready to answer from in a minute or two.')
    })
  }

  const addFile = (file: File) =>
    void run(async () => {
      const r = await api('POST', '/v1/assistant/sources', {
        type: 'file', name: file.name, contentType: file.type || 'application/octet-stream',
      })
      const put = await fetch(r.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: file,
      })
      if (!put.ok) throw new Error('upload_failed')
      await api('POST', `/v1/assistant/sources/${r.source.sourceId}/ingest`, {})
      if (fileRef.current) fileRef.current.value = ''
      setNote(`Uploaded ${file.name}. It will be ready to answer from in a minute or two.`)
    })

  const discover = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const r = await api('POST', '/v1/assistant/sources/discover', { url: siteUrl })
      setFound(r.urls ?? [])
      setPicked(new Set())
      setNote(r.urls?.length
        ? `Found ${r.urls.length} pages on your site. Tick the ones customers ask about.`
        : 'No pages found automatically. Add them one at a time above.')
    })
  }

  const addPicked = () =>
    void run(async () => {
      let added = 0
      const failures: string[] = []
      for (const u of picked) {
        try { await api('POST', '/v1/assistant/sources', { type: 'url', url: u }); added++ }
        catch (e) { failures.push(`${u.replace(/^https?:\/\/[^/]+/, '')} — ${explain(e, 'could not be read')}`) }
      }
      setFound(null); setPicked(new Set())
      setNote(`Added ${added} page${added === 1 ? '' : 's'}.${failures.length ? ` ${failures.length} skipped: ${failures[0]}` : ''}`)
    })

  const openPreview = (id: string) =>
    void run(async () => { setPreview(await api('GET', `/v1/assistant/sources/${id}/preview`)) })

  const refresh = (id: string) =>
    void run(async () => {
      const r = await api('POST', `/v1/assistant/sources/${id}/refresh`, {})
      setNote(`Re-fetched — ${r.charCount.toLocaleString()} characters of text.`)
    })

  const remove = (id: string, label: string) => {
    if (!confirm(`Remove "${label}"? Your assistant will stop answering from it.`)) return
    void run(async () => {
      await api('DELETE', `/v1/assistant/sources/${id}`)
      setNote('Removed.')
    })
  }

  const ready = sources.filter((s) => s.status === 'ready').length
  const working = sources.filter((s) => s.status === 'processing' || s.status === 'awaiting_upload').length

  return (
    <>
      <h1>Knowledge</h1>
      <p>
        Everything your assistant knows comes from these sources. It will never invent an answer —
        if something is not here, it says so.
      </p>

      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card">
        <h2>Add knowledge</h2>
        <div className="tabs">
          <button className={tab === 'website' ? 'on' : ''} onClick={() => setTab('website')}>From your website</button>
          <button className={tab === 'file' ? 'on' : ''} onClick={() => setTab('file')}>Upload a document</button>
          <button className={tab === 'text' ? 'on' : ''} onClick={() => setTab('text')}>Paste text</button>
        </div>

        {tab === 'website' && (
          <>
            <p className="hint">
              Point us at your site and we will list its pages, or add one page at a time.
              Pages that build their content with JavaScript may come back empty — we will tell you if that happens.
            </p>
            <form onSubmit={discover} className="row mt">
              <input className="grow" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)}
                placeholder="https://your-business.com" required aria-label="Website address" />
              <button disabled={busy}>{busy ? 'Looking…' : 'Find pages'}</button>
            </form>
            <form onSubmit={addUrl} className="row mt">
              <input className="grow" value={url} onChange={(e) => setUrl(e.target.value)}
                placeholder="https://your-business.com/faq — add a single page" required aria-label="Page address" />
              <button className="ghost" disabled={busy}>Add page</button>
            </form>

            {found && found.length > 0 && (
              <div className="mt">
                <div className="row">
                  <button className="ghost" onClick={() => setPicked(new Set(found))}>Select all</button>
                  <button className="ghost" onClick={() => setPicked(new Set())}>Clear</button>
                  <span className="grow" />
                  <button onClick={addPicked} disabled={busy || picked.size === 0}>
                    Add {picked.size} page{picked.size === 1 ? '' : 's'}
                  </button>
                </div>
                <div className="picklist">
                  {found.map((u) => (
                    <label key={u} className="pick">
                      <input type="checkbox" checked={picked.has(u)}
                        onChange={(e) => {
                          const next = new Set(picked)
                          if (e.target.checked) next.add(u); else next.delete(u)
                          setPicked(next)
                        }} />
                      <span>{u.replace(/^https?:\/\/[^/]+/, '') || '/'}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'file' && (
          <>
            <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.doc,.docx,.html,.csv"
              onChange={(e) => e.target.files?.[0] && addFile(e.target.files[0])} disabled={busy}
              aria-label="Choose a document" />
            <p className="hint mt">
              PDF, Word, Markdown, HTML, plain text or CSV. Price lists, service menus and policy
              documents work well.
            </p>
          </>
        )}

        {tab === 'text' && (
          <form onSubmit={addText}>
            <label htmlFor="k-name">Name</label>
            <input id="k-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Opening hours and location" />
            <label htmlFor="k-text">Content</label>
            <textarea id="k-text" rows={5} value={text} onChange={(e) => setText(e.target.value)} required
              placeholder="We are open Mon–Fri 9am–6pm, Saturday 10am–4pm, closed Sunday…" />
            <div className="mt"><button disabled={busy}>Add to knowledge</button></div>
          </form>
        )}
      </div>

      <div className="card">
        <div className="row">
          <h2 className="grow">Sources</h2>
          {loaded && sources.length > 0 && (
            <span className="meta">
              {ready} ready{working > 0 ? `, ${working} still processing` : ''}
            </span>
          )}
        </div>

        {!loaded ? <Skeleton rows={4} /> : sources.length === 0 ? (
          <Empty title="Your assistant has nothing to answer from yet">
            Add your website above and it will be answering customer questions in a couple of minutes.
            Most businesses start with their FAQ, pricing and opening hours.
          </Empty>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr><th>Name</th><th>Type</th><th>Status</th><th>Added</th><th><span className="visually-hidden">Actions</span></th></tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.sourceId}>
                    <td>
                      {s.name}
                      {s.sourceUrl && <div className="meta trunc">{s.sourceUrl}</div>}
                      {s.warning && <div className="meta warn-text">{s.warning}</div>}
                    </td>
                    <td>{s.type === 'url' ? 'web page' : s.type}</td>
                    <td><span className={`chip ${s.status}`}>{s.status.replace('_', ' ')}</span></td>
                    <td className="nowrap">{when(s.createdAt)}</td>
                    <td className="nowrap">
                      <button className="ghost" onClick={() => openPreview(s.sourceId)}>Preview</button>{' '}
                      {s.type === 'url' && <><button className="ghost" onClick={() => refresh(s.sourceId)}>Refresh</button>{' '}</>}
                      <button className="danger" onClick={() => remove(s.sourceId, s.name)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {loaded && sources.length > 0 && (
          <p className="meta mt">Processing usually takes a minute or two. This list updates itself.</p>
        )}
      </div>

      {preview && (
        <div className="card">
          <div className="row">
            <h2 className="grow">{preview.name}</h2>
            <button className="ghost" onClick={() => setPreview(null)}>Close</button>
          </div>
          <dl className="facts">
            <dt>Type</dt><dd>{preview.type === 'url' ? 'web page' : preview.type}</dd>
            {preview.sourceUrl && (
              <><dt>Address</dt><dd><a href={preview.sourceUrl} target="_blank" rel="noopener">{preview.sourceUrl}</a></dd></>
            )}
            <dt>Added</dt><dd>{when(preview.createdAt)}</dd>
            {preview.fetchedAt && <><dt>Last fetched</dt><dd>{when(preview.fetchedAt)}</dd></>}
            <dt>Size</dt><dd>{bytes(preview.sizeBytes)}</dd>
            {preview.charCount != null && (
              <><dt>Text learned</dt><dd>{preview.charCount.toLocaleString()} characters</dd></>
            )}
          </dl>
          {preview.viewUrl && (
            <p className="mt"><a className="btn ghost" href={preview.viewUrl} target="_blank" rel="noopener">Open original file</a></p>
          )}
          {preview.excerpt && (
            <>
              <label>Extracted text{preview.truncated ? ' (first part)' : ''}</label>
              <pre className="code excerpt">{preview.excerpt}</pre>
            </>
          )}
        </div>
      )}
    </>
  )
}
