import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'

/**
 * A scannable code for a link, generated in the browser - nothing leaves the
 * page. Download gives a print-resolution PNG for vans, counters, flyers and
 * invoices; the on-screen version stays small.
 */
export default function QrBlock({ url, label }: { url: string; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    if (!canvasRef.current || !url) return
    QRCode.toCanvas(canvasRef.current, url, { width: 132, margin: 1, color: { dark: '#1c1917' } })
      .catch(() => setErr(true))
  }, [url])

  const download = () =>
    void QRCode.toDataURL(url, { width: 1200, margin: 2 }).then((data) => {
      const a = document.createElement('a')
      a.href = data
      a.download = `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-qr.png`
      a.click()
    }).catch(() => setErr(true))

  if (err) return null
  return (
    <div className="qr-block">
      <canvas ref={canvasRef} aria-label={`QR code for ${label}`} />
      <div>
        <strong>{label}</strong>
        <p className="meta">Scan to open. Print it on your van, counter card or invoices.</p>
        <button type="button" className="ghost" onClick={download}>Download print-size PNG</button>
      </div>
    </div>
  )
}
