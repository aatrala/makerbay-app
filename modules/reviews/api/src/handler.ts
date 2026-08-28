import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import {
  appendContactEvent,
  ddb,
  emitUsage,
  getContact,
  getEffectiveEntitlement,
  getTenant,
  getTenantBySlugOrAlias,
  getUser,
  json,
  linkToken,
  ownerReplyTo,
  sendEmail,
  ulid,
  type CallerContext,
} from '@makerbay/core'

/**
 * First-party reviews: ask right after a finished job, collect the rating and
 * words on a page in the business's name, show the results on their MakerBay
 * page.
 *
 * One public commitment, enforced in code: **no gating.** Every respondent is
 * offered the Google review link after submitting, whatever the rating.
 * Routing only happy customers to Google breaks Google's policies, and the
 * roadmap promises we will not build it.
 */

type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<CallerContext>

interface BookingCompletedEvent {
  'detail-type': string
  detail: {
    tenantId: string
    bookingId?: string
    contactId: string
    email?: string
    name?: string
    serviceName?: string
  }
}

const Tables = {
  reviews: () => process.env.TABLE_REVIEWS!,
  config: () => process.env.TABLE_REVIEWSCONFIG!,
  visibility: () => process.env.TABLE_VISIBILITYCONFIG!,
}
const CHAT = 'https://chat.makerbay.app'

export interface ReviewRow {
  tenantId: string
  reviewId: string
  status: 'invited' | 'published' | 'hidden'
  inviteToken?: string
  contactId?: string
  name?: string
  email?: string
  rating?: number
  text?: string
  serviceName?: string
  createdAt: string
  respondedAt?: string
}

export const handler = async (
  event: Event | BookingCompletedEvent,
): Promise<APIGatewayProxyResultV2 | void> => {
  // EventBridge delivery: a job was just marked done somewhere in the system.
  if ('detail-type' in event) {
    if (event['detail-type'] === 'booking.completed') await onBookingCompleted(event.detail)
    return
  }

  const method = event.requestContext.http.method
  const path = event.rawPath
  try {
    if (path.startsWith('/v1/public/reviews')) return await publicRoute(method, path, event)

    const ctx = event.requestContext.authorizer.lambda
    const tenantId = await resolveTenantId(ctx)
    if (!tenantId) return json(401, { error: 'unauthorized' })

    const entitlement = await getEffectiveEntitlement(tenantId, 'reviews')
    if (!entitlement.enabled) return json(403, { error: 'module_not_enabled' })

    if (method === 'GET' && path === '/v1/reviews') return await list(tenantId)
    if (method === 'POST' && path === '/v1/reviews/invite') return await invite(tenantId, event, entitlement.limits)
    if (method === 'GET' && path === '/v1/reviews/config') {
      return json(200, { config: await getConfig(tenantId) })
    }
    if (method === 'PUT' && path === '/v1/reviews/config') return await writeConfig(tenantId, event)

    const one = path.match(/^\/v1\/reviews\/([0-9A-Z]{26})$/)
    if (method === 'PATCH' && one) return await patch(tenantId, one[1], event)

    return json(404, { error: 'not_found' })
  } catch (err) {
    console.error('reviews error', { path, method, err })
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

interface ReviewsConfigRow {
  tenantId: string
  autoAsk: boolean
  askMessage: string
}

async function getConfig(tenantId: string): Promise<ReviewsConfigRow> {
  const r = await ddb.send(new GetCommand({ TableName: Tables.config(), Key: { tenantId } }))
  return {
    tenantId,
    autoAsk: true,
    askMessage: 'Thanks for choosing us! Could you spare a minute to say how we did?',
    ...(r.Item ?? {}),
  } as ReviewsConfigRow
}

async function writeConfig(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const existing = await getConfig(tenantId)
  const config: ReviewsConfigRow = {
    tenantId,
    autoAsk: b.autoAsk === undefined ? existing.autoAsk : b.autoAsk === true,
    askMessage: String(b.askMessage ?? existing.askMessage).slice(0, 400),
  }
  await ddb.send(new PutCommand({ TableName: Tables.config(), Item: config }))
  return json(200, { config })
}

async function allReviews(tenantId: string): Promise<ReviewRow[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.reviews(),
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': tenantId },
      ScanIndexForward: false,
      Limit: 200,
    }),
  )
  return (r.Items ?? []) as ReviewRow[]
}

async function list(tenantId: string): Promise<APIGatewayProxyResultV2> {
  const reviews = await allReviews(tenantId)
  const rated = reviews.filter((r) => r.rating)
  return json(200, {
    reviews,
    stats: {
      invited: reviews.filter((r) => r.status === 'invited').length,
      responded: rated.length,
      average: rated.length
        ? Math.round((rated.reduce((s, r) => s + (r.rating ?? 0), 0) / rated.length) * 10) / 10
        : null,
    },
  })
}

