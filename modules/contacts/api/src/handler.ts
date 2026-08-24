import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import {
  CONTACT_STATUSES,
  allContacts,
  appendContactEvent,
  contactsToCsv,
  createContact,
  deleteContact,
  getContact,
  importContactsCsv,
  listContactEvents,
  listContacts,
  updateContact,
  type CallerContext,
  type ContactStatus,
} from '@makerbay/core'

type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<CallerContext>

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const ID = /^[0-9A-Z]{26}$/

/**
 * Contacts is core: it ships with every workspace and is never entitlement
 * gated. A module cannot depend on something a customer might switch off,
 * and modules that each keep their own customer list can never be joined up.
 */
export const handler = async (event: Event): Promise<APIGatewayProxyResultV2> => {
  const { tenantId } = event.requestContext.authorizer.lambda
  const method = event.requestContext.http.method
  const path = event.rawPath

  try {
    if (method === 'GET' && path === '/v1/contacts') return await index(tenantId, event)
    if (method === 'POST' && path === '/v1/contacts') return await create(tenantId, event)
    if (method === 'GET' && path === '/v1/contacts/export') return await exportCsv(tenantId)
    if (method === 'POST' && path === '/v1/contacts/import') return await importCsv(tenantId, event)

    const one = path.match(/^\/v1\/contacts\/([0-9A-Z]{26})$/)
    if (method === 'GET' && one) return await detail(tenantId, one[1])
    if (method === 'PATCH' && one) return await patch(tenantId, one[1], event)
    if (method === 'DELETE' && one) return await remove(tenantId, one[1])

    const note = path.match(/^\/v1\/contacts\/([0-9A-Z]{26})\/events$/)
    if (method === 'POST' && note) return await addNote(tenantId, note[1], event)

    return json(404, { error: 'not_found' })
  } catch (err) {
    console.error('contacts error', { path, method, err })
    return json(500, { error: 'internal_error' })
  }
}

const body = (event: Event): Record<string, unknown> => {
  try {
    const raw = event.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

const asStatus = (v: unknown): ContactStatus | undefined =>
  CONTACT_STATUSES.includes(v as ContactStatus) ? (v as ContactStatus) : undefined

const asTags = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map(String).map((t) => t.trim()).filter(Boolean).slice(0, 20) : undefined

async function index(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const q = event.queryStringParameters ?? {}
  const page = await listContacts(tenantId, {
    limit: q.limit ? Number(q.limit) : undefined,
    cursor: q.cursor,
    status: asStatus(q.status),
    search: q.search,
  })
  return json(200, { contacts: page.contacts, cursor: page.cursor ?? null, statuses: CONTACT_STATUSES })
}

async function detail(tenantId: string, contactId: string): Promise<APIGatewayProxyResultV2> {
  const contact = await getContact(tenantId, contactId)
  if (!contact) return json(404, { error: 'not_found' })
  const events = await listContactEvents(tenantId, contactId)
  return json(200, { contact, events })
}

async function create(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const name = String(b.name ?? '').trim()
  const email = String(b.email ?? '').trim()
  const phone = String(b.phone ?? '').trim()
  // A contact with no way to identify or reach them is a blank row.
  if (!name && !email && !phone) {
    return json(400, { error: 'identity_required', message: 'Give at least a name, an email or a phone number.' })
  }

  const contact = await createContact(tenantId, {
    name, email, phone,
    status: asStatus(b.status),
    note: b.note === undefined ? undefined : String(b.note),
    tags: asTags(b.tags),
    source: 'manual',
  })
  await appendContactEvent(tenantId, contact.contactId, {
    moduleId: 'contacts',
    title: 'Added to your contacts',
  })
  return json(201, { contact })
}

async function patch(tenantId: string, contactId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const before = await getContact(tenantId, contactId)
  if (!before) return json(404, { error: 'not_found' })

  const contact = await updateContact(tenantId, contactId, {
    name: b.name === undefined ? undefined : String(b.name),
    email: b.email === undefined ? undefined : String(b.email),
    phone: b.phone === undefined ? undefined : String(b.phone),
    status: asStatus(b.status),
    note: b.note === undefined ? undefined : String(b.note),
    tags: asTags(b.tags),
  })
  if (!contact) return json(404, { error: 'not_found' })

  // A status change is the part of an edit worth remembering.
  if (contact.status !== before.status) {
    await appendContactEvent(tenantId, contactId, {
      moduleId: 'contacts',
      title: `Status changed from ${before.status} to ${contact.status}`,
    })
  }
  return json(200, { contact })
}

async function remove(tenantId: string, contactId: string): Promise<APIGatewayProxyResultV2> {
  await deleteContact(tenantId, contactId)
  return json(200, { deleted: contactId })
}

async function addNote(tenantId: string, contactId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const title = String(b.title ?? '').trim()
  if (title.length < 2) return json(400, { error: 'title_required' })
  if (!(await getContact(tenantId, contactId))) return json(404, { error: 'not_found' })

  await appendContactEvent(tenantId, contactId, {
    moduleId: 'contacts',
    title: title.slice(0, 200),
    body: b.body === undefined ? undefined : String(b.body).slice(0, 4000),
  })
  return json(201, { events: await listContactEvents(tenantId, contactId) })
}

async function exportCsv(tenantId: string): Promise<APIGatewayProxyResultV2> {
  const contacts = await allContacts(tenantId)
  return {
    statusCode: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
    body: contactsToCsv(contacts),
  }
}

async function importCsv(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const raw = event.isBase64Encoded && event.body
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : (event.body ?? '')

  // The dashboard posts JSON; a script may post the file directly.
  let csv = raw
  if (raw.trimStart().startsWith('{')) {
    try { csv = String(JSON.parse(raw).csv ?? '') } catch { csv = '' }
  }
  if (!csv.trim()) return json(400, { error: 'empty_file', message: 'That file had nothing in it.' })

  const result = await importContactsCsv(tenantId, csv)
  return json(200, result)
}
