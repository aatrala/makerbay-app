import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { ddb } from '@makerbay/core'

const Tables = {
  config: () => process.env.TABLE_PRESENCECONFIG!,
  // Read-only views into other modules' tables. Presence renders what they
  // own; it never writes to them, and nothing here is stored twice.
  bookingServices: () => process.env.TABLE_BOOKINGSERVICES!,
  bookingConfig: () => process.env.TABLE_BOOKINGCONFIG!,
  assistantConfig: () => process.env.TABLE_ASSISTANT_CONFIG!,
  reviews: () => process.env.TABLE_REVIEWS!,
}

export interface PresenceConfigRow {
  tenantId: string
  headline: string
  intro: string
  serviceAreas: string[]
  phone: string
  email: string
  /** One hero image, stored in the embed bucket, served via chat.makerbay.app. */
  photoKey?: string
  showBooking: boolean
  showAssistant: boolean
  published: boolean
  /**
   * The tradie's own website, when they have one. Its presence flips our page
   * to noindex,follow - we do not compete with our own customer for their
   * brand, and we never cross-domain canonical.
   */
  websiteUrl?: string
  /** Page look: accent colour (falls back to the assistant brand colour). */
  accentColor?: string
  /** Page look: one of the named styles in render.ts THEMES. */
  themeStyle?: 'fresh' | 'warm' | 'bold'
  /** Layout: simple (one page), grow (previews + sub-pages), storefront (nav + sub-pages). */
  pageStyle?: PageStyle
  /** Block order and visibility; hero is always first and not listed. */
  blocks?: PageBlock[]
  /** Owner-written FAQ items (Trade). */
  faq?: FaqItem[]
  /** Palette overrides laid over the theme tokens (Trade). */
  palette?: { paper?: string; ink?: string; button?: string }
  /** Curated font pairing (Genie). */
  fontPair?: FontPair
  /** Presence Pro: the page on the tenant's own domain. See domain.ts. */
  customDomain?: string
  domainCertArn?: string
  domainStatus?: 'pending_validation' | 'pending_dns' | 'active'
  domainValidation?: { name: string; value: string }
  distributionId?: string
  distributionDomain?: string
  updatedAt?: string
}

export type PageStyle = 'simple' | 'grow' | 'storefront'
export type BlockId = 'about' | 'services' | 'faq' | 'reviews' | 'hours' | 'contact'
export interface PageBlock { id: BlockId; visible: boolean }
export interface FaqItem { q: string; a: string }
export type FontPair = 'system' | 'classic' | 'modern' | 'editorial' | 'friendly'

export const PAGE_STYLES: PageStyle[] = ['simple', 'grow', 'storefront']
export const BLOCK_IDS: BlockId[] = ['about', 'services', 'faq', 'reviews', 'hours', 'contact']
export const FONT_PAIRS: FontPair[] = ['system', 'classic', 'modern', 'editorial', 'friendly']

/** Today's page order - what every workspace has until it rearranges. */
export const DEFAULT_BLOCKS: PageBlock[] = BLOCK_IDS.map((id) => ({ id, visible: true }))

export const DEFAULT_PRESENCE: Omit<PresenceConfigRow, 'tenantId'> = {
  headline: '',
  intro: '',
  serviceAreas: [],
  phone: '',
  email: '',
  showBooking: true,
  showAssistant: true,
  published: true,
}

export async function getPresenceConfig(tenantId: string): Promise<PresenceConfigRow> {
  const r = await ddb.send(new GetCommand({ TableName: Tables.config(), Key: { tenantId } }))
  return { tenantId, ...DEFAULT_PRESENCE, ...(r.Item ?? {}) } as PresenceConfigRow
}

export async function putPresenceConfig(row: PresenceConfigRow): Promise<void> {
  await ddb.send(new PutCommand({ TableName: Tables.config(), Item: row }))
}

// ── Read-only views ──────────────────────────────────────────────────────

export interface ServiceView {
  name: string
  description?: string
  durationMinutes: number
  priceCents?: number
}

export async function activeServices(tenantId: string): Promise<ServiceView[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.bookingServices(),
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': tenantId },
    }),
  )
  return ((r.Items ?? []) as Array<ServiceView & { active?: boolean }>)
    .filter((s) => s.active)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, description, durationMinutes, priceCents }) => ({
      name, description, durationMinutes, priceCents,
    }))
}

export interface HoursView {
  timezone: string
  hours: Partial<Record<string, Array<{ from: string; to: string }>>>
}

export async function bookingHours(tenantId: string): Promise<HoursView | undefined> {
  const r = await ddb.send(
    new GetCommand({ TableName: Tables.bookingConfig(), Key: { tenantId } }),
  )
  if (!r.Item) return undefined
  return { timezone: String(r.Item.timezone ?? 'UTC'), hours: r.Item.hours ?? {} }
}

export interface AssistantView {
  name: string
  greeting: string
  brandColor: string
}

export async function assistantView(tenantId: string): Promise<AssistantView> {
  const r = await ddb.send(
    new GetCommand({ TableName: Tables.assistantConfig(), Key: { tenantId } }),
  )
  return {
    name: String(r.Item?.name ?? 'Assistant'),
    greeting: String(r.Item?.greeting ?? ''),
    brandColor: /^#[0-9a-fA-F]{6}$/.test(String(r.Item?.brandColor)) ? String(r.Item!.brandColor) : '#c2410c',
  }
}

export interface ReviewsView {
  average: number
  count: number
  items: Array<{ rating: number; text?: string; name?: string }>
}

/** Published first-party reviews, newest first. Read-only, like everything above. */
export async function publishedReviews(tenantId: string): Promise<ReviewsView | undefined> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.reviews(),
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': tenantId },
      ScanIndexForward: false,
      Limit: 200,
    }),
  )
  const rows = (r.Items ?? []).filter((x) => x.status === 'published' && x.rating)
  if (!rows.length) return undefined
  const average = rows.reduce((s, x) => s + Number(x.rating), 0) / rows.length
  return {
    average: Math.round(average * 10) / 10,
    count: rows.length,
    items: rows.slice(0, 5).map((x) => ({
      rating: Number(x.rating),
      text: x.text ? String(x.text) : undefined,
      name: x.name ? String(x.name) : undefined,
    })),
  }
}

/**
 * The tenant whose active custom domain matches the request host. Backed by
 * the byDomain GSI, so an unknown host costs one cheap query.
 */
export async function findByCustomDomain(domain: string): Promise<PresenceConfigRow | undefined> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.config(),
      IndexName: 'byDomain',
      KeyConditionExpression: 'customDomain = :d',
      ExpressionAttributeValues: { ':d': domain },
      Limit: 1,
    }),
  )
  return (r.Items ?? [])[0] as PresenceConfigRow | undefined
}
