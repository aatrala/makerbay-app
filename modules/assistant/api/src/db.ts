import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { ddb } from '@makerbay/core'

const Tables = {
  sources: () => process.env.TABLE_SOURCES!,
  conversations: () => process.env.TABLE_CONVERSATIONS!,
  config: () => process.env.TABLE_ASSISTANT_CONFIG!,
  // Read-only views for grounding: the assistant should answer "where do you
  // work" and "what does it cost" from what the workspace already knows,
  // before a single document is uploaded.
  bookingServices: () => process.env.TABLE_BOOKINGSERVICES!,
  bookingConfig: () => process.env.TABLE_BOOKINGCONFIG!,
  presenceConfig: () => process.env.TABLE_PRESENCECONFIG!,
  quotesConfig: () => process.env.TABLE_QUOTESCONFIG!,
}

export interface SourceRow {
  tenantId: string
  sourceId: string
  name: string
  type: 'file' | 'text' | 'url'
  s3Key: string
  status: 'awaiting_upload' | 'processing' | 'ready' | 'failed'
  sizeBytes?: number
  ingestionJobId?: string
  /** url sources: the page fetched, when, and how much text it yielded. */
  sourceUrl?: string
  fetchedAt?: string
  charCount?: number
  warning?: string
  /** Published sources appear in the public help centre. Off by default. */
  published?: boolean
  /** S3 key of the model-formatted article body (markdown-lite), generated at publish. */
  helpBodyKey?: string
  /** "Was this helpful" votes from help centre readers. */
  helpfulYes?: number
  helpfulNo?: number
  /** Generated at publish time: customer-facing title/description/category. */
  helpMeta?: { title: string; description: string; category: string }
  createdAt: string
  updatedAt: string
}

export interface Citation {
  sourceId: string
  name: string
  /** The passage the answer came from, so a reader can check it. */
  excerpt: string
  /** Original page, when the source was scraped from the web. */
  sourceUrl?: string
}

export interface MessageRow {
  pk: string // tenantId#sessionId
  sk: string // sortable timestamp id
  tenantId: string // byTenant GSI partition key
  sessionId: string
  role: 'user' | 'assistant'
  text: string
  citations?: Citation[]
  fallback?: boolean
  feedback?: 'up' | 'down'
}

export interface AssistantConfigRow {
  tenantId: string
  name: string
  greeting: string
  instructions: string
  fallbackMessage: string
  brandColor: string
  /** Help centre is opt-in: a workspace's documents are private by default. */
  helpEnabled?: boolean
  helpTitle?: string
  helpIntro?: string
  /** Theme for the public help centre. Non-clean themes need a paid workspace. */
  helpTheme?: 'clean' | 'bold' | 'editorial' | 'ledger' | 'signwriter'
  /** Owner-pinned "Popular" articles (sourceIds, max 4). Trade and up. */
  helpPinned?: string[]
  /** Category display order override. Trade and up. */
  helpCategoryOrder?: string[]
  /** Genie branding: heading font (Google Fonts family), second accent, logo. */
  helpFontHead?: string
  helpAccent2?: string
  helpShowLogo?: boolean
}

export const DEFAULT_CONFIG: Omit<AssistantConfigRow, 'tenantId'> = {
  name: 'Assistant',
  greeting: 'Hi! Ask me anything - services, prices, availability.',
  instructions: '',
  fallbackMessage: "I don't have that information yet. Please contact the team directly.",
  brandColor: '#1a73e8',
  helpEnabled: false,
  helpTitle: '',
  helpIntro: '',
}

// ── Sources ──────────────────────────────────────────────────────────────

export async function putSource(row: SourceRow): Promise<void> {
  await ddb.send(new PutCommand({ TableName: Tables.sources(), Item: row }))
}

export async function getSource(tenantId: string, sourceId: string): Promise<SourceRow | undefined> {
  const r = await ddb.send(
    new GetCommand({ TableName: Tables.sources(), Key: { tenantId, sourceId } }),
  )
  return r.Item as SourceRow | undefined
}

export async function listSources(tenantId: string): Promise<SourceRow[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.sources(),
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': tenantId },
    }),
  )
  return (r.Items ?? []) as SourceRow[]
}

export async function updateSourceStatus(
  tenantId: string,
  sourceId: string,
  status: SourceRow['status'],
  ingestionJobId?: string,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: Tables.sources(),
      Key: { tenantId, sourceId },
      UpdateExpression: 'SET #s = :s, updatedAt = :u' + (ingestionJobId ? ', ingestionJobId = :j' : ''),
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s': status,
        ':u': new Date().toISOString(),
        ...(ingestionJobId ? { ':j': ingestionJobId } : {}),
      },
    }),
  )
}

