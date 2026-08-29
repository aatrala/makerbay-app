import { DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { ddb } from './db'
import { getContact } from './contacts'

/**
 * Erasing one person, rather than one workspace (issue 133).
 *
 * `deleteContact` removed a single row from the contacts table and nothing
 * else. Meanwhile `contactId` is written onto quotes, bookings, requests,
 * reviews, invoices and payments, and the whole interaction history lives in
 * contactEvents. So a tradesperson clicked delete, believed they had served an
 * erasure request, told the homeowner so, and almost all of the data was still
 * there. That is worse than not offering the button: it made our customer
 * non-compliant through a UI affordance, and it is the reason this file
 * exists.
 *
 * Two rules shape everything below.
 *
 * It lives in packages/core because the cascade crosses six modules, and
 * CLAUDE.md says cross-module data access belongs here rather than hand-rolled
 * in module code. That rule is exactly what this operation would otherwise
 * break.
 *
 * And it never silently half-deletes. Some records genuinely must survive an
 * erasure request, and the person asking deserves to be told which and why -
 * so the refusals are part of the return value, not a comment in the source.
 */

const Tables = {
  contacts: () => process.env.TABLE_CONTACTS!,
  contactEvents: () => process.env.TABLE_CONTACTEVENTS!,
  quotes: () => process.env.TABLE_QUOTES,
  bookings: () => process.env.TABLE_BOOKINGS,
  requests: () => process.env.TABLE_REQUESTS,
  reviews: () => process.env.TABLE_REVIEWS,
  invoices: () => process.env.TABLE_INVOICES,
  payments: () => process.env.TABLE_PAYMENTS,
}

interface Target {
  label: string
  table: () => string | undefined
  /** The sort key attribute, needed to build a Delete. */
  idAttr: string
}

/** Erased with the contact. Each is that person's own record of their job. */
const ERASE: Target[] = [
  { label: 'quotes', table: Tables.quotes, idAttr: 'quoteId' },
  { label: 'bookings', table: Tables.bookings, idAttr: 'bookingId' },
  { label: 'enquiries', table: Tables.requests, idAttr: 'requestId' },
  { label: 'reviews', table: Tables.reviews, idAttr: 'reviewId' },
]

/**
 * Kept, with the reason stated to whoever asked.
 *
 * These are not oversights. An invoice is a tax record that Australian law
 * requires be kept for seven years, and the published privacy policy commits
 * to exactly that. Deleting a payment would break the books it belongs to.
 */
const KEEP: Array<Target & { reason: string }> = [
  {
    label: 'invoices',
    table: Tables.invoices,
    idAttr: 'invoiceId',
    reason: 'Kept as a tax record. Australian law requires seven years, and'
      + ' erasure does not override a legal obligation to retain.',
  },
  {
    label: 'payments',
    table: Tables.payments,
    idAttr: 'paymentId',
    reason: 'Kept with the invoice it belongs to, for the same reason.',
  },
]

export interface FootprintEntry {
  label: string
  count: number
  /** Present when the records are kept rather than erased. */
  keptReason?: string
  /**
   * True when the table is not reachable from this Lambda, so the count is
   * unknown rather than zero. Never report a blind spot as an absence.
   */
  unknown?: boolean
}

export interface Footprint {
  contactId: string
  name?: string
  email?: string
  erase: FootprintEntry[]
  keep: FootprintEntry[]
  /** Things worth saying out loud before somebody presses the button. */
  notes: string[]
}

/**
 * The ids of every row in this target belonging to the contact.
 *
 * contactId is not a key on any of these tables and no index covers it, so
 * this is a filtered query rather than a lookup: DynamoDB reads the tenant's
 * partition and discards non-matching rows. Correct at one workspace's volume,
 * and it avoids adding an index to six tables for an operation that runs a
 * handful of times a year. Revisit if a tenant ever has enough quotes for the
 * scan cost to matter.
 */
async function idsFor(t: Target, tenantId: string, contactId: string): Promise<string[]> {
  const table = t.table()
  if (!table) return []
  const ids: string[] = []
  let start: Record<string, unknown> | undefined
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: '#t = :t',
      FilterExpression: '#c = :c',
      ExpressionAttributeNames: { '#t': 'tenantId', '#c': 'contactId', '#id': t.idAttr },
      ExpressionAttributeValues: { ':t': tenantId, ':c': contactId },
      ProjectionExpression: '#id',
      ExclusiveStartKey: start,
    }))
    for (const item of (r.Items ?? []) as Array<Record<string, unknown>>) {
      const v = item[t.idAttr]
      if (typeof v === 'string') ids.push(v)
    }
    start = r.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (start)
  return ids
}

