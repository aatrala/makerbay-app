import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type Tool,
} from '@aws-sdk/client-bedrock-runtime'
import {
  ddb,
  emitUsage,
  getEffectiveEntitlement,
  getMonthUsage,
  getTenant,
  getUser,
  ulid,
  type CallerContext,
} from '@makerbay/core'

/**
 * Genie v1: the OWNER's conversational view of their whole business. Reads
 * everything - the activity trail, bookings, requests, money, reviews - and
 * answers in plain sentences with the numbers to back them.
 *
 * Deliberately READ-ONLY in v1. Writes ship behind server-held confirmation
 * cards (see docs/spec-genie.md) - nothing will ever change because a model
 * felt like it. Until then Genie says what it cannot do and deep-links to
 * the screen that can.
 */

type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<CallerContext>

const runtime = new BedrockRuntimeClient({})
const MODEL_ID = () => process.env.CHAT_MODEL_ID!

const Tables = {
  sessions: () => process.env.TABLE_GENIESESSIONS!,
  audit: () => process.env.TABLE_AUDIT!,
  bookings: () => process.env.TABLE_BOOKINGS!,
  requests: () => process.env.TABLE_REQUESTS!,
  quotes: () => process.env.TABLE_QUOTES!,
  invoices: () => process.env.TABLE_INVOICES!,
  payments: () => process.env.TABLE_PAYMENTS!,
  reviews: () => process.env.TABLE_REVIEWS!,
  bookingServices: () => process.env.TABLE_BOOKINGSERVICES!,
  presenceConfig: () => process.env.TABLE_PRESENCECONFIG!,
  quotesConfig: () => process.env.TABLE_QUOTESCONFIG!,
}

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

export const handler = async (event: Event): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method
  const path = event.rawPath
  try {
    const ctx = event.requestContext.authorizer.lambda
    const tenantId = await resolveTenantId(ctx)
    if (!tenantId) return json(401, { error: 'unauthorized' })

    const entitlement = await getEffectiveEntitlement(tenantId, 'genie')
    if (!entitlement.enabled) {
      return json(403, {
        error: 'module_not_enabled',
        message: 'Genie is part of the Genie plan. It is being rolled out - ask us for early access.',
      })
    }

    if (method === 'POST' && path === '/v1/genie/chat') return await chat(tenantId, entitlement.limits, event)
    if (method === 'GET' && path === '/v1/genie/history') return await history(tenantId, event)

    return json(404, { error: 'not_found' })
  } catch (err) {
    console.error('genie error', { path, method, err })
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

// ── Sessions ─────────────────────────────────────────────────────────────

interface GenieMessage {
  pk: string
  sk: string
  role: 'user' | 'assistant'
  text: string
}

async function sessionMessages(tenantId: string, sessionId: string, limit = 16): Promise<GenieMessage[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.sessions(),
      KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': `${tenantId}#${sessionId}` },
      ScanIndexForward: false,
      Limit: limit,
    }),
  )
  return ((r.Items ?? []) as GenieMessage[]).reverse()
}

async function saveMessage(tenantId: string, sessionId: string, role: 'user' | 'assistant', text: string): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: Tables.sessions(),
      Item: {
        pk: `${tenantId}#${sessionId}`,
        sk: `${new Date().toISOString()}#${ulid()}`,
        tenantId,
        sessionId,
        role,
        text,
        // Conversations are working memory, not records - the audit trail is
        // the record. Expire after 90 days.
        expiresAt: Math.floor(Date.now() / 1000) + 90 * 86_400,
      },
    }),
  )
}

async function history(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const sessionId = String(event.queryStringParameters?.sessionId ?? '')
  if (!/^[A-Z0-9]{10,32}$/.test(sessionId)) return json(200, { messages: [] })
  const messages = await sessionMessages(tenantId, sessionId, 50)
  return json(200, { messages: messages.map((m) => ({ role: m.role, text: m.text })) })
}

// ── Read tools ───────────────────────────────────────────────────────────

const q = async (table: string, tenantId: string, limit = 100) =>
  (await ddb.send(new QueryCommand({
    TableName: table,
    KeyConditionExpression: 'tenantId = :t',
    ExpressionAttributeValues: { ':t': tenantId },
    ScanIndexForward: false,
    Limit: limit,
  }))).Items ?? []

type ToolResult = Record<string, unknown>

