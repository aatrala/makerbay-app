import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api } from '../api'

interface Source {
  sourceId: string
  name: string
  type: string
  status: 'awaiting_upload' | 'processing' | 'ready' | 'failed'
  sizeBytes?: number
  createdAt: string
}

export default function Knowledge() {
  const [sources, setSources] = useState<Source[]>([])
  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
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

  const addText = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await api('POST', '/v1/assistant/sources', { type: 'text', name: name || 'Pasted text', text })
      setText('')
      setName('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  const addFile = async (file: File) => {
    setError('')
    setBusy(true)
    try {
      const r = await api('POST', '/v1/assistant/sources', {
        type: 'file',
        name: file.name,
        contentType: file.type || 'application/octet-stream',
      })
      const put = await fetch(r.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: file,
      })
      if (!put.ok) throw new Error('upload_failed')
      await api('POST', `/v1/assistant/sources/${r.source.sourceId}/ingest`, {})
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const remove = async (id: string) => {
    await api('DELETE', `/v1/assistant/sources/${id}`)
    await load()
  }

  return (
    <>
      <h1>Knowledge</h1>
      <p>Everything your assistant knows comes from these sources. Add your FAQ, product docs, or policies.</p>

      <div className="card">
        <h2>Add a document</h2>
        <div className="row">
          <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.doc,.docx,.html,.csv"
            onChange={(e) => e.target.files?.[0] && void addFile(e.target.files[0])} disabled={busy} />
        </div>
        <p className="hint mt">PDF, Word, Markdown, HTML, text or CSV — up to 25 MB total on the free plan.</p>
      </div>

      <div className="card">
        <h2>Or paste text</h2>
        <form onSubmit={addText}>
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Store FAQ" />
          <label>Content</label>
          <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} required
            placeholder="Paste your FAQ, opening hours, return policy…" />
          <div className="mt"><button disabled={busy}>{busy ? 'Adding…' : 'Add to knowledge'}</button></div>
        </form>
        {error && <div className="error">{error}</div>}
      </div>

      <div className="card">
        <h2>Sources</h2>
        {sources.length === 0 ? (
          <p>No sources yet — the assistant will answer with its fallback message until you add some.</p>
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Status</th><th>Added</th><th /></tr></thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.sourceId}>
                  <td>{s.name}</td>
                  <td><span className={`chip ${s.status}`}>{s.status.replace('_', ' ')}</span></td>
                  <td>{new Date(s.createdAt).toLocaleDateString()}</td>
                  <td><button className="danger" onClick={() => void remove(s.sourceId)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint mt">Processing usually takes a minute or two. The list refreshes automatically.</p>
      </div>
    </>
  )
}