async function eventKeys(tenantId: string, contactId: string): Promise<string[]> {
  const pk = `${tenantId}#${contactId}`
  const keys: string[] = []
  let start: Record<string, unknown> | undefined
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: Tables.contactEvents(),
      KeyConditionExpression: '#p = :p',
      ExpressionAttributeNames: { '#p': 'pk' },
      ExpressionAttributeValues: { ':p': pk },
      ProjectionExpression: 'sk',
      ExclusiveStartKey: start,
    }))
    for (const item of (r.Items ?? []) as Array<{ sk?: string }>) {
      if (item.sk) keys.push(item.sk)
    }
    start = r.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (start)
  return keys
}

/**
 * What erasing this contact would actually remove, and what it would not.
 *
 * Shown before the button, because a destructive action reaching across six
 * modules must state its blast radius first. Also the honest answer to a
 * homeowner who asks "what do you hold about me?".
 */
export async function contactFootprint(
  tenantId: string,
  contactId: string,
): Promise<Footprint | undefined> {
  const contact = await getContact(tenantId, contactId)
  if (!contact) return undefined

  const erase: FootprintEntry[] = [
    { label: 'history entries', count: (await eventKeys(tenantId, contactId)).length },
  ]
  for (const t of ERASE) {
    if (!t.table()) {
      erase.push({ label: t.label, count: 0, unknown: true })
      continue
    }
    erase.push({ label: t.label, count: (await idsFor(t, tenantId, contactId)).length })
  }

  const keep: FootprintEntry[] = []
  for (const t of KEEP) {
    if (!t.table()) {
      keep.push({ label: t.label, count: 0, unknown: true, keptReason: t.reason })
      continue
    }
    keep.push({
      label: t.label,
      count: (await idsFor(t, tenantId, contactId)).length,
      keptReason: t.reason,
    })
  }

  const notes = [
    'If this person ever asked to stop receiving email, that record is kept.'
      + ' Deleting it would mean starting to email them again, which is the'
      + ' opposite of what they asked for.',
    'Chat conversations on your page are not linked to a contact until they'
      + ' become an enquiry or a booking, so any earlier anonymous chat is not'
      + ' covered here.',
  ]

  return {
    contactId,
    name: contact.name,
    email: contact.email,
    erase,
    keep,
    notes,
  }
}

export interface ErasureReport {
  contactId: string
  deleted: Record<string, number>
  kept: Record<string, number>
  /** Tables this Lambda could not reach, so nothing was attempted. */
  skipped: string[]
}

/**
 * Erase the person, keeping only what must legally survive.
 *
 * Deliberately not transactional. DynamoDB cannot span this many tables in one
 * transaction, and a partial erasure that reports honestly is better than one
 * that rolls back silently: the report says what went, so a second run
 * finishes the job.
 */
export async function eraseContact(
  tenantId: string,
  contactId: string,
): Promise<ErasureReport> {
  const deleted: Record<string, number> = {}
  const kept: Record<string, number> = {}
  const skipped: string[] = []

  // History first. It is the largest set and the most revealing.
  const sks = await eventKeys(tenantId, contactId)
  for (const sk of sks) {
    await ddb.send(new DeleteCommand({
      TableName: Tables.contactEvents(),
      Key: { pk: `${tenantId}#${contactId}`, sk },
    }))
  }
  deleted['history entries'] = sks.length

  for (const t of ERASE) {
    const table = t.table()
    if (!table) { skipped.push(t.label); continue }
    const ids = await idsFor(t, tenantId, contactId)
    for (const id of ids) {
      await ddb.send(new DeleteCommand({
        TableName: table,
        Key: { tenantId, [t.idAttr]: id },
      }))
    }
    deleted[t.label] = ids.length
  }

  for (const t of KEEP) {
    const table = t.table()
    if (!table) { skipped.push(t.label); continue }
    kept[t.label] = (await idsFor(t, tenantId, contactId)).length
  }

  // The contact row last, so a failure part-way leaves something to retry
  // against rather than an orphaned trail with no way back to it.
  await ddb.send(new DeleteCommand({
    TableName: Tables.contacts(),
    Key: { tenantId, contactId },
  }))
  deleted.contact = 1

  return { contactId, deleted, kept, skipped }
}
