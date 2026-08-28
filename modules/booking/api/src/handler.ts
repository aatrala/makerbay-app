import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import {
  bookingCancelled,
  bookingCancelledByCustomer,
  bookingConfirmed,
  depositOnLapsedBooking,
  newBooking as newBookingMail,
} from '@makerbay/email'
import {
  appendContactEvent,
  type AuditActor,
  type AuditEntry,
  emitEvent,
  emitUsage,
  findApiKeyByHash,
  getEffectiveEntitlement,
  getTenant,
  getTenantBrand,
  getTenantBySlugOrAlias,
  getUser,
  hashApiKey,
  json,
  linkToken,
  listConfigVersions,
  money,
  readConfigVersion,
  recordAudit,
  requireScope,
  sendEmail,
  snapshotConfig,
  ulid,
  upsertContact,
  type CallerContext,
} from '@makerbay/core'
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { ddb as ddbRaw } from '@makerbay/core'
import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  SchedulerClient,
} from '@aws-sdk/client-scheduler'
import { remindAt } from './reminder-time'
import {
  DEFAULT_BOOKING_CONFIG,
  blocking,
  bookingsBetween,
  confirmDepositPaid,
  countBookingsThisMonth,
  deleteBooking,
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
import { displayTime, openDates, slotStillFree, slotsFor, zoned } from './slots'

type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<CallerContext>

const CHAT = 'https://chat.makerbay.app'
// pending_payment deliberately absent: the owner PATCH can never set it.
const STATUSES: BookingStatus[] = ['confirmed', 'cancelled', 'completed', 'noshow']

interface PaymentReceivedEvent {
  'detail-type': string
  detail: {
    tenantId: string
    paymentId: string
    kind: string
    refId: string
    amountCents: number
    currency: string
  }
}

export const handler = async (
  event: Event | PaymentReceivedEvent,
): Promise<APIGatewayProxyResultV2 | void> => {
  // A deposit landed (verified webhook → payments module → bus). The money
  // is fact; this branch makes the diary agree with it.
  if ('detail-type' in event) {
    if (event['detail-type'] === 'payment.received' && event.detail.kind === 'booking_deposit')
      await onDepositPaid(event.detail)
    return
  }

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
      // payoutsEnabled rides along so the Services screen knows whether the
      // deposit field is armed, without a cross-module fetch.
      const [config, tenant] = await Promise.all([getBookingConfig(tenantId), getTenant(tenantId)])
      return json(200, { config, payoutsEnabled: tenant?.payoutsEnabled === true })
    }
    // Undo, free on every tier. A snapshot is taken before every write above,
    // so anything the owner or a setup job changed can be put back (issue 100).
    if (method === 'GET' && path === '/v1/booking/versions') {
      const surface = event.queryStringParameters?.surface === 'services' ? 'booking.services' : 'booking.config'
      return json(200, { versions: (await listConfigVersions(tenantId, surface)).map((v) => ({ sk: v.sk, at: v.at, label: v.label })) })
    }
    if (method === 'POST' && path === '/v1/booking/versions/restore') {
      const { actor, origin } = auditActorOf(event)
      return await restoreBooking(tenantId, body(event), actor, origin)
    }
    if (method === 'PUT' && path === '/v1/booking/config') {
      const denied = requireScope(ctx, 'booking:config:write')
      if (denied) return denied
      return await updateConfig(tenantId, event)
    }

    if (method === 'GET' && path === '/v1/booking/services') {
      return json(200, { services: await listServices(tenantId) })
    }
    if (method === 'POST' && path === '/v1/booking/services') {
      const denied = requireScope(ctx, 'booking:services:write')
      if (denied) return denied
      return await createService(tenantId, event)
    }

    const svc = path.match(/^\/v1\/booking\/services\/([0-9A-Z]{26})$/)
    if (method === 'PATCH' && svc) {
      const denied = requireScope(ctx, 'booking:services:write')
      if (denied) return denied
      return await patchService(tenantId, svc[1], event)
    }
    if (method === 'DELETE' && svc) {
      const denied = requireScope(ctx, 'booking:services:write')
      if (denied) return denied
      const { actor, origin } = auditActorOf(event)
      return await removeService(tenantId, svc[1], actor, origin)
    }

    if (method === 'GET' && path === '/v1/booking/bookings') return await diary(tenantId, event)

    const bk = path.match(/^\/v1\/booking\/bookings\/([0-9A-Z]{26})$/)
    if (method === 'PATCH' && bk) return await patchBooking(tenantId, bk[1], event)

    if (method === 'POST' && path === '/v1/booking/blocks') return await createBlock(tenantId, event)
    const blk = path.match(/^\/v1\/booking\/blocks\/([0-9A-Z]{26})$/)
    if (method === 'DELETE' && blk) return await removeBlock(tenantId, blk[1])

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
    const tenant = await getTenantBySlugOrAlias(slug)
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
    // Never advertise a deposit that cannot be charged.
    const tenant = await getTenant(resolved.tenantId)
    const canCharge = tenant?.payoutsEnabled === true
    return json(200, {
      business: resolved.name,
      intro: config.intro,
      timezone: config.timezone,
      services: services.map((s) => ({
        serviceId: s.serviceId, name: s.name, description: s.description,
        durationMinutes: s.durationMinutes, priceCents: s.priceCents,
        depositCents: canCharge && s.depositCents && s.depositCents >= 100 ? s.depositCents : undefined,
      })),
      dates: openDates(config, new Date()),
    })
  }

  if (method === 'GET' && path === '/v1/public/booking/slots') {
    const serviceId = String(q.serviceId ?? '')
    const date = String(q.date ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { error: 'bad_date' })
    // An empty key would make DynamoDB throw a 500; an unknown service is 404.
    if (!serviceId) return json(404, { error: 'unknown_service' })
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
  depositCents: b.depositCents,
  depositPaidAt: b.depositPaidAt,
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
  const service = serviceId ? await getService(tenantId, serviceId) : undefined
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

  // Deposits (spec-booking-deposits.md): when the service asks for one and
  // payments actually work, the row is written as a held slot and the
  // customer pays before anyone hears "you're booked". Money being switched
  // off degrades to a normal instant booking - a deposit is an enhancement,
  // never a gate.
  const tenant = await getTenant(tenantId)
  const depositCents =
    service.depositCents && service.depositCents >= 100 && tenant?.payoutsEnabled === true
      ? service.depositCents
      : 0
  if (depositCents > 0) {
    row.status = 'pending_payment'
    row.depositCents = depositCents
    // 35-minute hold vs the 30-minute checkout session expiry: a completed
    // payment can never land on a freed slot. Do not shrink the gap.
    row.holdExpiresAt = new Date(Date.now() + 35 * 60_000).toISOString()
    await putBooking(row)
    return json(201, {
      bookingId,
      depositRequired: true,
      depositCents,
      token: cancelToken,
      booking: publicView(row, config.timezone),
    })
  }

  const emailed = await confirmSideEffects(tenantId, businessName, row, config.timezone, config.notifyEmail)
  return json(201, { bookingId, booking: view, emailed })
}

