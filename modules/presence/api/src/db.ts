import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { ddb } from '@makerbay/core'

const Tables = {
  config: () => process.env.TABLE_PRESENCECONFIG!,
  // Read-only views into other modules' tables. Presence renders what they
  // own; it never writes to them, and nothing here is stored twice.
  bookingServices: () => process.env.TABLE_BOOKINGSERVICES!,
  bookingConfig: () => process.env.TABLE_BOOKINGCONFIG!,
  assistantConfig: () => process.env.TABLE_ASSISTANT_CONFIG!,
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
  updatedAt?: string
}

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
