import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import {
  appendContactEvent,
  emitUsage,
  findApiKeyByHash,
  getEffectiveEntitlement,
  getTenant,
  getTenantBySlug,
  getUser,
  hashApiKey,
  linkToken,
  sendEmail,
  ulid,
  upsertContact,
  type CallerContext,
} from '@makerbay/core'
import {
  DEFAULT_BOOKING_CONFIG,
  blocking,
  bookingsBetween,
  countBookingsThisMonth,
  deleteService,
  findByCancelToken,
  getBooking,
  getBookingConfig,
  getService,
  listServices,
  putBooking,
  putBookingConfig,
  putService,
  type BookingRow,
  type BookingStatus,
  type ServiceRow,
} from './db'
import { displayTime, openDates, slotStillFree, slotsFor } from './slots'

type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<CallerContext>

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const CHAT = 'https://chat.makerbay.app'
const APP = 'https://app.makerbay.app'
const STATUSES: BookingStatus[] = ['confirmed', 'cancelled', 'completed', 'noshow']

export const handler = async (event: Event): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method
  const path = event.rawPath

  try {
    if (path.startsWith('/v1/public/booking')) return await publicRoute(method, path, event)

    const ctx = event.requestContext.authorizer.lambda
    const tenantId = await resolveTenantId(ctx)
    if (!tenantId) return json(401, { error: 'unauthorized' })

    const entitlement = await getEffectiveEntitlement(tenantId, 'booking')
    if (!entitlement.enabled) return json(403, { error: 'module_not_enabled' })

    if (method === 'GET' && path === '/v1/booking/config') {
      return json(200, { config: await getBookingConfig(tenantId) })
    }
    if (method === 'PUT' && path === '/v1/booking/config') return await updateConfig(tenantId, event)

    if (method === 'GET' && path === '/v1/booking/services') {
      return json(200, { services: await listServices(tenantId) })
    }
    if (method === 'POST' && path === '/v1/booking/services') return await createService(tenantId, event)

    const svc = path.match(/^\/v1\/booking\/services\/([0-9A-Z]{26})$/)
    if (method === 'PATCH' && svc) return await patchService(tenantId, svc[1], event)
    if (method === 'DELETE' && svc) return await removeService(tenantId, svc[1])

    if (method === 'GET' && path === '/v1/booking/bookings') return await diary(tenantId, event)

    const bk = path.match(/^\/v1\/booking\/bookings\/([0-9A-Z]{26})$/)
    if (method === 'PATCH' && bk) return await patchBooking(tenantId, bk[1], event)

    return json(404, { error: 'not_found' })
  } catch (err) {
    console.error('booking error', { path, method, err })
    return json(500, { error: 'internal_error' })
  }
}

