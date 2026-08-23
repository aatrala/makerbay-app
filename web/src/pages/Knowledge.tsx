import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api } from '../api'

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

const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : '—')
const bytes = (n?: number | null) =>
  n == null ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`

export default function Knowledge() {
  const [sources, setSources] = useState<Source[]>([])
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
    const r = await api('GET', '/v1/assistant/sources')
    setSources(r.sources ?? [])
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => { void load() }, 12000)
    return () => clearInterval(t)
  }, [load])

  const run = async (fn: () => Promise<void>) => {
    setError(''); setNote(''); setBusy(true)
    try { await fn(); await load() } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally { setBusy(false) }
  }

  const addText = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api('POST', '/v1/assistant/sources', { type: 'text', name: name || 'Pasted text', text })
      setText(''); setName('')
    })
  }

  const addUrl = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api('POST', '/v1/assistant/sources', { type: 'url', url })
      setUrl('')
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
      if (!put.ok) throw new Error('Upload failed')
      await api('POST', `/v1/assistant/sources/${r.source.sourceId}/ingest`, {})
      if (fileRef.current) fileRef.current.value = ''
    })

  const discover = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const r = await api('POST', '/v1/assistant/sources/discover', { url: siteUrl })
      setFound(r.urls ?? [])
      setPicked(new Set())
      setNote(`Found ${r.urls?.length ?? 0} pages via ${r.discoveredVia}. Tick the ones to add.`)
    })
  }

  const addPicked = () =>
    void run(async () => {
      let added = 0
      const failures: string[] = []
      for (const u of picked) {
        try { await api('POST', '/v1/assistant/sources', { type: 'url', url: u }); added++ }
        catch (e) { failures.push(`${u.replace(/^https?:\/\/[^/]+/, '')} — ${e instanceof Error ? e.message : 'failed'}`) }
      }
      setFound(null); setPicked(new Set())
      setNote(`Added ${added} page${added === 1 ? '' : 's'}.${failures.length ? ` Skipped ${failures.length}: ${failures[0]}` : ''}`)
    })

  const openPreview = (id: string) =>
    void run(async () => { setPreview(await api('GET', `/v1/assistant/sources/${id}/preview`)) })

  const refresh = (id: string) =>
    void run(async () => {
      const r = await api('POST', `/v1/assistant/sources/${id}/refresh`, {})
      setNote(`Re-fetched — ${r.charCount.toLocaleString()} characters.`)
    })

  const remove = (id: string) => void run(async () => { await api('DELETE', `/v1/assistant/sources/${id}`) })

  return (
    <>
      <h1>Knowledge</h1>
      <p>Everything your assistant knows comes from these sources. Point it at your website, upload documents, or paste text.</p>

      {note && <div className="card" style={{ background: '#f0fdf7', borderColor: '#b5e5cf' }}>{note}</div>}
      {error && <div className="card" style={{ background: '#fde8ea', borderColor: '#f3bcc3' }}>{error}</div>}

      <div className="card">
        <h2>Learn from your website</h2>
        <p>We read the page and keep the text. Pages that build their content with JavaScript may come back empty — we'll tell you if that happens.</p>
        <form onSubmit={addUrl} className="row">
          <input className="grow" value={url} onChange={(e) => setUrl(e.target.value)}
            placeholder="https://your-business.com/about" required />
          <button disabled={busy}>Add page</button>
        </form>
        <form onSubmit={discover} className="row mt">
          <input className="grow" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)}
            placeholder="https://your-business.com — find pages for me" required />
          <button className="ghost" disabled={busy}>Find pages</button>
        </form>

        {found && (
          <div className="mt">
            {found.length === 0 ? <p className="hint">No pages found automatically. Add them one at a time above.</p> : (
              <>
                <div className="row">
                  <button className="ghost" onClick={() => setPicked(new Set(found))}>Select all</button>
                  <button className="ghost" onClick={() => setPicked(new Set())}>Clear</button>
                  <span className="grow" />
                  <button onClick={addPicked} disabled={busy || picked.size === 0}>
                    Add {picked.size} page{picked.size === 1 ? '' : 's'}
                  </button>
                </div>
                <div style={{ maxHeight: 240, overflowY: 'auto', marginTop: 10 }}>
                  {found.map((u) => (
                    <label key={u} style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0', fontWeight: 400 }}>
                      <input type="checkbox" style={{ width: 'auto' }} checked={picked.has(u)}
                        onChange={(e) => {
                          const next = new Set(picked)
                          e.target.checked ? next.add(u) : next.delete(u)
                          setPicked(next)
                        }} />
                      <span style={{ fontSize: 13 }}>{u.replace(/^https?:\/\/[^/]+/, '') || '/'}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Upload a document</h2>
        <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.doc,.docx,.html,.csv"
          onChange={(e) => e.target.files?.[0] && addFile(e.target.files[0])} disabled={busy} />
        <p className="hint mt">PDF, Word, Markdown, HTML, text or CSV.</p>
      </div>

      <div className="card">
        <h2>Or paste text</h2>
        <form onSubmit={addText}>
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Store FAQ" />
          <label>Content</label>
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} required
            placeholder="Paste your FAQ, opening hours, return policy…" />
          <div className="mt"><button disabled={busy}>Add to knowledge</button></div>
        </form>
      </div>

      <div className="card">
        <h2>Sources</h2>
        {sources.length === 0 ? (
          <p>No sources yet — the assistant will answer with its fallback message until you add some.</p>
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Added</th><th /></tr></thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.sourceId}>
                  <td>
                    {s.name}
                    {s.sourceUrl && <div className="hint" style={{ fontSize: 12 }}>{s.sourceUrl}</div>}
                  </td>
                  <td>{s.type}</td>
                  <td><span className={`chip ${s.status}`}>{s.status.replace('_', ' ')}</span></td>
                  <td style={{ fontSize: 13 }}>{when(s.createdAt)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="ghost" onClick={() => openPreview(s.sourceId)}>Preview</button>{' '}
                    {s.type === 'url' && <><button className="ghost" onClick={() => refresh(s.sourceId)}>Refresh</button>{' '}</>}
                    <button className="danger" onClick={() => remove(s.sourceId)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint mt">Processing usually takes a minute or two. The list refreshes automatically.</p>
      </div>

      {preview && (
        <div className="card">
          <div className="row">
            <h2 className="grow">{preview.name}</h2>
            <button className="ghost" onClick={() => setPreview(null)}>Close</button>
          </div>
          <table>
            <tbody>
              <tr><td>Type</td><td>{preview.type}</td></tr>
              {preview.sourceUrl && <tr><td>Address</td><td><a href={preview.sourceUrl} target="_blank" rel="noopener">{preview.sourceUrl}</a></td></tr>}
              <tr><td>Added</td><td>{when(preview.createdAt)}</td></tr>
              {preview.fetchedAt && <tr><td>Last fetched</td><td>{when(preview.fetchedAt)}</td></tr>}
              <tr><td>Size</td><td>{bytes(preview.sizeBytes)}</td></tr>
              {preview.charCount != null && <tr><td>Text the assistant learned</td><td>{preview.charCount.toLocaleString()} characters</td></tr>}
            </tbody>
          </table>
          {preview.viewUrl && (
            <p className="mt"><a className="btn ghost" href={preview.viewUrl} target="_blank" rel="noopener">Open original file</a></p>
          )}
          {preview.excerpt && (
            <>
              <label>Extracted text{preview.truncated ? ' (first part)' : ''}</label>
              <pre className="code" style={{ maxHeight: 320, whiteSpace: 'pre-wrap' }}>{preview.excerpt}</pre>
            </>
          )}
        </div>
      )}
    </>
  )
}
