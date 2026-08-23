import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../api'

interface Config {
  name: string
  greeting: string
  instructions: string
  fallbackMessage: string
  brandColor: string
}

export default function Behavior() {
  const [config, setConfig] = useState<Config | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void api('GET', '/v1/assistant/config').then((r) => setConfig(r.config))
  }, [])

  if (!config) return <p>Loading…</p>

  const set = (k: keyof Config) => (e: { target: { value: string } }) => {
    setConfig({ ...config, [k]: e.target.value })
    setSaved(false)
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      const r = await api('PUT', '/v1/assistant/config', config)
      setConfig(r.config)
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed')
    }
  }

  return (
    <>
      <h1>Behavior</h1>
      <p>Shape how your assistant introduces itself and answers.</p>
      <div className="card">
        <form onSubmit={save}>
          <label>Assistant name</label>
          <input value={config.name} onChange={set('name')} />
          <label>Greeting</label>
          <input value={config.greeting} onChange={set('greeting')} />
          <label>Instructions (tone, style, topics to avoid)</label>
          <textarea rows={4} value={config.instructions} onChange={set('instructions')}
            placeholder="Friendly and concise. Never discuss pricing — direct people to sales@…" />
          <label>When the answer isn't in your documents, say:</label>
          <input value={config.fallbackMessage} onChange={set('fallbackMessage')} />
          <label>Brand color</label>
          <input type="color" style={{ width: 60, padding: 2 }} value={config.brandColor} onChange={set('brandColor')} />
          <div className="mt row">
            <button>Save</button>
            {saved && <span className="hint">Saved ✓</span>}
          </div>
          {error && <div className="error">{error}</div>}
        </form>
      </div>
    </>
  )
}
