import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { ddb } from './db'
import { ulid } from './ids'
import type { ContactEventRow, ContactRow, ContactStatus } from './types'

const Tables = {
  contacts: () => process.env.TABLE_CONTACTS!,
  contactEvents: () => process.env.TABLE_CONTACTEVENTS!,
}

export const CONTACT_STATUSES: ContactStatus[] = ['new', 'contacted', 'active', 'won', 'lost']

/**
 * Two people are the same person if they share an email or a phone number.
 * Normalising here rather than at each call site is what stops the same
 * customer arriving three times from three modules.
 */
export const normalizeEmail = (email?: string): string | undefined => {
  const e = email?.trim().toLowerCase()
  return e && e.includes('@') ? e : undefined
}

export const normalizePhone = (phone?: string): string | undefined => {
  if (!phone) return undefined
  const trimmed = phone.trim()
  const plus = trimmed.startsWith('+')
  const digits = trimmed.replace(/\D/g, '')
  // Below 7 digits it is not a phone number, it is a typo.
  if (digits.length < 7) return undefined
  return (plus ? '+' : '') + digits
}

const identityKey = (tenantId: string, email?: string, phone?: string): string | undefined => {
  // Email wins when both are present, so one person keeps one key even if a
  // later module knows only their phone.
  if (email) return `${tenantId}#email:${email}`
  if (phone) return `${tenantId}#phone:${phone}`
  return undefined
}

// ── Reads ────────────────────────────────────────────────────────────────

export async function getContact(tenantId: string, contactId: string): Promise<ContactRow | undefined> {
  const r = await ddb.send(
    new GetCommand({ TableName: Tables.contacts(), Key: { tenantId, contactId } }),
  )
  return r.Item as ContactRow | undefined
}

export async function findContactByIdentity(
  tenantId: string,
  email?: string,
  phone?: string,
): Promise<ContactRow | undefined> {
  // Try both keys: a contact created from a phone number should still be
  // found when a later module supplies the same person's email.
  for (const key of [identityKey(tenantId, email), identityKey(tenantId, undefined, phone)]) {
    if (!key) continue
    const r = await ddb.send(
      new QueryCommand({
        TableName: Tables.contacts(),
        IndexName: 'byIdentity',
        KeyConditionExpression: 'identityKey = :k',
        ExpressionAttributeValues: { ':k': key },
        Limit: 1,
      }),
    )
    const found = r.Items?.[0] as ContactRow | undefined
    if (found) return found
  }
  return undefined
}

export interface ContactPage {
  contacts: ContactRow[]
  cursor?: string
}

/** Newest first. Filtering runs server-side so a large list stays cheap. */
export async function listContacts(
  tenantId: string,
  opts: { limit?: number; cursor?: string; status?: ContactStatus; search?: string } = {},
): Promise<ContactPage> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const filters: string[] = []
  const values: Record<string, unknown> = { ':t': tenantId }
  const names: Record<string, string> = {}

  if (opts.status) {
    filters.push('#st = :st')
    names['#st'] = 'status'
    values[':st'] = opts.status
  }
  if (opts.search?.trim()) {
    // DynamoDB has no case-insensitive contains, so rows carry a lowercased
    // haystack written at save time.
    filters.push('contains(searchText, :q)')
    values[':q'] = opts.search.trim().toLowerCase()
  }

  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.contacts(),
      KeyConditionExpression: 'tenantId = :t',
      ...(filters.length ? { FilterExpression: filters.join(' AND ') } : {}),
      ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
      ExpressionAttributeValues: values,
      // contactId is a ULID, so descending key order is newest first.
      ScanIndexForward: false,
      Limit: filters.length ? limit * 4 : limit,
      ...(opts.cursor ? { ExclusiveStartKey: JSON.parse(Buffer.from(opts.cursor, 'base64url').toString()) } : {}),
    }),
  )

  const contacts = ((r.Items ?? []) as ContactRow[]).slice(0, limit)
  return {
    contacts,
    cursor: r.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(r.LastEvaluatedKey)).toString('base64url')
      : undefined,
  }
}

/** Every contact for an export. Paged internally so one call is enough. */
export async function allContacts(tenantId: string, cap = 10000): Promise<ContactRow[]> {
  const out: ContactRow[] = []
  let cursor: string | undefined
  do {
    const page = await listContacts(tenantId, { limit: 200, cursor })
    out.push(...page.contacts)
    cursor = page.cursor
  } while (cursor && out.length < cap)
  return out.slice(0, cap)
}

// ── Writes ───────────────────────────────────────────────────────────────