/**
 * Everything that happens when a booking becomes real: customer email,
 * contact trail, owner notify, usage, rescue attribution, reminder. The
 * instant path runs it inline; the deposit path runs it only when the
 * money lands - a customer must never read "you're booked" while unpaid.
 */
async function confirmSideEffects(
  tenantId: string,
  businessName: string,
  row: BookingRow,
  timezone: string,
  notifyEmail: string,
): Promise<boolean> {
  const view = publicView(row, timezone)
  const brand = await getTenantBrand(tenantId)
  const cancelUrl = `${CHAT}/booking/cancel?slug=${encodeURIComponent(await slugOf(tenantId))}&token=${row.cancelToken}`
  const confirmMail = bookingConfirmed({
    brand,
    contact: { email: notifyEmail || undefined },
    customerName: row.name,
    service: row.serviceName,
    when: `${view.date} at ${view.time}`,
    deposit: row.depositPaidAt && row.depositCents
      ? money(row.depositCents, 'AUD')
      : undefined,
    cancelUrl,
  })
  const customerMail = await sendEmail({
    to: row.email ?? '',
    ref: { tenantId, moduleId: 'booking', refType: 'booking', refId: row.bookingId },
    audience: 'customer' as const,
    fromName: brand.name,
    replyTo: notifyEmail,
    subject: confirmMail.subject,
    text: confirmMail.text,
    html: confirmMail.html,
  })
  if (!customerMail.sent) {
    row.notifyError = customerMail.error
    await putBooking(row)
  }

  await appendContactEvent(tenantId, row.contactId, {
    moduleId: 'booking',
    title: `Booked ${row.serviceName} for ${view.date} at ${view.time}`,
    href: `/booking/diary`,
  })

  const ownerMail = newBookingMail({
    businessName,
    who: row.name || row.email || row.phone || 'Someone',
    service: row.serviceName,
    when: `${view.date} at ${view.time}`,
    deposit: row.depositPaidAt && row.depositCents ? money(row.depositCents, 'AUD') : undefined,
    note: row.note,
  })
  await sendEmail({
    to: notifyEmail || '',
    ref: { tenantId, moduleId: 'booking', refType: 'booking', refId: row.bookingId },
    audience: 'owner' as const,
    replyTo: row.email,
    subject: ownerMail.subject,
    text: ownerMail.text,
    html: ownerMail.html,
  })

  await emitUsage({ tenantId, moduleId: 'booking', metric: 'booking.created', quantity: 1 })
  await attributeRescue(tenantId, row.contactId)
  await scheduleReminder(tenantId, row.bookingId, row.startsAt)
  return customerMail.sent
}