async function resolveTenantId(ctx: CallerContext): Promise<string> {
  if (ctx.keyId) return ctx.tenantId
  if (!ctx.userId) return ''
  return (await getUser(ctx.userId))?.tenantId ?? ''
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

// ── Public surface ───────────────────────────────────────────────────────

async function resolvePublicTenant(key?: string, slug?: string) {
  if (key) {
    if (!key.startsWith('mb_pk_')) return undefined
    const found = await findApiKeyByHash(hashApiKey(key))
    // Revoking a key deletes its row, so a missing lookup IS the revocation
    // check. Secret keys are refused: a public page must never present one.
    if (!found || found.type !== 'publishable') return undefined
    const tenant = await getTenant(found.tenantId)
    return tenant ? { tenantId: tenant.tenantId, slug: tenant.slug, name: tenant.name } : undefined
  }
  if (slug) {
    const tenant = await getTenantBySlug(slug)
    return tenant ? { tenantId: tenant.tenantId, slug: tenant.slug, name: tenant.name } : undefined
  }
  return undefined
}

async function publicRoute(
  method: string,
  path: string,
  event: Event,
): Promise<APIGatewayProxyResultV2> {
  const b = method === 'POST' ? body(event) : {}
  const q = event.queryStringParameters ?? {}
  const key = String(q.key ?? b.key ?? '') || undefined
  const slug = String(q.slug ?? b.slug ?? '') || undefined

  const resolved = await resolvePublicTenant(key, slug)
  if (!resolved) return json(404, { error: 'not_found' })

  const entitlement = await getEffectiveEntitlement(resolved.tenantId, 'booking')
  if (!entitlement.enabled) return json(404, { error: 'not_found' })

  const config = await getBookingConfig(resolved.tenantId)

  if (method === 'GET' && path === '/v1/public/booking/services') {
    const services = (await listServices(resolved.tenantId)).filter((s) => s.active)
    return json(200, {
      business: resolved.name,
      intro: config.intro,
      timezone: config.timezone,
      services: services.map((s) => ({
        serviceId: s.serviceId, name: s.name, description: s.description,
        durationMinutes: s.durationMinutes, priceCents: s.priceCents,
      })),
      dates: openDates(config, new Date()),
    })
  }

  if (method === 'GET' && path === '/v1/public/booking/slots') {
    const serviceId = String(q.serviceId ?? '')
    const date = String(q.date ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { error: 'bad_date' })
    const service = await getService(resolved.tenantId, serviceId)
    if (!service || !service.active) return json(404, { error: 'unknown_service' })

    // A day plus a margin, so a booking that starts late the day before and
    // runs over midnight still blocks the morning.
    const from = new Date(`${date}T00:00:00Z`).getTime() - 86_400_000
    const busy = blocking(
      await bookingsBetween(
        resolved.tenantId,
        new Date(from).toISOString(),
        new Date(from + 3 * 86_400_000).toISOString(),
      ),
    )
    return json(200, {
      date,
      timezone: config.timezone,
      slots: slotsFor(config, service, busy, date, new Date()),
    })
  }

  if (method === 'POST' && path === '/v1/public/booking') {
    return await createBooking(resolved.tenantId, resolved.name, entitlement.limits, b)
  }

  // View or cancel from the confirmation email, no account needed.
  const token = path.match(/^\/v1\/public\/booking\/([A-Za-z0-9_-]{20,})$/)
  if (token) {
    const found = await findByCancelToken(resolved.tenantId, token[1])
    if (!found) return json(404, { error: 'not_found' })
    if (method === 'GET') {
      return json(200, {
        booking: publicView(found, config.timezone),
        business: resolved.name,
        timezone: config.timezone,
      })
    }
    if (method === 'POST') return await cancelByToken(resolved.tenantId, resolved.name, found)
  }

  return json(404, { error: 'not_found' })
}

const publicView = (b: BookingRow, timezone: string) => ({
  serviceName: b.serviceName,
  startsAt: b.startsAt,
  endsAt: b.endsAt,
  status: b.status,
  time: displayTime(b.startsAt, timezone),
  date: new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date(b.startsAt)),
  name: b.name,
})

