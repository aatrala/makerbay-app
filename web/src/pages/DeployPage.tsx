import { useEffect, useState } from 'react'
import { api, API_BASE, CHAT_BASE, WIDGET_BASE, type Me } from '../api'

interface ApiKey {
  keyId: string
  type: 'secret' | 'publishable'
  label: string
  createdAt: string
}

type Tab = 'api' | 'embed' | 'hosted'

export default function DeployPage({ me }: { me: Me }) {
  const [tab, setTab] = useState<Tab>('embed')
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [newSecret, setNewSecret] = useState('')
  const [label, setLabel] = useState('')
  const [widgetKey, setWidgetKey] = useState('')
  const slug = me.tenant?.slug ?? ''
  const hostedUrl = `${CHAT_BASE}/${slug}`
  const snippet = `<script src="${WIDGET_BASE}/widget.js"\n  data-key="${widgetKey || 'mb_pk_YOUR_PUBLISHABLE_KEY'}"></script>`

  const load = async () => {
    const r = await api('GET', '/v1/core/keys')
    setKeys(r.keys ?? [])
  }
  useEffect(() => { void load() }, [])

  const createKey = async (type: 'secret' | 'publishable') => {
    const r = await api('POST', '/v1/core/keys', { type, label: label || `${type} key` })
    setNewSecret(r.secret)
    if (type === 'publishable') setWidgetKey(r.secret)
    setLabel('')
    await load()
  }

  const createWidgetKey = async () => {
    const r = await api('POST', '/v1/core/keys', { type: 'publishable', label: 'Website widget' })
    setWidgetKey(r.secret)
    await load()
  }

  const copy = (text: string) => void navigator.clipboard?.writeText(text)

  const revoke = async (keyId: string) => {
    await api('DELETE', `/v1/core/keys/${keyId}`)
    await load()
  }

  const curl = `curl -X POST ${API_BASE}/v1/assistant/chat \\
  -H "Authorization: Bearer mb_sk_YOUR_KEY" \\
  -H "content-type: application/json" \\
  -d '{"message": "What are your opening hours?"}'`

  return (
    <>
      <h1>Deploy</h1>
      <p>Put your assistant where your customers are.</p>
      <div className="tabs">
        <button className={tab === 'embed' ? 'on' : ''} onClick={() => setTab('embed')}>Embed widget</button>
        <button className={tab === 'hosted' ? 'on' : ''} onClick={() => setTab('hosted')}>Hosted page</button>
        <button className={tab === 'api' ? 'on' : ''} onClick={() => setTab('api')}>API</button>
      </div>

      {tab === 'api' && (
        <>
          <div className="card">
            <h2>Call the assistant from your own software</h2>
            <pre className="code">{curl}</pre>
            <p className="hint">Secret keys (mb_sk_…) have full access — keep them server-side. Publishable keys (mb_pk_…) can only chat and are safe to ship in a website or app.</p>
          </div>
          <div className="card">
            <h2>API keys</h2>
            {newSecret && (
              <div className="card" style={{ background: '#f0fdf7', borderColor: '#b5e5cf' }}>
                <strong>Copy your new key now — it won't be shown again.</strong>
                <pre className="code">{newSecret}</pre>
              </div>
            )}
            <div className="row">
              <input className="grow" placeholder="Key label (e.g. Production backend)" value={label} onChange={(e) => setLabel(e.target.value)} />
              <button onClick={() => void createKey('secret')}>New secret key</button>
              <button className="ghost" onClick={() => void createKey('publishable')}>New publishable key</button>
            </div>
            {keys.length > 0 && (
              <table className="mt">
                <thead><tr><th>Label</th><th>Type</th><th>Created</th><th /></tr></thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k.keyId}>
                      <td>{k.label}</td>
                      <td>{k.type}</td>
                      <td>{new Date(k.createdAt).toLocaleDateString()}</td>
                      <td><button className="danger" onClick={() => void revoke(k.keyId)}>Revoke</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {tab === 'embed' && (
        <div className="card">
          <h2>Add a chat bubble to your website</h2>
          <p>Paste this just before the closing <code>&lt;/body&gt;</code> tag on any page. Works on WordPress, Shopify, Wix, Squarespace or hand-written HTML.</p>
          {!widgetKey && (
            <p className="hint">Create a publishable key to generate your snippet — it's safe to put in public page source, and it can only chat.</p>
          )}
          <div className="row">
            <button onClick={() => void createWidgetKey()}>
              {widgetKey ? 'Generate another key' : 'Generate my snippet'}
            </button>
            {widgetKey && <button className="ghost" onClick={() => copy(snippet)}>Copy snippet</button>}
          </div>
          <pre className="code mt">{snippet}</pre>
          {widgetKey && (
            <p className="hint">This key is shown once. If you lose it, generate another — old keys keep working until you revoke them under the API tab.</p>
          )}
          <p className="hint mt">Options: <code>data-color="#0f6bff"</code> to match your brand, <code>data-position="left"</code> to move the bubble.</p>
        </div>
      )}

      {tab === 'hosted' && (
        <div className="card">
          <h2>Your ready-made chat page</h2>
          <p>No website needed — share this link anywhere: email signatures, social bios, QR codes on printed material.</p>
          <div className="row">
            <input className="grow" readOnly value={hostedUrl} onFocus={(e) => e.target.select()} />
            <button className="ghost" onClick={() => copy(hostedUrl)}>Copy link</button>
            <a className="btn" href={hostedUrl} target="_blank" rel="noopener">Open</a>
          </div>
          <p className="hint mt">The page uses your assistant's name, greeting and brand color from the Behavior screen.</p>
        </div>
      )}
    </>
  )
}