/** The deposit landed: flip the held slot and fire the confirm effects. */
async function onDepositPaid(detail: PaymentReceivedEvent['detail']): Promise<void> {
  const { tenantId, refId: bookingId, paymentId } = detail
  const row = await getBooking(tenantId, bookingId)
  if (!row) {
    console.error('deposit paid for unknown booking', { tenantId, bookingId, paymentId })
    return
  }
  try {
    await confirmDepositPaid(tenantId, bookingId, paymentId)
  } catch (err) {
    // Paid but not pending: lapsed hold or duplicate delivery. Loud log; the
    // owner refunds a lapsed one from the Payments screen.
    console.error('deposit paid but booking not pending', { tenantId, bookingId, paymentId, status: row.status, err: String(err) })
    const config = await getBookingConfig(tenantId)
    const lapsed = depositOnLapsedBooking({
      businessName: (await getTenant(tenantId))?.name ?? 'your business',
      service: row.serviceName,
      amount: money(detail.amountCents, detail.currency ?? 'AUD'),
    })
    await sendEmail({
      to: config.notifyEmail || '',
      audience: 'owner' as const,
      ref: { tenantId, moduleId: 'booking', refType: 'booking', refId: bookingId },
      subject: lapsed.subject,
      text: lapsed.text,
      html: lapsed.html,
    })
    return
  }
  const updated = { ...row, status: 'confirmed' as BookingStatus, depositPaidAt: new Date().toISOString(), paymentId }
  const [config, tenant] = await Promise.all([getBookingConfig(tenantId), getTenant(tenantId)])
  await confirmSideEffects(tenantId, tenant?.name ?? '', updated, config.timezone, config.notifyEmail)
}

async function slugOf(tenantId: string): Promise<string> {
  return (await getTenant(tenantId))?.slug ?? ''
}

const scheduler = new SchedulerClient({})

/**
 * A one-off EventBridge schedule per booking, named after it, that invokes the
 * reminder Lambda shortly before the appointment. ActionAfterCompletion DELETE
 * means fired schedules clean themselves up; cancelling a booking deletes the
 * schedule best-effort, and the reminder Lambda re-checks the row's status
 * anyway - the schedule is a wake-up call, not the source of truth.
 */
async function scheduleReminder(tenantId: string, bookingId: string, startsAt: string): Promise<void> {
  try {
    const at = remindAt(startsAt, new Date())
    if (!at || !process.env.REMINDER_FN_ARN || !process.env.SCHEDULER_ROLE_ARN) return
    await scheduler.send(
      new CreateScheduleCommand({
        Name: `rem-${bookingId}`,
        GroupName: 'default',
        // Scheduler wants seconds-precision without a zone suffix.
        ScheduleExpression: `at(${at.toISOString().slice(0, 19)})`,
        ScheduleExpressionTimezone: 'UTC',
        FlexibleTimeWindow: { Mode: 'OFF' },
        ActionAfterCompletion: 'DELETE',
        Target: {
          Arn: process.env.REMINDER_FN_ARN,
          RoleArn: process.env.SCHEDULER_ROLE_ARN,
          Input: JSON.stringify({ tenantId, bookingId }),
          RetryPolicy: { MaximumRetryAttempts: 2 },
        },
      }),
    )
  } catch (err) {
    // A missing reminder must never fail the booking itself.
    console.warn('reminder schedule failed', { bookingId, err })
  }
}