async function createBooking(
  tenantId: string,
  businessName: string,
  limits: Record<string, number>,
  b: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const serviceId = String(b.serviceId ?? '')
  const startsAt = String(b.startsAt ?? '')
  const name = String(b.name ?? '').trim()
  const email = String(b.email ?? '').trim()
  const phone = String(b.phone ?? '').trim()

  if (!email && !phone) {
    return json(400, {
      error: 'contact_required',
      message: 'Leave an email address or a phone number so we can confirm.',
    })
  }
  const service = await getService(tenantId, serviceId)
  if (!service || !service.active) return json(404, { error: 'unknown_service' })

  const start = new Date(startsAt)
  if (Number.isNaN(start.getTime())) return json(400, { error: 'bad_time' })
  const endsAt = new Date(start.getTime() + service.durationMinutes * 60_000).toISOString()

  const cap = limits.bookingsPerMonth ?? 50
  if ((await countBookingsThisMonth(tenantId)) >= cap) {
    return json(429, {
      error: 'limit_exceeded',
      message: 'This business has reached its bookings for the month. Please contact them directly.',
    })
  }

  // Re-checked at write time: two customers can load the same slot list a
  // second apart, and the loser must be told rather than silently overwriting.
  const busy = blocking(
    await bookingsBetween(
      tenantId,
      new Date(start.getTime() - 2 * 86_400_000).toISOString(),
      new Date(start.getTime() + 2 * 86_400_000).toISOString(),
    ),
  )
  if (!slotStillFree(service, busy, start.toISOString(), endsAt)) {
    return json(409, {
      error: 'slot_taken',
      message: 'That time has just been taken. Pick another and we will hold it for you.',
    })
  }

  const config = await getBookingConfig(tenantId)
  const contact = await upsertContact(tenantId, { name, email, phone, source: 'booking' })
  const now = new Date().toISOString()
  const bookingId = ulid()
  const cancelToken = linkToken()

  const row: BookingRow = {
    tenantId,
    bookingId,
    contactId: contact.contactId,
    serviceId,
    serviceName: service.name,
    startsAt: start.toISOString(),
    endsAt,
    status: 'confirmed',
    name: name || undefined,
    email: contact.email,
    phone: contact.phone,
    note: b.note ? String(b.note).slice(0, 1000) : undefined,
    cancelToken,
    source: 'hosted',
    createdAt: now,
    updatedAt: now,
  }

  const view = publicView(row, config.timezone)
  const customerMail = await sendEmail({
    to: contact.email ?? '',
    subject: `Your ${service.name} booking with ${businessName}`,
    text: [
      `${name || 'Hello'},`,
      '',
      `Your ${service.name} is booked for ${view.date} at ${view.time}.`,
      '',
      `Need to cancel? ${CHAT}/booking/cancel?slug=${encodeURIComponent(await slugOf(tenantId))}&token=${cancelToken}`,
      '',
      businessName,
    ].join('\n'),
  })
  if (!customerMail.sent) row.notifyError = customerMail.error

  await putBooking(row)
  await appendContactEvent(tenantId, contact.contactId, {
    moduleId: 'booking',
    title: `Booked ${service.name} for ${view.date} at ${view.time}`,
    href: `/booking/diary`,
  })

  await sendEmail({
    to: config.notifyEmail || '',
    replyTo: contact.email,
    subject: `New booking: ${service.name}, ${view.date} ${view.time}`,
    text: [
      `${name || contact.email || contact.phone} booked ${service.name}.`,
      `${view.date} at ${view.time}`,
      row.note ? `\nNote: ${row.note}` : '',
      '',
      `Diary: ${APP}/booking/diary`,
    ].join('\n'),
  })

  await emitUsage({ tenantId, moduleId: 'booking', metric: 'booking.created', quantity: 1 })
  return json(201, { bookingId, booking: view, emailed: customerMail.sent })
}

async function slugOf(tenantId: string): Promise<string> {
  return (await getTenant(tenantId))?.slug ?? ''
}

async function cancelByToken(
  tenantId: string,
  businessName: string,
  booking: BookingRow,
): Promise<APIGatewayProxyResultV2> {
  if (booking.status === 'cancelled') return json(200, { cancelled: true, already: true })

  const now = new Date().toISOString()
  const config = await getBookingConfig(tenantId)
  await putBooking({ ...booking, status: 'cancelled', cancelledAt: now, updatedAt: now })
  await appendContactEvent(tenantId, booking.contactId, {
    moduleId: 'booking',
    title: `Cancelled their ${booking.serviceName} booking`,
  })
  await sendEmail({
    to: config.notifyEmail || '',
    subject: `Cancelled: ${booking.serviceName}, ${displayTime(booking.startsAt, config.timezone)}`,
    text: `${booking.name || booking.email} cancelled their ${booking.serviceName} booking.\n\n${businessName}`,
  })
  return json(200, { cancelled: true })
}

// ── Authenticated surface ────────────────────────────────────────────────

async function createService(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const name = String(b.name ?? '').trim()
  if (name.length < 2) return json(400, { error: 'name_required' })

  const row: ServiceRow = {
    tenantId,
    serviceId: ulid(),
    name: name.slice(0, 80),
    description: b.description ? String(b.description).slice(0, 500) : undefined,
    durationMinutes: clamp(Number(b.durationMinutes ?? 60), 5, 480),
    bufferMinutes: clamp(Number(b.bufferMinutes ?? 0), 0, 240),
    priceCents: b.priceCents === undefined ? undefined : Math.max(0, Math.round(Number(b.priceCents))),
    active: b.active !== false,
    createdAt: new Date().toISOString(),
  }
  await putService(row)
  return json(201, { service: row })
}

const clamp = (n: number, lo: number, hi: number) =>
  Number.isFinite(n) ? Math.min(Math.max(Math.round(n), lo), hi) : lo

