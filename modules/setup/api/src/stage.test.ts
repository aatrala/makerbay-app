import { describe, expect, it } from 'vitest'
import { stageArtifact } from './handler'
import { EMPTY, type ExtractedFacts } from './extract'
import type { CurrentState } from './kinds'

/**
 * The artifact envelope. What each kind proposes is covered in kinds.test.ts;
 * this is about what wraps it - provenance on every row, staged not applied,
 * and keyed so a job and its artifacts read together.
 */

const facts = (over: Partial<ExtractedFacts> = {}): ExtractedFacts => ({ ...EMPTY, ...over })
const state = (over: Partial<CurrentState> = {}): CurrentState =>
  ({ presence: {}, services: [], ...over })

const stage = (
  f: ExtractedFacts,
  kind: 'presence.page' | 'booking.services' = 'presence.page',
  current: CurrentState = state(),
) => stageArtifact('T1', '01J000000000000000000000AA', kind, f, current, 'https://example.com', 'the excerpt')

describe('stageArtifact', () => {
  it('stages rather than applies, so nothing reaches a live page here', () => {
    expect(stage(facts({ headline: 'H' })).status).toBe('staged')
  })

  it('carries provenance for every row, so a human can check the source', () => {
    const a = stage(facts({ headline: 'H', phone: '0412 555 908' }))
    expect(a.diff.length).toBeGreaterThan(1)
    for (const d of a.diff) {
      expect(a.provenance[d.field].url).toBe('https://example.com')
      expect(a.provenance[d.field].excerpt).toBe('the excerpt')
    }
  })

  it('keys artifacts under the job, so both read together', () => {
    const a = stage(facts({ headline: 'H' }))
    expect(a.pk).toBe('T1#01J000000000000000000000AA')
    expect(a.sk.startsWith('ARTIFACT#presence.page#')).toBe(true)
  })

  it('works the same way for a second kind, because the machine is shared', () => {
    const a = stage(
      facts({ services: [{ name: 'Blocked drain callout', priceCents: 18000 }] }),
      'booking.services',
    )
    expect(a.status).toBe('staged')
    expect(a.kind).toBe('booking.services')
    expect(a.diff[0].label).toBe('Blocked drain callout')
    expect(a.provenance[a.diff[0].field].url).toBe('https://example.com')
  })

  it('proposes nothing from a read that found nothing', () => {
    expect(stage(EMPTY).diff).toHaveLength(0)
  })
})
