import { ulid } from '@makerbay/core'
import type { ExtractedFacts } from './extract'
import type { JobArtifact, JobKind } from './db'

/**
 * One definition per menu line, all running the same machine: read, extract,
 * validate, stage a diff, wait for the owner. A kind supplies three things -
 * what it touches, what it needs to know, and how to turn extracted facts
 * into a staged change. It never supplies a pipeline.
 *
 * The rule every kind inherits, and the one that makes this safe to point at
 * a live workspace: **a value the owner already set is never overwritten.** A
 * blank field is an opportunity; a filled one is a decision they made.
 */

export interface KindDef {
  /** The menu line, in the owner's words. */
  label: string
  /** Frozen onto the job at scope time and asserted before every write. */
  resources: string[]
  scopes: string[]
  /** What the review screen lists under "not changed". */
  fields: string[]
  /**
   * Turn validated facts into a staged change against what is there now.
   * Pure: no I/O, so it is unit-testable and cannot surprise at runtime.
   */
  stage: (facts: ExtractedFacts, current: CurrentState) => StagedChange
}

/** What the workspace looks like now, read server-side before staging. */
export interface CurrentState {
  presence: Record<string, unknown>
  services: Array<{ serviceId: string; name: string; priceCents?: number; durationMinutes?: number }>
}

export interface StagedChange {
  proposed: Record<string, unknown>
  diff: JobArtifact['diff']
}

const asText = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : String(v ?? ''))
const money = (cents?: number) => (cents == null ? 'no price' : `$${(cents / 100).toFixed(2)}`)

const PAGE_FIELDS: Array<{ key: keyof ExtractedFacts; field: string; label: string }> = [
  { key: 'headline', field: 'headline', label: 'Headline' },
  { key: 'intro', field: 'intro', label: 'Intro' },
  { key: 'phone', field: 'phone', label: 'Phone' },
  { key: 'email', field: 'email', label: 'Email' },
  { key: 'serviceAreas', field: 'serviceAreas', label: 'Areas you cover' },
]

export const KINDS: Record<JobKind, KindDef> = {
  'presence.page': {
    label: 'Your page',
    resources: ['presence.config'],
    scopes: ['presence:config:write'],
    fields: PAGE_FIELDS.map((f) => f.label),
    stage: (facts, current) => {
      const proposed: Record<string, unknown> = {}
      const diff: JobArtifact['diff'] = []
      for (const { key, field, label } of PAGE_FIELDS) {
        const value = facts[key]
        if (value === undefined || (Array.isArray(value) && value.length === 0)) continue
        if (asText(current.presence[field]).trim()) continue
        proposed[field] = value
        diff.push({ field, label, from: '(empty)', to: asText(value) })
      }
      return { proposed, diff }
    },
  },

  'booking.services': {
    label: 'Services and prices',
    resources: ['booking.services'],
    scopes: ['booking:services:write'],
    fields: ['Services'],
    stage: (facts, current) => {
      // Only services the workspace does not already have. Matching on a
      // normalised name rather than an id, because the owner typed theirs and
      // the website wrote ours, and neither knows about the other.
      const known = new Set(current.services.map((s) => s.name.trim().toLowerCase()))
      const additions = facts.services.filter((s) => !known.has(s.name.trim().toLowerCase()))
      const diff: JobArtifact['diff'] = additions.map((s) => ({
        field: `service:${ulid()}`,
        label: s.name,
        from: '(not on your list)',
        to: [money(s.priceCents), s.durationMinutes ? `${s.durationMinutes} min` : null]
          .filter(Boolean)
          .join(', '),
      }))
      return { proposed: { services: additions }, diff }
    },
  },
}
