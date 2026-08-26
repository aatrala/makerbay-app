/**
 * Brand-colour helpers. Every surface that paints a business's accent -- the
 * public page, the hosted chat widget, the help centre, the documents -- picks
 * its foreground here, so one business cannot read as white-on-amber in one
 * place and near-black-on-amber in another.
 *
 * The widget's copy lives in modules/assistant/embed/src/chat.js because that
 * file is served raw to browsers and cannot import. color.test.ts reads it and
 * fails if the two ever disagree.
 */

/** Near-black, not pure black: pure black on a mid tone reads as a hole. */
export const INK = '#1c1917'
export const PAPER = '#ffffff'

const HEX_RE = /^#?([0-9a-f]{6})$/i

export const hexRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

export const rgbHex = (r: number, g: number, b: number): string =>
  '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')

/** Mix toward black (factor 0..1 = how far). Keeps hue; brand headers never go mud. */
export const shade = (hex: string, factor: number): string => {
  const [r, g, b] = hexRgb(hex)
  return rgbHex(r * (1 - factor), g * (1 - factor), b * (1 - factor))
}

/** Mix toward white. */
export const tint = (hex: string, factor: number): string => {
  const [r, g, b] = hexRgb(hex)
  return rgbHex(r + (255 - r) * factor, g + (255 - g) * factor, b + (255 - b) * factor)
}

/** WCAG 2.1 relative luminance. Gamma-corrected -- the eye is not linear. */
export const relativeLuminance = (hex: string): number => {
  const [r, g, b] = hexRgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.1 contrast ratio, 1 (identical) to 21 (black on white). */
export const contrastRatio = (a: string, b: string): number => {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Ink or paper on this background, whichever the eye can actually read.
 *
 * Picks by measured contrast rather than a luminance threshold. A threshold
 * has to be right for every hue at once and cannot be: the mid-brightness
 * greens, ambers and teals that trades pick for logos sit either side of any
 * line you draw, which is how white-on-#eab308 (1.9:1) used to ship.
 * Malformed input gets paper, the safe answer on the dark placeholder.
 */
export const readableOn = (hex: string): string => {
  if (!HEX_RE.test(String(hex).trim())) return PAPER
  return contrastRatio(hex, INK) >= contrastRatio(hex, PAPER) ? INK : PAPER
}