export interface ContactInput {
  name?: string
  email?: string
  phone?: string
  status?: ContactStatus
  note?: string
  tags?: string[]
  source?: string
}

const searchText = (c: Partial<ContactRow>): string =>
  [c.name, c.email, c.phone, c.note, ...(c.tags ?? [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .slice(0, 1800)

export async function createContact(tenantId: string, input: ContactInput): Promise<ContactRow> {
  const now = new Date().toISOString()
  const email = normalizeEmail(input.email)
  const phone = normalizePhone(input.phone)
  const row: ContactRow = {
    tenantId,
    contactId: ulid(),
    name: input.name?.trim() || undefined,
    email,
    phone,
    status: input.status ?? 'new',
    note: input.note?.trim() || undefined,
    tags: input.tags?.filter(Boolean).slice(0, 20),
    source: input.source ?? 'manual',
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  }
  const key = identityKey(tenantId, email, phone)
  if (key) row.identityKey = key
  row.searchText = searchText(row)

  await ddb.send(new PutCommand({ TableName: Tables.contacts(), Item: row }))
  return row
}

export async function updateContact(
  tenantId: string,
  contactId: string,
  input: ContactInput,
): Promise<ContactRow | undefined> {
  const existing = await getContact(tenantId, contactId)
  if (!existing) return undefined

  const email = input.email === undefined ? existing.email : normalizeEmail(input.email)
  const phone = input.phone === undefined ? existing.phone : normalizePhone(input.phone)
  const merged: ContactRow = {
    ...existing,
    ...(input.name !== undefined ? { name: input.name.trim() || undefined } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.note !== undefined ? { note: input.note.trim() || undefined } : {}),
    ...(input.tags !== undefined ? { tags: input.tags.filter(Boolean).slice(0, 20) } : {}),
    email,
    phone,
    updatedAt: new Date().toISOString(),
  }
  const key = identityKey(tenantId, email, phone)
  if (key) merged.identityKey = key
  else delete merged.identityKey
  merged.searchText = searchText(merged)

  await ddb.send(new PutCommand({ TableName: Tables.contacts(), Item: merged }))
  return merged
}

/*
 * deleteContact used to live here. It removed one row from the contacts table
 * and nothing else, while contactId is written onto quotes, bookings,
 * enquiries, reviews, invoices and payments, and the whole interaction history
 * sits in contactEvents. An owner who pressed the delete button believed they
 * had served an erasure request and had not.
 *
 * It is gone rather than deprecated, because an exported function that quietly
 * does a tenth of what its name promises is a trap the next caller will fall
 * into. Use eraseContact from ./erasure, which cascades and reports what it
 * kept and why (issue 133).
 */

/**
 * The contract every other module uses. Find this person by email or phone,
 * create them if new, and fill in only the blanks - a module must never
 * overwrite what the business typed by hand with something it inferred.
 */
export async function upsertContact(
  tenantId: string,
  input: ContactInput & { email?: string; phone?: string },
): Promise<ContactRow> {
  const email = normalizeEmail(input.email)
  const phone = normalizePhone(input.phone)
  if (!email && !phone) return createContact(tenantId, input)

  const existing = await findContactByIdentity(tenantId, email, phone)
  if (!existing) return createContact(tenantId, { ...input, email, phone })

  const patch: ContactInput = {
    name: existing.name ?? input.name,
    email: existing.email ?? email,
    phone: existing.phone ?? phone,
    note: existing.note ?? input.note,
  }
  const updated = await updateContact(tenantId, existing.contactId, patch)
  return updated ?? existing
}

// ── Timeline ─────────────────────────────────────────────────────────────

export interface ContactEventInput {
  moduleId: string
  /** Short verb phrase, shown as-is: "asked a question", "booked an appointment". */
  title: string
  body?: string
  /** Deep link into the owning module's screen, when it has one. */
  href?: string
}

/**
 * Append one event to a contact's history. Append-only on purpose: the
 * timeline is a record of what happened, not a mutable summary.
 */
export async function appendContactEvent(
  tenantId: string,
  contactId: string,
  input: ContactEventInput,
): Promise<void> {
  const now = new Date().toISOString()
  const row: ContactEventRow = {
    pk: `${tenantId}#${contactId}`,
    sk: `${now}#${ulid()}`,
    tenantId,
    contactId,
    moduleId: input.moduleId,
    title: input.title,
    body: input.body,
    href: input.href,
    at: now,
  }
  await ddb.send(new PutCommand({ TableName: Tables.contactEvents(), Item: row }))

  // Best-effort: a failed touch must not lose the event that just succeeded.
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: Tables.contacts(),
        Key: { tenantId, contactId },
        UpdateExpression: 'SET lastActivityAt = :now',
        ExpressionAttributeValues: { ':now': now },
        ConditionExpression: 'attribute_exists(contactId)',
      }),
    )
  } catch {
    /* contact was deleted between the two writes */
  }
}

