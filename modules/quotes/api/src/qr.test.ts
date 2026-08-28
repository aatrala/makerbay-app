import { describe, expect, it } from 'vitest'
import { docQr } from './qr'
import { docUrl } from './links'

/**
 * The scannable square (issue 119).
 *
 * Generated in the API that already holds the token, never in the document
 * shell - the shell is deliberately never given the token, and rendering a QR
 * there would mean dismantling the boundary that keeps the link preview safe.
 */

const URL = docUrl('quote', 'dunn-plumbing', 'Q-014', 'IdC_9xKq2mVvA1sPzR7bWnLe')

describe('docQr', () => {
  it('renders SVG, so it survives being printed', async () => {
    const qr = await docQr(URL)
    expect(qr?.svg).toContain('<svg')
    // A raster square sized for a phone screen is a blurry mess at 300 dpi,
    // and paper is the one place the code has no substitute.
    expect(qr?.svg).not.toContain('data:image')
  })

  /**
   * The address always ships beside the square. A QR is an image of a URL: a
   * screen-reader user gets nothing from it, and neither does anyone whose
   * camera will not focus.
   */
  it('returns the address as text alongside', async () => {
    expect((await docQr(URL))?.url).toBe(URL)
  })

  it('scales with the container rather than a baked-in size', async () => {
    const svg = (await docQr(URL))!.svg
    // viewBox is what keeps it crisp at print DPI; a fixed width/height is
    // what stops the print stylesheet enlarging it.
    expect(svg).toContain('viewBox')
    expect(svg).not.toMatch(/<svg[^>]+\swidth="/)
    expect(svg).not.toMatch(/<svg[^>]+\sheight="/)
  })

  // A transparent QR inherits whatever is behind it, and dark-on-dark is
  // unscannable. The old QrBlock relied on a stylesheet rule to avoid this.
  it('paints white explicitly rather than relying on the page', async () => {
    expect((await docQr(URL))!.svg).toContain('#ffffff')
  })

  it('encodes the whole address, token included', async () => {
    // The square is only useful if it opens the document, and the token is
    // the entire authorisation.
    const long = docUrl('quote', 'a-very-long-business-name-here', 'SP-Q-9999', 'x'.repeat(32))
    const qr = await docQr(long)
    expect(qr).toBeDefined()
    expect(qr?.url).toBe(long)
  })

  it('handles the longest address we can issue', async () => {
    const longest = docUrl('invoice', 'x'.repeat(40), 'SP-INV-9999', 'y'.repeat(43))
    expect((await docQr(longest))?.svg).toContain('<svg')
  })

  // A missing square must never cost the customer their document.
  it('gives nothing rather than throwing on an empty address', async () => {
    expect(await docQr('')).toBeUndefined()
  })
})
