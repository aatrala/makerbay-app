import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { accentOn, contrastRatio, INK, PAPER, readableOn, shade, tint } from './color'

/** A spread of real trade-brand accents, plus the ends of the range. */
const PALETTE = [
  '#c2410c', '#dc2626', '#ea580c', '#f59e0b', '#eab308', '#facc15',
  '#84cc16', '#22c55e', '#16a34a', '#10b981', '#14b8a6', '#0ea5e9',
  '#2563eb', '#4f46e5', '#7c3aed', '#c026d3', '#db2777', '#0f172a',
  '#334155', '#78716c', '#ffffff', '#000000',
]

describe('readableOn', () => {
  it('always picks the higher-contrast foreground', () => {
    for (const hex of PALETTE) {
      const picked = readableOn(hex)
      const other = picked === INK ? PAPER : INK
      expect(contrastRatio(hex, picked)).toBeGreaterThanOrEqual(contrastRatio(hex, other))
    }
  })

  // The bug this function exists to prevent: a threshold cannot be right for
  // every hue, and mid-brightness greens and ambers used to get white at 1.9:1.
  it('clears WCAG AA large-text (3:1) on every accent in the palette', () => {
    for (const hex of PALETTE) {
      expect(contrastRatio(hex, readableOn(hex))).toBeGreaterThanOrEqual(3)
    }
  })

  it('falls back to paper on malformed input', () => {
    for (const bad of ['', 'red', '#ccc', '#12345', 'rgb(1,2,3)']) {
      expect(readableOn(bad)).toBe(PAPER)
    }
  })

  it('is case- and hash-insensitive', () => {
    expect(readableOn('#EAB308')).toBe(readableOn('#eab308'))
    expect(readableOn('eab308')).toBe(readableOn('#eab308'))
  })
})

describe('the widget copy in chat.js', () => {
  // chat.js is served raw to browsers and cannot import, so it carries its own
  // copy. This locks the two together: the help centre, the public page and
  // the chat bubble must colour one business's accent identically.
  const src = readFileSync(
    fileURLToPath(new URL('../../../modules/assistant/embed/src/chat.js', import.meta.url)),
    'utf8',
  )
  const body = src.slice(src.indexOf('function readableOn(hex)'))
  const embedded = new Function(`${body.slice(0, body.indexOf('\n  }') + 4)}; return readableOn`)() as (
    h: string,
  ) => string

  it('agrees with the canonical implementation across the palette', () => {
    for (const hex of PALETTE) expect(embedded(hex)).toBe(readableOn(hex))
  })

  it('agrees on malformed input', () => {
    for (const bad of ['', 'red', '#ccc']) expect(embedded(bad)).toBe(readableOn(bad))
  })
})

describe('shade and tint', () => {
  it('move toward black and white without leaving the range', () => {
    expect(shade('#ffffff', 1)).toBe('#000000')
    expect(tint('#000000', 1)).toBe('#ffffff')
    expect(shade('#c2410c', 0)).toBe('#c2410c')
  })
})

describe('accentOn', () => {
  // The dark card an email lands on when a client inverts. Most trade accents
  // fail outright against it before lightening.
  const DARK = '#292524'

  it('lifts every accent in the palette to a readable contrast', () => {
    for (const hex of PALETTE) {
      expect(contrastRatio(accentOn(hex, DARK), DARK), hex).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('leaves an accent that already reads well alone', () => {
    // A pale accent needs no help; lightening it further would wash it out.
    const pale = '#fcd34d'
    expect(contrastRatio(pale, DARK)).toBeGreaterThanOrEqual(4.5)
    expect(accentOn(pale, DARK)).toBe(pale)
  })

  it('actually moves the ones that fail, rather than returning them unchanged', () => {
    // MakerBay orange is about 2:1 on this surface, so it must change.
    expect(accentOn('#c2410c', DARK)).not.toBe('#c2410c')
  })

  it('falls back to paper on malformed input rather than emitting nonsense', () => {
    expect(accentOn('not-a-colour', DARK)).toBe(PAPER)
  })
})