/**
 * Ask one contact for a review. The booking.completed event takes the same
 * path automatically - see onBookingCompleted below.
 */
async function invite(
  tenantId: string,
  event: Event,
  limits: Record<string, number>,
): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const contact = await getContact(tenantId, String(b.contactId ?? ''))
  if (!contact) return json(404, { error: 'unknown_contact' })
  if (!contact.email) return json(400, { error: 'no_email', message: 'This contact has no email address.' })

  const monthStart = new Date().toISOString().slice(0, 7)
  const thisMonth = (await allReviews(tenantId)).filter((r) => r.createdAt.startsWith(monthStart)).length
  if (thisMonth >= (limits.reviewsPerMonth ?? 20)) {
    return json(429, { error: 'limit_exceeded', message: 'This plan has used its review requests for the month.' })
  }

  const result = await createInvite(tenantId, {
    contactId: contact.contactId,
    name: contact.name,
    email: contact.email,
    serviceName: b.serviceName ? String(b.serviceName) : undefined,
  })
  return json(200, result)
}

/** Shared with the booking-completion hook. Sends one email, never a barrage. */
export async function createInvite(
  tenantId: string,
  who: { contactId: string; name?: string; email: string; serviceName?: string },
): Promise<{ sent: boolean; emailError?: string; reviewId: string }> {
  const tenant = await getTenant(tenantId)
  const config = await getConfig(tenantId)
  const reviewId = ulid()
  const inviteToken = linkToken()
  const now = new Date().toISOString()

  await ddb.send(
    new PutCommand({
      TableName: Tables.reviews(),
      Item: {
        tenantId, reviewId, status: 'invited', inviteToken,
        contactId: who.contactId, name: who.name, email: who.email,
        serviceName: who.serviceName, createdAt: now,
      },
    }),
  )

  const url = `${CHAT}/review?slug=${encodeURIComponent(tenant?.slug ?? '')}&token=${inviteToken}`
  const notice = await sendEmail({
    to: who.email,
    ref: { tenantId, moduleId: 'reviews', refType: 'review', refId: who.contactId },
    optional: true,
    audience: 'customer' as const,
    fromName: tenant?.name ?? 'MakerBay',
    replyTo: await ownerReplyTo(tenantId),
    subject: `How did we do? - ${tenant?.name ?? ''}`,
    text: [
      `${who.name ?? 'Hi'},`,
      '',
      config.askMessage,
      '',
      `It takes a minute: ${url}`,
      '',
      tenant?.name ?? '',
    ].join('\n'),
  })

  await appendContactEvent(tenantId, who.contactId, {
    moduleId: 'reviews',
    title: notice.sent ? 'Asked for a review' : 'Review ask written (email not sent)',
  })
  await emitUsage({ tenantId, moduleId: 'reviews', metric: 'review.requested', quantity: 1 })
  return { sent: notice.sent, emailError: notice.error, reviewId }
}

/**
 * A completed job is the moment to ask. Tenants with the Reviews module and
 * autoAsk on get a first-party invite; otherwise fall back to the Get found
 * Google-link ask, if that is configured. One ask per completion, never both.
 */
async function onBookingCompleted(detail: BookingCompletedEvent['detail']): Promise<void> {
  const { tenantId, contactId, email } = detail
  if (!tenantId || !contactId || !email) return
  try {
    const entitlement = await getEffectiveEntitlement(tenantId, 'reviews')
    if (entitlement.enabled) {
      const config = await getConfig(tenantId)
      if (!config.autoAsk) return
      const monthStart = new Date().toISOString().slice(0, 7)
      const thisMonth = (await allReviews(tenantId)).filter((r) => r.createdAt.startsWith(monthStart)).length
      if (thisMonth >= (entitlement.limits.reviewsPerMonth ?? 20)) return
      await createInvite(tenantId, {
        contactId, email, name: detail.name, serviceName: detail.serviceName,
      })
      return
    }

    // No Reviews module: the plain Google-link ask configured under Get found.
    const cfg = await ddb.send(
      new GetCommand({ TableName: Tables.visibility(), Key: { tenantId } }),
    )
    const reviewLink = String(cfg.Item?.reviewLink ?? '')
    if (cfg.Item?.autoAsk !== true || !reviewLink) return
    const tenant = await getTenant(tenantId)
    const notice = await sendEmail({
      to: email,
      ref: { tenantId, moduleId: 'reviews', refType: 'review', refId: contactId },
      optional: true,
      audience: 'customer' as const,
      fromName: tenant?.name ?? 'MakerBay',
      replyTo: await ownerReplyTo(tenantId),
      subject: `How did we do? - ${tenant?.name ?? ''}`,
      text: [
        String(cfg.Item?.askMessage ?? 'Thanks for choosing us! A Google review takes a minute and makes a real difference.'),
        '',
        `Leave a review: ${reviewLink}`,
        '',
        tenant?.name ?? '',
      ].join('\n'),
    })
    await appendContactEvent(tenantId, contactId, {
      moduleId: 'visibility',
      title: notice.sent ? 'Asked for a Google review after a completed job' : 'Review ask written (email not sent)',
    })
    await emitUsage({ tenantId, moduleId: 'visibility', metric: 'review.requested', quantity: 1 })
  } catch (err) {
    // Asking is best-effort; a failed ask must never dead-letter the event.
    console.warn('booking.completed review ask failed', { tenantId, err })
  }
}

