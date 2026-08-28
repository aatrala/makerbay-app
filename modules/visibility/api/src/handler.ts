import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import {
  appendContactEvent,
  ddb,
  emitUsage,
  getContact,
  getTenant,
  getUser,
  json,
  ownerReplyTo,
  sendEmail,
  type CallerContext,
} from '@makerbay/core'

/**
 * Get found: Google Business Profile assist and review requests.
 *
 * Deliberately NOT a Google API integration. GBP is verified against the
 * business itself - a platform can help get it right but can never own it,
 * and the API needs per-tenant OAuth plus Google approval with unknown lead
 * time. What moves the needle is the profile being correct and reviews being
 * asked for at the right moment, and both of those we can do honestly today.
 * See docs/analysis-search-visibility.md section 5.
 */

type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<CallerContext>

const Tables = { config: () => process.env.TABLE_VISIBILITYCONFIG! }

interface VisibilityConfigRow {
  tenantId: string
  /** The business's own Google review link, pasted from their GBP dashboard. */
  reviewLink: string
  /** Ask automatically when a booking is marked completed. */
  autoAsk: boolean
  askMessage: string
  /** GBP checklist progress: stepId -> done. */
  checklist: Record<string, boolean>
  updatedAt?: string
}

const DEFAULTS: Omit<VisibilityConfigRow, 'tenantId'> = {
  reviewLink: '',
  autoAsk: false,
  askMessage:
    'Thanks for choosing us! If you were happy with the work, a Google review takes a minute and makes a real difference to a small business.',
  checklist: {},
}

export async function getVisibilityConfig(tenantId: string): Promise<VisibilityConfigRow> {
  const r = await ddb.send(new GetCommand({ TableName: Tables.config(), Key: { tenantId } }))
  return { tenantId, ...DEFAULTS, ...(r.Item ?? {}) } as VisibilityConfigRow
}

export const handler = async (event: Event): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method
  const path = event.rawPath
  try {
    const ctx = event.requestContext.authorizer.lambda
    const tenantId = await resolveTenantId(ctx)
    if (!tenantId) return json(401, { error: 'unauthorized' })

    if (method === 'GET' && path === '/v1/visibility/config') {
      return json(200, { config: await getVisibilityConfig(tenantId) })
    }
    if (method === 'PUT' && path === '/v1/visibility/config') return await writeConfig(tenantId, event)
    if (method === 'POST' && path === '/v1/visibility/ask') return await ask(tenantId, event)

    return json(404, { error: 'not_found' })
  } catch (err) {
    console.error('visibility error', { path, method, err })
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

async function writeConfig(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const existing = await getVisibilityConfig(tenantId)

  const reviewLink = b.reviewLink === undefined ? existing.reviewLink : String(b.reviewLink).trim()
  // Only Google's own review-flow hosts are accepted. Anything else here would
  // let a pasted typo quietly send every customer somewhere wrong for months.
  if (reviewLink && !/^https:\/\/(g\.page\/r\/|search\.google\.com\/local\/writereview|www\.google\.com\/maps)/.test(reviewLink)) {
    return json(400, {
      error: 'invalid_url',
      message: 'That does not look like a Google review link. In your Google Business Profile, use "Ask for reviews" and copy the link it gives you (it starts with g.page/r/).',
    })
  }

  const config: VisibilityConfigRow = {
    ...existing,
    tenantId,
    reviewLink,
    autoAsk: b.autoAsk === undefined ? existing.autoAsk : b.autoAsk === true,
    askMessage: String(b.askMessage ?? existing.askMessage).slice(0, 500),
    checklist:
      b.checklist && typeof b.checklist === 'object'
        ? Object.fromEntries(
            Object.entries(b.checklist as Record<string, unknown>)
              .slice(0, 30)
              .map(([k, v]) => [k.slice(0, 40), v === true]),
          )
        : existing.checklist,
    updatedAt: new Date().toISOString(),
  }
  await ddb.send(new PutCommand({ TableName: Tables.config(), Item: config }))
  return json(200, { config })
}

/** Ask one contact for a review, by email, with their Google link. */
async function ask(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const contactId = String(b.contactId ?? '')
  const config = await getVisibilityConfig(tenantId)
  if (!config.reviewLink) {
    return json(400, { error: 'no_review_link', message: 'Add your Google review link first.' })
  }
  const contact = await getContact(tenantId, contactId)
  if (!contact) return json(404, { error: 'unknown_contact' })
  if (!contact.email) {
    return json(400, { error: 'no_email', message: 'This contact has no email address to send to.' })
  }

  const tenant = await getTenant(tenantId)
  const notice = await sendEmail({
    to: contact.email,
    ref: { tenantId, moduleId: 'visibility', refType: 'review', refId: contactId },
    optional: true,
    audience: 'customer' as const,
    fromName: tenant?.name ?? 'MakerBay',
    replyTo: await ownerReplyTo(tenantId),
    subject: `How did we do? - ${tenant?.name ?? ''}`,
    text: [
      `${contact.name ?? 'Hi'},`,
      '',
      config.askMessage,
      '',
      `Leave a review: ${config.reviewLink}`,
      '',
      tenant?.name ?? '',
    ].join('\n'),
  })

  await appendContactEvent(tenantId, contactId, {
    moduleId: 'visibility',
    title: notice.sent ? 'Asked for a Google review' : 'Review ask written (email not sent)',
  })
  await emitUsage({ tenantId, moduleId: 'visibility', metric: 'review.requested', quantity: 1 })
  return json(200, { sent: notice.sent, emailError: notice.error })
}