async function cancelReminder(bookingId: string): Promise<void> {
  try {
    await scheduler.send(new DeleteScheduleCommand({ Name: `rem-${bookingId}`, GroupName: 'default' }))
  } catch {
    // Already fired and self-deleted, or never created - both fine.
  }
}

/**
 * If this customer had an open missed-call request from the last week, the
 * booking is what the rescue was for: close the request and count the
 * conversion. Nobody in this category publishes rescue-to-booking rates -
 * we can, because the diary and the rescue live in one system.
 */
async function attributeRescue(tenantId: string, contactId: string): Promise<void> {
  try {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const r = await ddbRaw.send(
      new QueryCommand({
        TableName: process.env.TABLE_REQUESTS!,
        KeyConditionExpression: 'tenantId = :t',
        FilterExpression: 'contactId = :c AND kind = :k AND #st <> :closed AND createdAt > :cutoff',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':t': tenantId, ':c': contactId, ':k': 'missedcall', ':closed': 'closed', ':cutoff': weekAgo,
        },
        ScanIndexForward: false,
        Limit: 50,
      }),
    )
    const open = (r.Items ?? [])[0]
    if (!open) return
    await ddbRaw.send(
      new UpdateCommand({
        TableName: process.env.TABLE_REQUESTS!,
        Key: { tenantId, requestId: open.requestId },
        UpdateExpression: 'SET #st = :s, closedAt = :now, updatedAt = :now, bookedFromRescue = :yes',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':s': 'closed', ':now': new Date().toISOString(), ':yes': true },
      }),
    )
    await emitUsage({ tenantId, moduleId: 'voice', metric: 'rescue.booked', quantity: 1 })
  } catch (err) {
    // Attribution is telemetry; it must never fail a customer's booking.
    console.warn('rescue attribution failed', err)
  }
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
  await cancelReminder(booking.bookingId)
  await appendContactEvent(tenantId, booking.contactId, {
    moduleId: 'booking',
    title: `Cancelled their ${booking.serviceName} booking`,
  })
  const cancelMail = bookingCancelledByCustomer({
    businessName,
    who: booking.name || booking.email || 'Someone',
    service: booking.serviceName,
    when: displayTime(booking.startsAt, config.timezone),
  })
  await sendEmail({
    to: config.notifyEmail || '',
    audience: 'owner' as const,
    ref: { tenantId, moduleId: 'booking', refType: 'booking', refId: booking.bookingId },
    subject: cancelMail.subject,
    text: cancelMail.text,
    html: cancelMail.html,
  })
  return json(200, { cancelled: true })
}

// ── Authenticated surface ────────────────────────────────────────────────

/**
 * Who is making this change, for the audit trail. A setup job carries its own
 * id and the owner who authorised it, so months later the Activity feed can
 * say MakerBay changed this on your say-so rather than naming the owner for
 * something they did not personally do (docs/spec-concierge.md).
 */
const auditActorOf = (event: Event): { actor: AuditActor; origin: AuditEntry['origin'] } => {
  const ctx = event.requestContext.authorizer.lambda
  if (ctx.taskId) {
    return {
      actor: { type: 'setup', id: ctx.taskId, label: 'MakerBay setup', onBehalfOf: ctx.onBehalfOf ?? ctx.userId },
      origin: 'setup',
    }
  }
  if (ctx.userId) return { actor: { type: 'user', id: ctx.userId, label: ctx.email }, origin: 'ui' }
  return { actor: { type: 'apikey', id: ctx.keyId ?? 'unknown' }, origin: 'api' }
}

