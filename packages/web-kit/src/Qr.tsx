import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'

/**
 * A scannable code for a link, generated in the browser - nothing leaves the
 * page. Download gives a print-resolution PNG for vans, counters and flyers;
 * the on-screen version stays small.
 *
 * Moved here from modules/presence/web on issue 119, because its stylesheet
 * (`.qr-block` in ./styles.css) had always lived in web-kit while the
 * component sat in a module - so any second user had to reach across a
 * package boundary for half of it.
 */
export default function QrBlock({
  url,
  label,
  /**
   * Pixels. The default suits a short public URL.
   *
   * Document links are 71-99 characters, which puts the code at version 6-7,
   * roughly 41-45 modules square. At the old fixed 132px that is about 3px per
   * module - right at the edge of what a phone camera resolves off a screen,
   * and past it through a screen protector or with an unsteady hand. Callers
   * showing a document link should pass 180 or more.
   */
  size = 132,
  /** Replaces the stock caption when the surrounding copy needs to differ. */
  hint,
}: {
  url: string
  label: string
  size?: number
  hint?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    if (!canvasRef.current || !url) return
    QRCode.toCanvas(canvasRef.current, url, {
      width: size,
      margin: 1,
      // White is painted explicitly rather than left transparent. The old
      // version relied on a stylesheet rule for its background, so on any
      // surface that did not inherit it the code rendered dark-on-dark and
      // was unscannable.
      color: { dark: '#1c1917', light: '#ffffff' },
    }).catch(() => setErr(true))
  }, [url, size])

  const download = () =>
    void QRCode.toDataURL(url, { width: 1200, margin: 2, color: { dark: '#1c1917', light: '#ffffff' } })
      .then((data) => {
        const a = document.createElement('a')
        a.href = data
        a.download = `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-qr.png`
        a.click()
      })
      .catch(() => setErr(true))

  if (err) return null
  return (
    <div className="qr-block">
      {/*
        role="img" alongside aria-label: a bare <canvas> with a label is
        announced inconsistently across screen readers. The label names the
        destination in words, because the square itself is unusable to anyone
        who cannot point a camera at it - and every caller shows the address
        as selectable text beside this.
      */}
      <canvas ref={canvasRef} role="img" aria-label={`Scannable code that opens ${label}`} />
      <div>
        <strong>{label}</strong>
        <p className="meta">{hint ?? 'Scan to open. Print it on your van, counter card or invoices.'}</p>
        <button type="button" className="ghost" onClick={download}>Save a print-size image</button>
      </div>
    </div>
  )
}