const TOOL_RUNNERS: Record<string, (tenantId: string, args: Record<string, unknown>) => Promise<ToolResult>> = {
  async activity(tenantId, args) {
    const month = /^\d{4}-\d{2}$/.test(String(args.month)) ? String(args.month) : new Date().toISOString().slice(0, 7)
    const r = await ddb.send(new QueryCommand({
      TableName: Tables.audit(),
      KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': `${tenantId}#${month}` },
      ScanIndexForward: false,
      Limit: 100,
    }))
    return {
      month,
      entries: (r.Items ?? []).map((i) => ({ ts: i.ts, module: i.moduleId, summary: i.summary })),
    }
  },
  async bookings(tenantId, args) {
    const rows = await q(Tables.bookings(), tenantId, 200)
    const from = args.from ? String(args.from) : new Date(Date.now() - 86_400_000).toISOString()
    const to = args.to ? String(args.to) : new Date(Date.now() + 14 * 86_400_000).toISOString()
    return {
      window: { from, to },
      bookings: rows
        .filter((b) => String(b.startsAt) >= from && String(b.startsAt) <= to)
        .sort((a, b2) => String(a.startsAt).localeCompare(String(b2.startsAt)))
        .map((b) => ({ startsAt: b.startsAt, service: b.serviceName, status: b.status, customer: b.name ?? b.email })),
      dashboard: '/booking/diary',
    }
  },
  async requests(tenantId) {
    const rows = await q(Tables.requests(), tenantId, 100)
    const open = rows.filter((r) => r.status !== 'closed')
    return {
      openCount: open.length,
      open: open.slice(0, 20).map((r) => ({ title: r.title, kind: r.kind, status: r.status, createdAt: r.createdAt })),
      dashboard: '/requests',
    }
  },
  async money(tenantId) {
    const [quotes, invoices, payments, cfg] = await Promise.all([
      q(Tables.quotes(), tenantId, 100),
      q(Tables.invoices(), tenantId, 100),
      q(Tables.payments(), tenantId, 100),
      ddb.send(new GetCommand({ TableName: Tables.quotesConfig(), Key: { tenantId } })).then((r) => r.Item),
    ])
    const unpaid = invoices.filter((i) => i.status === 'sent')
    const prefix = String(cfg?.docPrefix ?? '')
    return {
      quotes: {
        awaitingAnswer: quotes.filter((x) => x.status === 'sent').length,
        accepted: quotes.filter((x) => x.status === 'accepted').length,
        drafts: quotes.filter((x) => x.status === 'draft').length,
      },
      unpaidInvoices: unpaid.map((i) => ({
        label: `${prefix ? `${prefix}-` : ''}INV-${String(i.number).padStart(3, '0')}`, customer: i.customerName ?? i.customerEmail,
        totalCents: i.totalCents, currency: i.currency, dueAt: i.dueAt,
      })),
      recentPayments: payments.slice(0, 10).map((p) => ({
        description: p.description, amountCents: p.amountCents, currency: p.currency, status: p.status, at: p.paidAt ?? p.createdAt,
      })),
      dashboard: '/quotes/invoices',
    }
  },
  async reviews(tenantId) {
    const rows = await q(Tables.reviews(), tenantId, 100)
    const rated = rows.filter((r) => r.rating)
    return {
      average: rated.length ? Math.round(rated.reduce((s, r) => s + Number(r.rating), 0) / rated.length * 10) / 10 : null,
      count: rated.length,
      awaitingReply: rows.filter((r) => r.status === 'invited').length,
      latest: rated.slice(0, 5).map((r) => ({ rating: r.rating, text: String(r.text ?? '').slice(0, 200), name: r.name })),
      dashboard: '/reviews',
    }
  },
  async business(tenantId) {
    const [presence, services, quotesCfg, tenant] = await Promise.all([
      ddb.send(new GetCommand({ TableName: Tables.presenceConfig(), Key: { tenantId } })).then((r) => r.Item),
      q(Tables.bookingServices(), tenantId, 50),
      ddb.send(new GetCommand({ TableName: Tables.quotesConfig(), Key: { tenantId } })).then((r) => r.Item),
      getTenant(tenantId),
    ])
    return {
      name: tenant?.name,
      slug: tenant?.slug,
      pageUrl: `https://makerbay.app/p/${tenant?.slug}`,
      headline: presence?.headline,
      areas: presence?.serviceAreas ?? [],
      published: presence?.published,
      customDomain: presence?.customDomain ?? null,
      currency: quotesCfg?.currency ?? 'AUD',
      services: services.filter((s) => s.active).map((s) => ({ name: s.name, priceCents: s.priceCents, minutes: s.durationMinutes })),
      dashboard: '/page',
    }
  },
}

