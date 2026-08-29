import { ulid } from '@makerbay/core'
import type { ExtractedFacts } from './extract'
import type { JobArtifact, JobKind } from './db'

/**
 * One definition per menu line, all running the same machine: read, extract,
 * validate, stage a diff, wait for the owner. A kind supplies three things -
 * what it touches, what it needs to know, and how to turn what was read into
 * a staged change. It never supplies a pipeline.
 *
 * The rule every kind inherits, and the one that makes this safe to point at
 * a live workspace: **a value the owner already set is never overwritten.** A
 * blank field is an opportunity; a filled one is a decision they made.
 *
 * Not every job on the menu belongs here. "Get found on Google" and "Set up
 * reviews" need a Google review link and a set of choices that exist nowhere
 * on a business's website, so reading one cannot propose them. Those are
 * guided configuration, a different interaction, and forcing them through
 * this machine would mean shipping a job that proposes almost nothing. See
 * docs/spec-concierge.md.
 */

/** How a kind reads. One page, or a walk of the site. */
export type ReadMode = 'page' | 'site'

export interface StageInput {
  /** Validated facts from the page. Empty for site walks. */
  facts: ExtractedFacts
  /** Pages found on the site. Empty for single-page reads. */
  pages: string[]
}

export interface KindDef {
  /** The menu line, in the owner's words. */
  label: string
  read: ReadMode
  /** Frozen onto the job at scope time and asserted before every write. */
  resources: string[]
  scopes: string[]
  /** What the review screen lists under "not changed". */
  fields: string[]
  /**
   * Turn what was read into a staged change against what is there now. Pure:
   * no I/O, so it is unit-testable and cannot surprise at runtime.
   */
  stage: (input: StageInput, current: CurrentState) => StagedChange
}

/** What the workspace looks like now, read server-side before staging. */
export interface CurrentState {
  presence: Record<string, unknown>
  services: Array<{ serviceId: string; name: string; priceCents?: number; durationMinutes?: number }>
  assistant: Record<string, unknown>
  sources: Array<{ sourceId: string; name: string; url?: string }>
  quotes: Record<string, unknown>
  /** The booking config row, for its hours. Empty when Bookings is untouched. */
  booking: Record<string, unknown>
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

/** Initials, for a document prefix: "Southside Plumbing" -> "SP". */
export const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w))
    .filter((w) => !['and', 'the', 'of', 'for'].includes(w.toLowerCase()))
    .map((w) => w[0].toUpperCase())
    .join('')
    .slice(0, 4)