async function patchService(tenantId: string, serviceId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const existing = await getService(tenantId, serviceId)
  if (!existing) return json(404, { error: 'not_found' })

  const row: ServiceRow = {
    ...existing,
    ...(b.name !== undefined ? { name: String(b.name).slice(0, 80) } : {}),
    ...(b.description !== undefined ? { description: String(b.description).slice(0, 500) } : {}),
    ...(b.durationMinutes !== undefined ? { durationMinutes: clamp(Number(b.durationMinutes), 5, 480) } : {}),
    ...(b.bufferMinutes !== undefined ? { bufferMinutes: clamp(Number(b.bufferMinutes), 0, 240) } : {}),
    ...(b.priceCents !== undefined ? { priceCents: Math.max(0, Math.round(Number(b.priceCents))) } : {}),
    ...(b.active !== undefined ? { active: b.active === true } : {}),
  }
  await putService(row)
  return json(200, { service: row })
}

async function removeService(tenantId: string, serviceId: string): Promise<APIGatewayProxyResultV2> {
  // Existing bookings keep their serviceName, so removing a service never
  // orphans an appointment already in the diary.
  await deleteService(tenantId, serviceId)
  return json(200, { deleted: serviceId })
}

async function diary(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const q = event.queryStringParameters ?? {}
  const from = q.from ? `${q.from}T00:00:00.000Z` : new Date(Date.now() - 7 * 86_400_000).toISOString()
  const to = q.to ? `${q.to}T23:59:59.999Z` : new Date(Date.now() + 60 * 86_400_000).toISOString()
  const config = await getBookingConfig(tenantId)
  const rows = (await bookingsBetween(tenantId, from, to)).sort((a, b) =>
    a.startsAt.localeCompare(b.startsAt),
  )
  return json(200, { bookings: rows, timezone: config.timezone })
}

async function patchBooking(tenantId: string, bookingId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const existing = await getBooking(tenantId, bookingId)
  if (!existing) return json(404, { error: 'not_found' })
  const status = STATUSES.includes(b.status as BookingStatus) ? (b.status as BookingStatus) : undefined
  if (!status) return json(400, { error: 'unknown_status' })

  const now = new Date().toISOString()
  const row: BookingRow = {
    ...existing,
    status,
    updatedAt: now,
    cancelledAt: status === 'cancelled' ? now : existing.cancelledAt,
  }
  await putBooking(row)

  if (status === 'cancelled' && existing.status !== 'cancelled') {
    const config = await getBookingConfig(tenantId)
    const tenant = await getTenant(tenantId)
    await sendEmail({
      to: existing.email ?? '',
      subject: `Your ${existing.serviceName} booking has been cancelled`,
      text: `Your ${existing.serviceName} on ${displayTime(existing.startsAt, config.timezone)} has been cancelled.\n\n${tenant?.name ?? ''}`,
    })
    await appendContactEvent(tenantId, existing.contactId, {
      moduleId: 'booking',
      title: `Booking cancelled by the business`,
    })
  }
  return json(200, { booking: row })
}

async function updateConfig(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const existing = await getBookingConfig(tenantId)
  const timezone = String(b.timezone ?? existing.timezone)
  // A bad timezone would silently shift every appointment, so prove it first.
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone }).format(new Date())
  } catch {
    return json(400, { error: 'unknown_timezone', message: `"${timezone}" is not a timezone we recognise.` })
  }

  const config = {
    ...existing,
    tenantId,
    timezone,
    hours: (b.hours as BookingConfigHours) ?? existing.hours,
    leadTimeHours: clamp(Number(b.leadTimeHours ?? existing.leadTimeHours), 0, 720),
    horizonDays: clamp(Number(b.horizonDays ?? existing.horizonDays), 1, 365),
    closures: Array.isArray(b.closures)
      ? (b.closures as Array<Record<string, unknown>>)
          .filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(String(c.date)))
          .slice(0, 200)
          .map((c) => ({ date: String(c.date), reason: c.reason ? String(c.reason).slice(0, 80) : undefined }))
      : existing.closures,
    notifyEmail: String(b.notifyEmail ?? existing.notifyEmail).slice(0, 200),
    intro: String(b.intro ?? DEFAULT_BOOKING_CONFIG.intro).slice(0, 300),
  }
  await putBookingConfig(config)
  return json(200, { config })
}

type BookingConfigHours = Awaited<ReturnType<typeof getBookingConfig>>['hours']
