import { useEffect, useState } from 'react'
import { api, API_BASE, CHAT_BASE, WIDGET_BASE, explain, type Me, Empty, Notice, Skeleton, when } from '@makerbay/web-kit'

interface ApiKey {
  keyId: string
  type: 'secret' | 'publishable'
  label: string
  createdAt: string
}

type Tab = 'api' | 'embed' | 'hosted'

export default function DeployPage({ me }: { me: Me }) {
  const [tab, setTab] = useState<Tab>('embed')
  const [keys, setKeys] = useState<ApiKey[] | null>(null)
  const [newSecret, setNewSecret] = useState('')
  const [label, setLabel] = useState('')
  const [widgetKey, setWidgetKey] = useState('')
  const [copied, setCopied] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const slug = me.tenant?.slug ?? ''
  const hostedUrl = `${CHAT_BASE}/${slug}`
  const snippet = `<script src="${WIDGET_BASE}/widget.js"\n  data-key="${widgetKey || 'mb_pk_YOUR_PUBLISHABLE_KEY'}"></script>`

  const load = async () => {
    try {
      const r = await api('GET', '/v1/core/keys')
      setKeys(r.keys ?? [])
    } catch (e) {
      setError(explain(e))
      setKeys([])
    }
  }
  useEffect(() => { void load() }, [])

  const run = async (fn: () => Promise<void>) => {
    setError(''); setBusy(true)
    try { await fn(); await load() } catch (e) { setError(explain(e)) } finally { setBusy(false) }
  }

  const createKey = (type: 'secret' | 'publishable') =>
    void run(async () => {
      const r = await api('POST', '/v1/core/keys', { type, label: label || `${type} key` })
      setNewSecret(r.secret)
      if (type === 'publishable') setWidgetKey(r.secret)
      setLabel('')
    })

  const createWidgetKey = () =>
    void run(async () => {
      const r = await api('POST', '/v1/core/keys', { type: 'publishable', label: 'Website widget' })
      setWidgetKey(r.secret)
    })

  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text)
    setCopied(what)
    setTimeout(() => setCopied(''), 2500)
  }

  const revoke = (keyId: string, name: string) => {
    if (!confirm(`Revoke "${name}"? Anything using it will stop working immediately.`)) return
    void run(async () => { await api('DELETE', `/v1/core/keys/${keyId}`) })
  }

  const curl = `curl -X POST ${API_BASE}/v1/assistant/chat \\
  -H "Authorization: Bearer mb_sk_YOUR_KEY" \\
  -H "content-type: application/json" \\
  -d '{"message": "What are your opening hours?"}'`

  return (
    <>
      <h1>Deploy</h1>
      <p>Put your assistant where your customers already are.</p>

      <div className="tabs">
        <button className={tab === 'embed' ? 'on' : ''} onClick={() => setTab('embed')}>Embed widget</button>
        <button className={tab === 'hosted' ? 'on' : ''} onClick={() => setTab('hosted')}>Hosted page</button>
        <button className={tab === 'api' ? 'on' : ''} onClick={() => setTab('api')}>API</button>
      </div>

      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}
      {copied && <Notice tone="ok">{copied} copied to your clipboard.</Notice>}

      {tab === 'embed' && (
        <div className="card">
          <h2>Add a chat bubble to your website</h2>
          <p>
            Paste this just before the closing <code>&lt;/body&gt;</code> tag on any page.
            Works on WordPress, Shopify, Wix, Squarespace or hand-written HTML.
          </p>
          {!widgetKey && (
            <p className="hint">
              Generate a publishable key to fill in the snippet. It is safe in public page source —
              it can only chat, never read or change your account.
            </p>
          )}
          <div className="row">
            <button onClick={createWidgetKey} disabled={busy}>
              {widgetKey ? 'Generate another key' : 'Generate my snippet'}
            </button>
            {widgetKey && <button className="ghost" onClick={() => copy(snippet, 'Snippet')}>Copy snippet</button>}
          </div>
          <pre className="code mt">{snippet}</pre>
          {widgetKey && (
            <p className="hint">This key is shown once. If you lose it, generate another — old keys keep working until you revoke them under the API tab.</p>
          )}
          <p className="meta mt">
            Options: <code>data-color="#c2410c"</code> to match your brand, <code>data-position="left"</code> to move the bubble.
          </p>
        </div>
      )}

      {tab === 'hosted' && (
        <div className="card">
          <h2>Your ready-made chat page</h2>
          <p>No website needed — share this link anywhere: email signatures, social bios, QR codes on printed material.</p>
          <div className="row">
            <input className="grow" readOnly value={hostedUrl} onFocus={(e) => e.target.select()} aria-label="Your chat page address" />
            <button className="ghost" onClick={() => copy(hostedUrl, 'Link')}>Copy link</button>
            <a className="btn" href={hostedUrl} target="_blank" rel="noopener">Open</a>
          </div>
          <p className="meta mt">The page uses your assistant's name, greeting and brand colour from the Behavior screen.</p>
        </div>
      )}

      {tab === 'api' && (
        <>
          <div className="card">
            <h2>Call the assistant from your own software</h2>
            <pre className="code">{curl}</pre>
            <p className="hint">
              Secret keys (<code>mb_sk_…</code>) have full access — keep them on your server.
              Publishable keys (<code>mb_pk_…</code>) can only chat and are safe to ship in a website or app.
            </p>
          </div>

          <div className="card">
            <h2>API keys</h2>
            {newSecret && (
              <div className="card tint-warn">
                <strong>Copy this key now — it will not be shown again.</strong>
                <pre className="code">{newSecret}</pre>
                <button className="ghost" onClick={() => copy(newSecret, 'Key')}>Copy key</button>
              </div>
            )}
            <div className="row">
              <input className="grow" placeholder="Key label (e.g. Production backend)" value={label}
                onChange={(e) => setLabel(e.target.value)} aria-label="Key label" />
              <button onClick={() => createKey('secret')} disabled={busy}>New secret key</button>
              <button className="ghost" onClick={() => createKey('publishable')} disabled={busy}>New publishable key</button>
            </div>

            {!keys ? <div className="mt"><Skeleton rows={3} /></div> : keys.length === 0 ? (
              <Empty title="No keys yet">
                You only need a key to call the assistant from your own code, or to embed the widget.
              </Empty>
            ) : (
              <div className="scroll-x mt">
                <table>
                  <thead><tr><th>Label</th><th>Type</th><th>Created</th><th><span className="visually-hidden">Actions</span></th></tr></thead>
                  <tbody>
                    {keys.map((k) => (
                      <tr key={k.keyId}>
                        <td>{k.label}</td>
                        <td>{k.type === 'secret' ? 'secret (server only)' : 'publishable (safe in pages)'}</td>
                        <td className="nowrap">{when(k.createdAt)}</td>
                        <td className="nowrap"><button className="danger" onClick={() => revoke(k.keyId, k.label)}>Revoke</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </>
  )
}