/** Put a surface back to a snapshot. The restore itself is audited and snapshotted. */
async function restoreBooking(
  tenantId: string,
  b: Record<string, unknown>,
  actor: AuditActor,
  origin: AuditEntry['origin'],
): Promise<APIGatewayProxyResultV2> {
  const surface = b.surface === 'services' ? 'booking.services' : 'booking.config'
  const sk = String(b.sk ?? '')
  const snap = await readConfigVersion(tenantId, surface, sk)
  if (snap === undefined) return json(404, { error: 'version_not_found' })

  if (surface === 'booking.config') {
    await snapshotConfig(tenantId, surface, await getBookingConfig(tenantId), 'before restoring', actor.id)
    await putBookingConfig(snap as Awaited<ReturnType<typeof getBookingConfig>>)
  } else {
    const rows = snap as ServiceRow[]
    if (!Array.isArray(rows)) return json(409, { error: 'version_unreadable' })
    const current = await listServices(tenantId)
    await snapshotConfig(tenantId, surface, current, 'before restoring', actor.id)
    // Restore is a replace: anything added since the snapshot goes, anything
    // removed comes back. Half a restore is worse than none.
    for (const row of current) if (!rows.some((r) => r.serviceId === row.serviceId)) await deleteService(tenantId, row.serviceId)
    for (const row of rows) await putService(row)
  }
  await recordAudit({
    tenantId,
    actor,
    origin,
    action: 'booking.restored',
    moduleId: 'booking',
    targetId: tenantId,
    summary: `Put ${surface === 'booking.config' ? 'booking settings' : 'the service list'} back to how it was on ${sk.split('#')[0].slice(0, 10)}`,
  })
  return json(200, { restored: surface })
}

async function createService(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const { actor, origin } = auditActorOf(event)
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
    depositCents: depositClamp(b.depositCents),
    active: b.active !== false,
    createdAt: new Date().toISOString(),
  }
  await snapshotConfig(tenantId, 'booking.services', await listServices(tenantId), `before adding ${row.name}`, actor.id)
  await putService(row)
  await recordAudit({
    tenantId,
    actor,
    origin,
    action: 'booking.service_created',
    moduleId: 'booking',
    targetId: row.serviceId,
    summary: `Added the service "${row.name}"${row.priceCents !== undefined ? ` at ${(row.priceCents / 100).toFixed(2)}` : ''}, ${row.durationMinutes} minutes`,
  })
  return json(201, { service: row })
}

/** 0 switches deposits off; anything else sits in Stripe's chargeable range. */
const depositClamp = (v: unknown): number | undefined => {
  if (v === undefined) return undefined
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.min(Math.max(n, 100), 500_000)
}

const clamp = (n: number, lo: number, hi: number) =>
  Number.isFinite(n) ? Math.min(Math.max(Math.round(n), lo), hi) : lo

async function patchService(tenantId: string, serviceId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const { actor, origin } = auditActorOf(event)
  const existing = await getService(tenantId, serviceId)
  if (!existing) return json(404, { error: 'not_found' })

  const row: ServiceRow = {
    ...existing,
    ...(b.name !== undefined ? { name: String(b.name).slice(0, 80) } : {}),
    ...(b.description !== undefined ? { description: String(b.description).slice(0, 500) } : {}),
    ...(b.durationMinutes !== undefined ? { durationMinutes: clamp(Number(b.durationMinutes), 5, 480) } : {}),
    ...(b.bufferMinutes !== undefined ? { bufferMinutes: clamp(Number(b.bufferMinutes), 0, 240) } : {}),
    ...(b.priceCents !== undefined ? { priceCents: Math.max(0, Math.round(Number(b.priceCents))) } : {}),
    ...(b.depositCents !== undefined ? { depositCents: depositClamp(b.depositCents) } : {}),
    ...(b.active !== undefined ? { active: b.active === true } : {}),
  }
  await snapshotConfig(tenantId, 'booking.services', await listServices(tenantId), `before editing ${existing.name}`, actor.id)
  await putService(row)
  const priceMoved = b.priceCents !== undefined && existing.priceCents !== row.priceCents
  await recordAudit({
    tenantId,
    actor,
    origin,
    action: 'booking.service_updated',
    moduleId: 'booking',
    targetId: row.serviceId,
    summary: priceMoved
      ? `Changed the price of "${row.name}" from ${((existing.priceCents ?? 0) / 100).toFixed(2)} to ${((row.priceCents ?? 0) / 100).toFixed(2)}`
      : `Edited the service "${row.name}"`,
  })
  return json(200, { service: row })
}

