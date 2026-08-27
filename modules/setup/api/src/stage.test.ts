import { describe, expect, it } from 'vitest'
import { stageArtifact } from './handler'
import { EMPTY, type ExtractedFacts } from './extract'

const facts = (over: Partial<ExtractedFacts> = {}): ExtractedFacts => ({ ...EMPTY, ...over })
const stage = (f: ExtractedFacts, current: Record<string, unknown> = {}) =>
  stageArtifact('T1', '01J000000000000000000000AA', f, current, 'https://example.com', 'excerpt')

describe('stageArtifact', () => {
  it('proposes a field the page has not filled in', () => {
    const a = stage(facts({ headline: 'Blocked drains, Newtown' }), { headline: '' })
    expect(a.proposed.headline).toBe('Blocked drains, Newtown')
    expect(a.diff).toEqual([
      { field: 'headline', label: 'Headline', from: '(empty)', to: 'Blocked drains, Newtown' },
    ])
  })

  // The rule that keeps this trustworthy. A blank field is an opportunity; a
  // filled one is a decision the owner already made, and an agent quietly
  // replacing it is the failure mode people fear most.
  it('never overwrites something the owner already wrote', () => {
    const a = stage(
      facts({ headline: 'Scraped headline', intro: 'Scraped intro' }),
      { headline: 'The one I wrote myself' },
    )
    expect(a.proposed.headline).toBeUndefined()
    expect(a.proposed.intro).toBe('Scraped intro')
    expect(a.diff.map((d) => d.field)).toEqual(['intro'])
  })

  it('treats whitespace as filled in, not as empty', () => {
    const a = stage(facts({ headline: 'Scraped' }), { headline: '   ' })
    expect(a.proposed.headline).toBe('Scraped')
  })

  it('stages nothing when the page already says it all', () => {
    const a = stage(facts({ headline: 'X' }), { headline: 'Already here' })
    expect(a.diff).toHaveLength(0)
    expect(Object.keys(a.proposed)).toHaveLength(0)
  })

  it('skips an empty list rather than clearing a field with it', () => {
    const a = stage(facts({ serviceAreas: [] }), {})
    expect(a.proposed.serviceAreas).toBeUndefined()
  })

  it('carries provenance for every fact, so a human can check the source', () => {
    const a = stage(facts({ headline: 'H', phone: '0412 555 908' }), {})
    for (const d of a.diff) {
      expect(a.provenance[d.field].url).toBe('https://example.com')
      expect(a.provenance[d.field].excerpt).toBe('excerpt')
    }
  })

  it('stages rather than applies, so nothing reaches a live page here', () => {
    expect(stage(facts({ headline: 'H' })).status).toBe('staged')
  })

  it('renders a list as readable text in the diff, not as an array dump', () => {
    const a = stage(facts({ serviceAreas: ['Newtown', 'Erskineville'] }), {})
    expect(a.diff[0].to).toBe('Newtown, Erskineville')
  })
})
