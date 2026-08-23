import { useEffect, useState } from 'react'
import { api, API_BASE } from '../api'

interface ApiKey {
  keyId: string
  type: 'secret' | 'publishable'
  label: string
  createdAt: string
}

type Tab = 'api' | 'embed' | 'hosted'

export default function DeployPage() {
  const [tab, setTab] = useState<Tab>('api')
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [newSecret, setNewSecret] = useState('')
  const [label, setLabel] = useState('')

  const load = async () => {
    const r = await api('GET', '/v1/core/keys')
    setKeys(r.keys ?? [])
  }
  useEffect(() => { void load() }, [])

  const createKey = async (type: 'secret' | 'publishable') => {
    const r = await api('POST', '/v1/core/keys', { type, label: label || `${type} key` })
    setNewSecret(r.secret)
    setLabel('')
    await load()
  }

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
        <button className={tab === 'api' ? 'on' : ''} onClick={() => setTab('api')}>API</button>
        <button className={tab === 'embed' ? 'on' : ''} onClick={() => setTab('embed')}>Embed widget</button>
        <button className={tab === 'hosted' ? 'on' : ''} onClick={() => setTab('hosted')}>Hosted page</button>
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
          <h2>Embeddable chat widget</h2>
          <p>A copy-paste snippet that adds a chat bubble to any website. <strong>Coming in the next release</strong> — the publishable keys it will use are ready today under the API tab.</p>
        </div>
      )}

      {tab === 'hosted' && (
        <div className="card">
          <h2>Hosted chat page</h2>
          <p>A ready-made branded page at chat.makerbay.app/your-business — share it anywhere, no website needed. <strong>Coming in the next release.</strong></p>
        </div>
      )}
    </>
  )
}