export const KINDS: Record<JobKind, KindDef> = {
  'presence.page': {
    label: 'Your page',
    read: 'page',
    resources: ['presence.config'],
    scopes: ['presence:config:write'],
    fields: PAGE_FIELDS.map((f) => f.label),
    stage: ({ facts }, current) => {
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
    read: 'page',
    resources: ['booking.services'],
    scopes: ['booking:services:write'],
    fields: ['Services'],
    stage: ({ facts }, current) => {
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

  /**
   * Opening hours off the website (issue 145).
   *
   * The setup flow read services, prices, contact details and the assistant's
   * knowledge, and stopped short of the one thing nearly every trade page
   * states plainly. Without it a new workspace fell back to Monday to Friday,
   * nine to five - wrong for most salons and for anybody working weekends,
   * and wrong in the direction that loses bookings silently.
   */
  'booking.hours': {
    label: 'When you are open',
    read: 'page',
    resources: ['booking.config'],
    scopes: ['booking:config:write'],
    fields: ['Opening hours'],
    stage: ({ facts }, current) => {
      if (!facts.hours) return { proposed: {}, diff: [] }
      // Never overwrite hours the owner has already set. Everything this flow
      // proposes is an addition to an empty field; the website is evidence,
      // not an authority over what somebody typed themselves.
      const existing = current.booking?.hours
      if (existing && typeof existing === 'object' && Object.keys(existing).length > 0) {
        return { proposed: {}, diff: [] }
      }
      const DAY_NAMES: Record<string, string> = {
        mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
        fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
      }
      const diff: JobArtifact['diff'] = Object.entries(facts.hours).map(([day, ranges]) => ({
        field: `hours:${day}`,
        label: DAY_NAMES[day] ?? day,
        from: '(not set)',
        to: (ranges ?? []).map((r) => `${r.from} to ${r.to}`).join(', '),
      }))
      return { proposed: { hours: facts.hours }, diff }
    },
  },

  'assistant.knowledge': {
    label: 'What your assistant knows',
    read: 'site',
    resources: ['assistant.sources'],
    scopes: ['assistant:sources:write'],
    fields: ['Pages'],
    stage: ({ pages }, current) => {
      // A page already on the list stays there. Comparing on the URL without
      // its trailing slash or fragment, because the same page reached two ways
      // is still the same page.
      const norm = (u: string) => u.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase()
      const known = new Set(current.sources.map((s) => norm(s.url ?? s.name)))
      const additions = pages.filter((u) => !known.has(norm(u)))
      const diff: JobArtifact['diff'] = additions.map((u) => ({
        field: `page:${ulid()}`,
        label: new URL(u).pathname === '/' ? 'Home' : new URL(u).pathname,
        from: '(not read yet)',
        to: u,
      }))
      return { proposed: { pages: additions }, diff }
    },
  },

  'help.centre': {
    label: 'Your help centre',
    read: 'page',
    resources: ['assistant.config'],
    scopes: ['assistant:config:write'],
    fields: ['Help centre', 'Title', 'Intro'],
    stage: ({ facts }, current) => {
      const proposed: Record<string, unknown> = {}
      const diff: JobArtifact['diff'] = []
      // Nothing learned means nothing to put in a help centre, so do not
      // propose switching a public-facing surface on. An empty help centre
      // published under a business's name is worse than no help centre.
      const name = facts.businessName?.trim()
      if (!name && !facts.intro) return { proposed, diff }
      if (current.assistant.helpEnabled !== true) {
        proposed.helpEnabled = true
        diff.push({ field: 'helpEnabled', label: 'Help centre', from: 'off', to: 'on' })
      }
      if (name && !asText(current.assistant.helpTitle).trim()) {
        const title = `${name} help`.slice(0, 80)
        proposed.helpTitle = title
        diff.push({ field: 'helpTitle', label: 'Title', from: '(empty)', to: title })
      }
      // The intro is the business's own words about itself, not a sentence we
      // wrote for them.
      if (facts.intro && !asText(current.assistant.helpIntro).trim()) {
        const intro = facts.intro.slice(0, 300)
        proposed.helpIntro = intro
        diff.push({ field: 'helpIntro', label: 'Intro', from: '(empty)', to: intro })
      }
      return { proposed, diff }
    },
  },

  'quotes.documents': {
    label: 'How your quotes look',
    read: 'page',
    resources: ['quotes.config'],
    scopes: ['quotes:config:write'],
    fields: ['Document prefix'],
    stage: ({ facts }, current) => {
      // Deliberately narrow. A document footer usually carries an ABN or a
      // licence number, and those may never come off a scrape (extract.ts
      // refuses them), so the owner types that themselves. The prefix is the
      // one thing a business name genuinely tells us.
      const proposed: Record<string, unknown> = {}
      const diff: JobArtifact['diff'] = []
      const name = facts.businessName?.trim()
      const prefix = name ? initialsOf(name) : ''
      if (prefix.length >= 2 && !asText(current.quotes.docPrefix).trim()) {
        proposed.docPrefix = prefix
        diff.push({
          field: 'docPrefix',
          label: 'Document prefix',
          from: '(none)',
          to: `${prefix}, so your quotes read ${prefix}-Q-001`,
        })
      }
      return { proposed, diff }
    },
  },
}