export async function listContactEvents(
  tenantId: string,
  contactId: string,
  limit = 50,
): Promise<ContactEventRow[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.contactEvents(),
      KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': `${tenantId}#${contactId}` },
      ScanIndexForward: false,
      Limit: Math.min(Math.max(limit, 1), 200),
    }),
  )
  return (r.Items ?? []) as ContactEventRow[]
}

// ── CSV ──────────────────────────────────────────────────────────────────

const CSV_COLUMNS = ['name', 'email', 'phone', 'status', 'tags', 'note', 'source', 'createdAt'] as const

const csvCell = (v: unknown): string => {
  const s = v == null ? '' : Array.isArray(v) ? v.join(' ') : String(v)
  // Guard against formula injection when the export is opened in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function contactsToCsv(contacts: ContactRow[]): string {
  const header = CSV_COLUMNS.join(',')
  const rows = contacts.map((c) => CSV_COLUMNS.map((k) => csvCell(c[k])).join(','))
  return [header, ...rows].join('\r\n') + '\r\n'
}

/** Minimal RFC 4180 reader: quoted fields, escaped quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  while (i < src.length) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue }
        quoted = false; i++; continue
      }
      field += ch; i++; continue
    }
    if (ch === '"') { quoted = true; i++; continue }
    if (ch === ',') { row.push(field); field = ''; i++; continue }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''; i++; continue
    }
    field += ch; i++
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim()))
}

export interface ImportResult {
  created: number
  merged: number
  skipped: number
  problems: string[]
}

/**
 * Import a CSV a business exported from somewhere else. Column names are
 * matched loosely because nobody's spreadsheet says "phone" exactly.
 */
export async function importContactsCsv(
  tenantId: string,
  text: string,
  cap = 2000,
): Promise<ImportResult> {
  const rows = parseCsv(text)
  const result: ImportResult = { created: 0, merged: 0, skipped: 0, problems: [] }
  if (rows.length < 2) {
    result.problems.push('That file has no rows under its header.')
    return result
  }

  const header = rows[0].map((h) => h.trim().toLowerCase())
  const find = (...aliases: string[]) => header.findIndex((h) => aliases.some((a) => h === a || h.includes(a)))
  const idx = {
    name: find('name', 'full name', 'customer', 'client'),
    email: find('email', 'e-mail'),
    phone: find('phone', 'mobile', 'telephone', 'cell'),
    note: find('note', 'notes', 'comment'),
    status: find('status', 'stage'),
    tags: find('tag', 'label', 'group'),
  }
  if (idx.name < 0 && idx.email < 0 && idx.phone < 0) {
    result.problems.push('No name, email or phone column found. Check the header row.')
    return result
  }

  const at = (row: string[], i: number) => (i >= 0 ? row[i]?.trim() : undefined)
  const body = rows.slice(1, cap + 1)
  if (rows.length - 1 > cap) {
    result.problems.push(`Only the first ${cap.toLocaleString()} rows were imported.`)
  }

  for (const [n, row] of body.entries()) {
    const name = at(row, idx.name)
    const email = normalizeEmail(at(row, idx.email))
    const phone = normalizePhone(at(row, idx.phone))
    if (!name && !email && !phone) { result.skipped++; continue }

    const rawStatus = at(row, idx.status)?.toLowerCase()
    const status = CONTACT_STATUSES.includes(rawStatus as ContactStatus)
      ? (rawStatus as ContactStatus)
      : undefined
    const tags = at(row, idx.tags)?.split(/[;,|]/).map((t) => t.trim()).filter(Boolean)

    try {
      const existing = (email || phone) ? await findContactByIdentity(tenantId, email, phone) : undefined
      if (existing) {
        await updateContact(tenantId, existing.contactId, {
          name: existing.name ?? name,
          email: existing.email ?? email,
          phone: existing.phone ?? phone,
          note: existing.note ?? at(row, idx.note),
        })
        result.merged++
      } else {
        await createContact(tenantId, {
          name, email, phone, status, tags, note: at(row, idx.note), source: 'import',
        })
        result.created++
      }
    } catch {
      result.skipped++
      if (result.problems.length < 3) result.problems.push(`Row ${n + 2} could not be saved.`)
    }
  }
  return result
}
