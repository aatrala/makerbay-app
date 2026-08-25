import { useEffect, useState } from 'react'

/**
 * The live page, always in sight (issue 51). One shared pane for the Edit
 * and Style tabs: device switch, refresh, open. The iframe URL carries a
 * nonce, so every save busts the CloudFront cache instantly for the owner
 * even though visitors keep the cached copy for a few minutes.
 */
export default function PreviewPane({ pageUrl, refreshKey }: { pageUrl: string; refreshKey: number }) {
  const [mode, setMode] = useState<'desktop' | 'mobile'>('desktop')
  const [nonce, setNonce] = useState(0)

  useEffect(() => { setNonce((n) => n + 1) }, [refreshKey])

  if (!pageUrl) return null
  return (
    <div className="card preview-card">
      <div className="preview-head">
        <h2>Preview</h2>
        <div className="preview-controls">
          <div className="tabs seg">
            <button type="button" className={mode === 'desktop' ? 'on' : ''}
              onClick={() => setMode('desktop')}>Desktop</button>
            <button type="button" className={mode === 'mobile' ? 'on' : ''}
              onClick={() => setMode('mobile')}>Phone</button>
          </div>
          <button type="button" className="ghost" onClick={() => setNonce((n) => n + 1)}>Refresh</button>
          <a className="btn ghost" href={pageUrl} target="_blank" rel="noopener">Open ↗</a>
        </div>
      </div>
      <p className="meta">
        Your saves show here immediately. Visitors see them within about 5 minutes — the page is
        cached for speed.
      </p>
      <div className={`preview-stage${mode === 'mobile' ? ' phone' : ''}`}>
        <div className={mode === 'mobile' ? 'phone-frame' : 'desktop-frame'}>
          <iframe title="Page preview" src={`${pageUrl}?preview=${nonce}`} />
        </div>
      </div>
    </div>
  )
}