/** Owner moderation: hide or restore. Never edit - the words are the customer's. */
async function patch(tenantId: string, reviewId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const status = b.status === 'hidden' ? 'hidden' : b.status === 'published' ? 'published' : undefined
  if (!status) return json(400, { error: 'unknown_status' })
  const r = await ddb.send(
    new GetCommand({ TableName: Tables.reviews(), Key: { tenantId, reviewId } }),
  )
  if (!r.Item || !r.Item.rating) return json(404, { error: 'not_found' })
  await ddb.send(
    new UpdateCommand({
      TableName: Tables.reviews(),
      Key: { tenantId, reviewId },
      UpdateExpression: 'SET #st = :s',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':s': status },
    }),
  )
  return json(200, { reviewId, status })
}

// ── Public ───────────────────────────────────────────────────────────────

async function publicRoute(method: string, path: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const q = event.queryStringParameters ?? {}
  const b = method === 'POST' ? body(event) : {}
  const slug = String(q.slug ?? b.slug ?? '')
  const tenant = slug ? await getTenantBySlugOrAlias(slug) : undefined
  if (!tenant) return json(404, { error: 'not_found' })

  // The published wall, for the presence page and the hosted list.
  if (method === 'GET' && path === '/v1/public/reviews') {
    const reviews = (await allReviews(tenant.tenantId))
      .filter((r) => r.status === 'published' && r.rating)
      .slice(0, 50)
      .map((r) => ({ rating: r.rating, text: r.text, name: r.name, at: r.respondedAt }))
    const avg = reviews.length
      ? Math.round((reviews.reduce((s, r) => s + (r.rating ?? 0), 0) / reviews.length) * 10) / 10
      : null
    return json(200, { business: tenant.name, average: avg, count: reviews.length, reviews })
  }

  const token = String(q.token ?? b.token ?? '')
  if (!token) return json(404, { error: 'not_found' })
  const found = (await allReviews(tenant.tenantId)).find((r) => r.inviteToken === token)
  if (!found) return json(404, { error: 'not_found' })

  if (method === 'GET' && path === '/v1/public/reviews/invite') {
    // The Google link is offered to everyone after responding - see below.
    return json(200, {
      business: tenant.name,
      name: found.name,
      serviceName: found.serviceName,
      responded: found.status !== 'invited',
    })
  }

  if (method === 'POST' && path === '/v1/public/reviews/respond') {
    // Double-submits return the same answer rather than a second review.
    if (found.status !== 'invited') return json(200, { already: true, googleLink: await googleLink(tenant.tenantId) })

    const rating = Number(b.rating)
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return json(400, { error: 'bad_rating' })
    const text = String(b.text ?? '').trim().slice(0, 1500)

    await ddb.send(
      new UpdateCommand({
        TableName: Tables.reviews(),
        Key: { tenantId: tenant.tenantId, reviewId: found.reviewId },
        ConditionExpression: '#st = :invited',
        UpdateExpression: 'SET #st = :pub, rating = :r, #tx = :t, respondedAt = :now',
        ExpressionAttributeNames: { '#st': 'status', '#tx': 'text' },
        ExpressionAttributeValues: {
          ':invited': 'invited', ':pub': 'published', ':r': rating, ':t': text,
          ':now': new Date().toISOString(),
        },
      }),
    )
    if (found.contactId) {
      await appendContactEvent(tenant.tenantId, found.contactId, {
        moduleId: 'reviews',
        title: `Left a ${rating}-star review`,
        body: text.slice(0, 200) || undefined,
      })
    }
    await emitUsage({ tenantId: tenant.tenantId, moduleId: 'reviews', metric: 'review.published', quantity: 1 })

    // No gating: the Google link goes to every respondent, whatever the rating.
    return json(200, { published: true, googleLink: await googleLink(tenant.tenantId) })
  }

  return json(404, { error: 'not_found' })
}

async function googleLink(tenantId: string): Promise<string | null> {
  const r = await ddb.send(
    new GetCommand({ TableName: Tables.visibility(), Key: { tenantId } }),
  )
  return (r.Item?.reviewLink as string | undefined) || null
}