const TOOLS: Tool[] = [
  { toolSpec: { name: 'activity', description: 'The workspace activity trail: everything that happened, one sentence per event. Args: month (yyyy-mm, optional, defaults to current).', inputSchema: { json: { type: 'object', properties: { month: { type: 'string' } } } } } },
  { toolSpec: { name: 'bookings', description: 'Bookings in a window (default: yesterday to +14 days). Args: from, to (ISO dates, optional).', inputSchema: { json: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } } } },
  { toolSpec: { name: 'requests', description: 'Open requests: leads, questions, missed calls waiting on the owner.', inputSchema: { json: { type: 'object', properties: {} } } } },
  { toolSpec: { name: 'money', description: 'Money picture: quotes awaiting answer, unpaid invoices, recent payments.', inputSchema: { json: { type: 'object', properties: {} } } } },
  { toolSpec: { name: 'reviews', description: 'Review stats, latest reviews, and how many asks await a reply.', inputSchema: { json: { type: 'object', properties: {} } } } },
  { toolSpec: { name: 'business', description: 'The business profile: page, services, prices, areas, currency, domain.', inputSchema: { json: { type: 'object', properties: {} } } } },
]

// ── The loop ─────────────────────────────────────────────────────────────

async function chat(
  tenantId: string,
  limits: Record<string, number>,
  event: Event,
): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const message = String(b.message ?? '').trim().slice(0, 2000)
  if (!message) return json(400, { error: 'message_required' })

  const cap = limits.genieMessagesPerMonth ?? 250
  const used = (await getMonthUsage(tenantId, new Date().toISOString().slice(0, 7)))['genie.message'] ?? 0
  if (used >= cap) {
    return json(429, {
      error: 'limit_exceeded',
      message: `Genie has answered ${used} times this month - the plan's allowance is used up. It resets on the 1st.`,
    })
  }

  const sessionId = /^[A-Z0-9]{10,32}$/.test(String(b.sessionId ?? '')) ? String(b.sessionId) : ulid()
  const tenant = await getTenant(tenantId)
  const history = await sessionMessages(tenantId, sessionId, 12)

  const system = [
    `You are Genie, the private business copilot for the OWNER of "${tenant?.name}".`,
    'You are talking to the owner, never to their customers. Be direct, concrete and brief - a tradie between jobs, on a phone.',
    'Always fetch real data with tools before answering questions about the business; cite actual numbers and names from tool results, never invent any.',
    'You are READ-ONLY in this version: you cannot change, send, book or reply to anything yet. When the owner asks you to act, say so plainly in one sentence and give the dashboard path from the tool result (e.g. "I can\'t send it yet - do it under /quotes/invoices").',
    `Money amounts in tool results are cents; format them as currency. Today is ${new Date().toISOString().slice(0, 10)}.`,
    'For a briefing, combine activity + bookings + requests + money into a short prioritised picture: what needs the owner first.',
  ].join('\n')

  const messages: Message[] = [
    ...history.map((m) => ({ role: m.role, content: [{ text: m.text }] }) as Message),
    { role: 'user', content: [{ text: message }] },
  ]

  let text = ''
  const toolsUsed: string[] = []
  for (let turn = 0; turn < 8; turn++) {
    const r = await runtime.send(new ConverseCommand({
      modelId: MODEL_ID(),
      system: [{ text: system }],
      messages,
      toolConfig: { tools: TOOLS },
      inferenceConfig: { maxTokens: 1200, temperature: 0.3 },
    }))
    const out = r.output?.message
    if (!out) break
    messages.push(out)

    if (r.stopReason === 'tool_use') {
      const results: Message['content'] = []
      for (const block of out.content ?? []) {
        if (!block.toolUse?.name) continue
        const runner = TOOL_RUNNERS[block.toolUse.name]
        toolsUsed.push(block.toolUse.name)
        let result: ToolResult
        try {
          result = runner
            ? await runner(tenantId, (block.toolUse.input ?? {}) as Record<string, unknown>)
            : { error: 'unknown_tool' }
        } catch (err) {
          console.warn('genie tool failed', { tool: block.toolUse.name, err: String(err) })
          result = { error: 'tool_failed' }
        }
        results!.push({
          // The SDK's DocumentType is stricter than our plain records; the
          // payload is JSON-serialisable by construction.
          toolResult: { toolUseId: block.toolUse.toolUseId, content: [{ json: result as never }] },
        })
      }
      messages.push({ role: 'user', content: results })
      continue
    }

    text = out.content?.map((c) => c.text ?? '').join('').trim() ?? ''
    break
  }

  if (!text) text = 'Something went sideways putting that answer together - try asking again.'

  await saveMessage(tenantId, sessionId, 'user', message)
  await saveMessage(tenantId, sessionId, 'assistant', text)
  await emitUsage({ tenantId, moduleId: 'genie', metric: 'genie.message', quantity: 1 })

  return json(200, { sessionId, text, toolsUsed: [...new Set(toolsUsed)], remaining: Math.max(0, cap - used - 1) })
}
