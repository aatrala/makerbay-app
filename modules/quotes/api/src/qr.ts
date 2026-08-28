/**
 * The scannable square on a quote or invoice (issue 119).
 *
 * Rendered as SVG on the server, in the API that already holds the token -
 * NOT in the document shell. The shell is deliberately never given the token
 * (three separate enforcements: the CloudFront rewrite drops it, its IAM role
 * denies the quotes tables, and its input carries only a slug), so generating
 * a QR there would mean dismantling the one boundary that makes the link
 * preview safe. The public-view endpoint already reads the row and already
 * returns the JSON the page renders, so it is the honest home for this.
 *
 * SVG rather than a PNG data URI for one reason that matters: this has to
 * survive printing. A raster square sized for a phone screen is a blurry mess
 * at 300 dpi, and a printed invoice is the ONE place where a scannable code
 * has no substitute - there is no address bar on paper.
 *
 * Precedent: modules/presence/api/src/handler.ts already generates a QR
 * server-side with the same library, for the business page.
 */

/**
 * Error correction is deliberately left at the library default (M, ~15%).
 *
 * Higher correction sounds safer and is not: it adds modules, and at these URL
 * lengths (71-99 characters) the code is already version 6-7, around 41-45
 * modules square. More modules at a fixed display size means smaller modules,
 * which is the actual failure mode when someone points a phone at a screen at
 * an angle. Physical size and quiet zone buy far more than ECC does here.
 */
export interface DocQr {
  /** Inline SVG markup. Never a URL, so it works offline and in print. */
  svg: string
  /**
   * The same address as plain text.
   *
   * Always sent alongside, never optional. A QR is an image of a URL: a screen
   * reader user gets nothing from it, and somebody with no working camera gets
   * nothing from it either. The typed address is what makes the square an
   * enhancement rather than a gate.
   */
  url: string
}

export async function docQr(url: string): Promise<DocQr | undefined> {
  if (!url) return undefined
  try {
    const { toString } = await import('qrcode')
    const svg = await toString(url, {
      type: 'svg',
      // A quiet zone of 2 modules. The spec asks for 4; 2 is the practical
      // floor and the page adds white space around it anyway.
      margin: 2,
      // Explicit black on WHITE, never transparent. A transparent QR inherits
      // whatever is behind it, and a dark-on-dark square is unscannable - the
      // existing QrBlock relies on a stylesheet rule to avoid exactly this.
      color: { dark: '#000000', light: '#ffffff' },
    })
    // The library emits its own width/height; strip them so CSS and the print
    // stylesheet decide the size. viewBox is what keeps it crisp at any scale.
    return { svg: svg.replace(/\s(width|height)="[^"]*"/g, ''), url }
  } catch (err) {
    // A missing square must never cost the customer their document.
    console.warn('qr generation failed', { err: String(err) })
    return undefined
  }
}