export async function deleteSource(tenantId: string, sourceId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: Tables.sources(), Key: { tenantId, sourceId } }))
}

// ── Conversations ────────────────────────────────────────────────────────

export async function putMessage(row: MessageRow): Promise<void> {
  await ddb.send(new PutCommand({ TableName: Tables.conversations(), Item: row }))
}

export async function getSessionMessages(
  tenantId: string,
  sessionId: string,
  limit = 20,
): Promise<MessageRow[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.conversations(),
      KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': `${tenantId}#${sessionId}` },
      ScanIndexForward: false,
      Limit: limit,
    }),
  )
  return ((r.Items ?? []) as MessageRow[]).reverse()
}

/**
 * Recent messages across every session for a tenant, newest first. Bounded:
 * the inbox and insights summarise a recent window, not all history. When
 * tenants outgrow this, move session summaries into their own table.
 */
export async function listRecentMessages(tenantId: string, limit = 400): Promise<MessageRow[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.conversations(),
      IndexName: 'byTenant',
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': tenantId },
      ScanIndexForward: false,
      Limit: limit,
    }),
  )
  return (r.Items ?? []) as MessageRow[]
}

export async function setMessageFeedback(
  tenantId: string,
  sessionId: string,
  sk: string,
  feedback: 'up' | 'down',
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: Tables.conversations(),
      Key: { pk: `${tenantId}#${sessionId}`, sk },
      UpdateExpression: 'SET feedback = :f',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':f': feedback },
    }),
  )
}

// ── Config ───────────────────────────────────────────────────────────────

export async function getConfig(tenantId: string): Promise<AssistantConfigRow> {
  const r = await ddb.send(new GetCommand({ TableName: Tables.config(), Key: { tenantId } }))
  return { tenantId, ...DEFAULT_CONFIG, ...(r.Item ?? {}) } as AssistantConfigRow
}

export async function putConfig(row: AssistantConfigRow): Promise<void> {
  await ddb.send(new PutCommand({ TableName: Tables.config(), Item: row }))
}

/**
 * What the workspace itself already knows, as plain sentences the model can
 * quote: services and prices from Bookings, hours, service areas and contact
 * from the page settings. This is why a brand-new workspace can answer
 * "where do you work?" before its owner has uploaded anything.
 */
export async function businessFacts(tenantId: string, businessName: string): Promise<string> {
  try {
    const [services, hours, presence, quotesCfg] = await Promise.all([
      ddb.send(new QueryCommand({
        TableName: Tables.bookingServices(),
        KeyConditionExpression: 'tenantId = :t',
        ExpressionAttributeValues: { ':t': tenantId },
      })).then((r) => r.Items ?? []).catch(() => []),
      ddb.send(new GetCommand({ TableName: Tables.bookingConfig(), Key: { tenantId } }))
        .then((r) => r.Item).catch(() => undefined),
      ddb.send(new GetCommand({ TableName: Tables.presenceConfig(), Key: { tenantId } }))
        .then((r) => r.Item).catch(() => undefined),
      ddb.send(new GetCommand({ TableName: Tables.quotesConfig(), Key: { tenantId } }))
        .then((r) => r.Item).catch(() => undefined),
    ])

    const currency = String(quotesCfg?.currency ?? 'AUD')
    const cash = (cents: number) => {
      try {
        return new Intl.NumberFormat('en', { style: 'currency', currency }).format(cents / 100)
      } catch { return `$${(cents / 100).toFixed(2)}` }
    }

    const lines: string[] = [`Business name: ${businessName}.`]
    if (presence?.headline) lines.push(`What they do: ${presence.headline}.`)
    if (Array.isArray(presence?.serviceAreas) && presence.serviceAreas.length) {
      lines.push(`Service areas: ${presence.serviceAreas.join(', ')}.`)
    }
    const active = services.filter((s) => s.active)
    if (active.length) {
      lines.push('Services offered (bookable online):')
      for (const s of active.slice(0, 20)) {
        const price = s.priceCents ? `, ${cash(Number(s.priceCents))}` : ''
        lines.push(`- ${s.name} (${s.durationMinutes} min${price})${s.description ? `: ${s.description}` : ''}`)
      }
    }
    const hourEntries = hours?.hours && typeof hours.hours === 'object'
      ? Object.entries(hours.hours as Record<string, Array<{ from: string; to: string }>>)
          .filter(([, w]) => Array.isArray(w) && w.length)
      : []
    if (hourEntries.length) {
      lines.push(`Opening hours (${String(hours?.timezone ?? 'local time')}): ` +
        hourEntries.map(([d, w]) => `${d} ${w.map((x) => `${x.from}-${x.to}`).join(', ')}`).join('; ') + '.')
    }
    if (presence?.phone) lines.push(`Phone: ${presence.phone}.`)
    if (presence?.email) lines.push(`Email: ${presence.email}.`)
    return lines.length > 1 ? lines.join('\n') : ''
  } catch {
    // Grounding is an enhancement; a failed read must never block an answer.
    return ''
  }
}