async function removeService(tenantId: string, serviceId: string, actor: AuditActor, origin: AuditEntry['origin']): Promise<APIGatewayProxyResultV2> {
  // Existing bookings keep their serviceName, so removing a service never
  // orphans an appointment already in the diary.
  const existing = await getService(tenantId, serviceId)
  await snapshotConfig(tenantId, 'booking.services', await listServices(tenantId), `before removing ${existing?.name ?? serviceId}`, actor.id)
  await deleteService(tenantId, serviceId)
  await recordAudit({
    tenantId,
    actor,
    origin,
    action: 'booking.service_deleted',
    moduleId: 'booking',
    targetId: serviceId,
    summary: `Removed the service "${existing?.name ?? serviceId}"`,
  })
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
  if (existing.kind === 'block') {
    return json(409, { error: 'is_block', message: 'A blocked-out time has no status - remove it instead.' })
  }
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

  // The moment a customer is most likely to leave a review is right after the
  // job is done. The event fans out to whichever review surface the tenant
  // runs - the Reviews module, or the Get found Google-link ask.
  if (status === 'completed' && existing.status !== 'completed') {
    try {
      await emitEvent('booking', 'booking.completed', {
        tenantId,
        bookingId,
        contactId: existing.contactId,
        email: existing.email,
        name: existing.name,
        serviceName: existing.serviceName,
      })
    } catch (err) {
      console.warn('booking.completed emit failed', err)
    }
  }

  if (status === 'cancelled' && existing.status !== 'cancelled') {
    await cancelReminder(bookingId)
    const config = await getBookingConfig(tenantId)
    const cancelBrand = await getTenantBrand(tenantId)
    const cancelledMail = bookingCancelled({
      brand: cancelBrand,
      contact: { email: config.notifyEmail || undefined },
      customerName: existing.name,
      service: existing.serviceName,
      when: displayTime(existing.startsAt, config.timezone),
    })
    await sendEmail({
      to: existing.email ?? '',
      audience: 'customer' as const,
      ref: { tenantId, moduleId: 'booking', refType: 'booking', refId: bookingId },
      fromName: cancelBrand.name,
      replyTo: config.notifyEmail,
      subject: cancelledMail.subject,
      text: cancelledMail.text,
      html: cancelledMail.html,
    })
    await appendContactEvent(tenantId, existing.contactId, {
      moduleId: 'booking',
      title: `Booking cancelled by the business`,
    })
  }
  return json(200, { booking: row })
}

/**
 * Owner-reserved time. The block is a booking row, so slot offers and the
 * write-time conflict check refuse the window with no extra code paths.
 * Times arrive as wall-clock in the business timezone, like opening hours.
 */
async function createBlock(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const date = String(b.date ?? '')
  const from = String(b.from ?? '')
  const to = String(b.to ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(to)) {
    return json(400, { error: 'bad_time', message: 'Give a date and a from/to time, like 13:00 to 15:00.' })
  }

  const config = await getBookingConfig(tenantId)
  const startsAt = zoned(date, from, config.timezone)
  const endsAt = zoned(date, to, config.timezone)
  if (endsAt.getTime() <= startsAt.getTime()) {
    return json(400, { error: 'bad_time', message: 'The end time has to be after the start.' })
  }

  const now = new Date().toISOString()
  const row: BookingRow = {
    tenantId,
    bookingId: ulid(),
    kind: 'block',
    contactId: '',
    serviceId: '',
    serviceName: b.reason ? String(b.reason).slice(0, 80) : 'Blocked out',
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    status: 'confirmed',
    cancelToken: linkToken(),
    source: 'dashboard',
    createdAt: now,
    updatedAt: now,
  }
  await putBooking(row)
  return json(201, { block: row })
}

async function removeBlock(tenantId: string, bookingId: string): Promise<APIGatewayProxyResultV2> {
  const existing = await getBooking(tenantId, bookingId)
  if (!existing || existing.kind !== 'block') return json(404, { error: 'not_found' })
  await deleteBooking(tenantId, bookingId)
  return json(200, { deleted: bookingId })
}

async function updateConfig(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const { actor, origin } = auditActorOf(event)
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
  await snapshotConfig(tenantId, 'booking.config', existing, 'before saving hours and availability', actor.id)
  await putBookingConfig(config)
  const hoursChanged = JSON.stringify(existing.hours) !== JSON.stringify(config.hours)
  const tzChanged = existing.timezone !== config.timezone
  await recordAudit({
    tenantId,
    actor,
    origin,
    action: 'booking.config_updated',
    moduleId: 'booking',
    targetId: tenantId,
    summary: tzChanged
      ? `Changed the booking timezone from ${existing.timezone} to ${config.timezone}`
      : hoursChanged
        ? 'Changed the working hours customers can book inside'
        : 'Saved booking settings',
  })
  return json(200, { config })
}

type BookingConfigHours = Awaited<ReturnType<typeof getBookingConfig>>['hours']