export interface BusinessProfile {
  name: string
  headline?: string
  intro?: string
  photoUrl?: string
  areas: string[]
  phone?: string
  email?: string
  currency: string
  services: Array<{ name: string; description?: string; priceCents?: number; durationMinutes: number }>
  timezone?: string
  hours: Partial<Record<string, Array<{ from: string; to: string }>>>
  openLabel?: string
}

const DAY_FULL: Record<string, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
}

/** "Open now, until 17:00" in the business's own timezone. */
function openNowLabel(
  hours: Partial<Record<string, Array<{ from: string; to: string }>>>,
  timezone: string,
): string | undefined {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    })
    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]))
    const day = String(parts.weekday ?? 'Mon').slice(0, 3).toLowerCase()
    const hhmm = `${String(Number(parts.hour) % 24).padStart(2, '0')}:${parts.minute}`
    const windows = hours[day] ?? []
    const within = windows.find((w) => hhmm >= w.from && hhmm < w.to)
    if (within) return `Open now, until ${within.to}`
    const later = windows.find((w) => hhmm < w.from)
    if (later) return `Closed now, opens at ${later.from}`
    const order = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
    const start = order.indexOf(day)
    for (let i = 1; i <= 7; i++) {
      const next = order[(start + i) % 7]
      const w = hours[next]?.[0]
      if (w) return `Closed now, back ${i === 1 ? 'tomorrow' : DAY_FULL[next]} at ${w.from}`
    }
    return 'Closed'
  } catch {
    return undefined
  }
}

/**
 * The same workspace facts as businessFacts, but structured: the chat surface
 * renders these as instant cards (services, hours, contact) so a visitor
 * never pays a conversation turn - or the tenant an AI message - for a fact
 * the workspace already holds.
 */
export async function businessProfile(tenantId: string, businessName: string): Promise<BusinessProfile> {
  const [services, bookingCfg, presence, quotesCfg] = await Promise.all([
    ddb.send(new QueryCommand({
      TableName: Tables.bookingServices(),
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': tenantId },
    })).then((r) => r.Items ?? []).catch(() => []),
    ddb.send(new GetCommand({ TableName: Tables.bookingConfig(), Key: { tenantId } }))
      .then((r) => r.Item).catch(() => undefined),
    ddb.send(new GetCommand({ TableName: Tables.presenceConfig(), Key: { tenantId } }))
      .then((r) => r.Item).catch(() => undefined),
    ddb.send(new GetCommand({ TableName: Tables.quotesConfig(), Key: { tenantId } }))
      .then((r) => r.Item).catch(() => undefined),
  ])

  const timezone = bookingCfg?.timezone ? String(bookingCfg.timezone) : undefined
  const hours = (bookingCfg?.hours ?? {}) as BusinessProfile['hours']
  const hasHours = Object.values(hours).some((w) => Array.isArray(w) && w.length)

  return {
    name: businessName,
    headline: presence?.headline ? String(presence.headline) : undefined,
    intro: presence?.intro ? String(presence.intro).slice(0, 600) : undefined,
    photoUrl: presence?.photoKey ? `/${String(presence.photoKey)}` : undefined,
    areas: Array.isArray(presence?.serviceAreas) ? presence.serviceAreas.map(String) : [],
    phone: presence?.phone ? String(presence.phone) : undefined,
    email: presence?.email ? String(presence.email) : undefined,
    currency: String(quotesCfg?.currency ?? 'AUD'),
    services: services
      .filter((s) => s.active)
      .slice(0, 20)
      .map((s) => ({
        name: String(s.name),
        description: s.description ? String(s.description) : undefined,
        priceCents: s.priceCents != null ? Number(s.priceCents) : undefined,
        durationMinutes: Number(s.durationMinutes),
      })),
    timezone,
    hours,
    openLabel: hasHours && timezone ? openNowLabel(hours, timezone) : undefined,
  }
}
