import type { APIGatewayProxyResultV2 } from 'aws-lambda'
import { DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { ddb, json, listGrants, recordAudit, resolveEntitlement, ulid } from '@makerbay/core'
import {
  BLOCK_IDS,
  DEFAULT_BLOCKS,
  FONT_PAIRS,
  PAGE_STYLES,
  getPresenceConfig,
  putPresenceConfig,
  type FaqItem,
  type PageBlock,
  type PresenceConfigRow,
} from './db'

/**
 * Page styles, blocks, FAQ, palette, fonts and versioning (issue 45,
 * docs/spec-page-styles.md). The ladder in one line: Free looks good,
 * Trade is arranged your way, Genie is fully branded. Tier checks live
 * HERE, server-side - the dashboard shows locked options on purpose, and
 * nothing it sends is trusted.
 */

export type PageTier = 'free' | 'pro' | 'genie'

export async function pageTier(tenantId: string): Promise<PageTier> {
  const now = new Date().toISOString()
  const [presenceGrants, genieGrants] = await Promise.all([
    listGrants(tenantId, 'presence'),
    listGrants(tenantId, 'genie'),
  ])
  // The taster gives everyone Genie MESSAGES; the Genie TIER is a paid
  // grant or subscription, which always leaves a grant row.
  const genie = genieGrants.some(
    (g) => g.status === 'active' && (!g.expiresAt || g.expiresAt > now),
  )
  if (genie) return 'genie'
  const ent = resolveEntitlement('presence', presenceGrants, true)
  return ent.planTier === 'pro' ? 'pro' : 'free'
}

const Versions = () => process.env.TABLE_PRESENCEVERSIONS!
const KEEP_VERSIONS = 20

type Snapshot = Pick<
  PresenceConfigRow,
  'pageStyle' | 'blocks' | 'faq' | 'palette' | 'fontPair' | 'headline' | 'intro' | 'accentColor' | 'themeStyle'
>

const snapshotOf = (c: PresenceConfigRow): Snapshot => ({
  pageStyle: c.pageStyle ?? 'simple',
  blocks: c.blocks ?? DEFAULT_BLOCKS,
  faq: c.faq ?? [],
  palette: c.palette,
  fontPair: c.fontPair,
  headline: c.headline,
  intro: c.intro,
  accentColor: c.accentColor,
  themeStyle: c.themeStyle,
})

async function writeVersion(tenantId: string, snapshot: Snapshot, label: string): Promise<void> {
  const sk = `${new Date().toISOString()}#${ulid()}`
  await ddb.send(new PutCommand({
    TableName: Versions(),
    Item: { tenantId, sk, label, snapshot },
  }))
  // Keep the newest KEEP_VERSIONS; prune the tail so storage never grows
  // past a screenful of history.
  const r = await ddb.send(new QueryCommand({
    TableName: Versions(),
    KeyConditionExpression: 'tenantId = :t',
    ExpressionAttributeValues: { ':t': tenantId },
    ScanIndexForward: false,
    ProjectionExpression: 'sk',
  }))
  for (const item of (r.Items ?? []).slice(KEEP_VERSIONS)) {
    await ddb.send(new DeleteCommand({ TableName: Versions(), Key: { tenantId, sk: item.sk } }))
  }
}

const HEX = /^#[0-9a-fA-F]{6}$/

export async function readPage(tenantId: string): Promise<APIGatewayProxyResultV2> {
  const [config, tier] = await Promise.all([getPresenceConfig(tenantId), pageTier(tenantId)])
  return json(200, { page: snapshotOf(config), tier })
}

export async function writePage(
  tenantId: string,
  b: Record<string, unknown>,
  actor: { userId?: string; email?: string },
): Promise<APIGatewayProxyResultV2> {
  const [config, tier] = await Promise.all([getPresenceConfig(tenantId), pageTier(tenantId)])
  const wantPro = (what: string) =>
    json(402, { error: 'plan_required', message: `${what} comes with the Trade plan. Everything you see stays previewable - upgrading switches it on.` })

  const next: PresenceConfigRow = { ...config }

  if (b.pageStyle !== undefined) {
    const style = String(b.pageStyle)
    if (!PAGE_STYLES.includes(style as never)) return json(400, { error: 'unknown_style' })
    if (style !== 'simple' && tier === 'free') return wantPro('Choosing a page style')
    next.pageStyle = style as PresenceConfigRow['pageStyle']
  }

  if (b.blocks !== undefined) {
    if (!Array.isArray(b.blocks)) return json(400, { error: 'bad_blocks' })
    const blocks: PageBlock[] = []
    for (const raw of b.blocks as Array<Record<string, unknown>>) {
      const id = String(raw.id)
      if (!BLOCK_IDS.includes(id as never)) return json(400, { error: 'unknown_block', block: id })
      if (blocks.some((x) => x.id === id)) return json(400, { error: 'duplicate_block', block: id })
      blocks.push({ id: id as PageBlock['id'], visible: raw.visible !== false })
    }
    if (blocks.length !== BLOCK_IDS.length) return json(400, { error: 'missing_blocks' })
    const orderChanged = blocks.some((x, i) => (config.blocks ?? DEFAULT_BLOCKS)[i]?.id !== x.id)
    if (orderChanged && tier === 'free') return wantPro('Reordering blocks')
    next.blocks = blocks
  }

  if (b.faq !== undefined) {
    if (!Array.isArray(b.faq)) return json(400, { error: 'bad_faq' })
    if (tier === 'free' && (b.faq as unknown[]).length > 0) return wantPro('The FAQ')
    const faq: FaqItem[] = (b.faq as Array<Record<string, unknown>>)
      .slice(0, 20)
      .map((f) => ({ q: String(f.q ?? '').trim().slice(0, 120), a: String(f.a ?? '').trim().slice(0, 1200) }))
      .filter((f) => f.q && f.a)
    next.faq = faq
  }

  if (b.palette !== undefined) {
    if (tier === 'free' && b.palette !== null) return wantPro('The colour palette')
    if (b.palette === null) next.palette = undefined
    else {
      const p = b.palette as Record<string, unknown>
      const palette: NonNullable<PresenceConfigRow['palette']> = {}
      for (const k of ['paper', 'ink', 'button'] as const) {
        const v = String(p[k] ?? '')
        if (v && !HEX.test(v)) return json(400, { error: 'bad_colour', field: k })
        if (v) palette[k] = v
      }
      next.palette = Object.keys(palette).length ? palette : undefined
    }
  }

  if (b.fontPair !== undefined) {
    if (b.fontPair === null || b.fontPair === 'system') next.fontPair = undefined
    else {
      if (tier !== 'genie') {
        return json(402, { error: 'plan_required', message: 'Fonts come with the Genie plan - the fully branded page.' })
      }
      const fp = String(b.fontPair)
      if (!FONT_PAIRS.includes(fp as never)) return json(400, { error: 'unknown_font_pair' })
      next.fontPair = fp as PresenceConfigRow['fontPair']
    }
  }

  next.updatedAt = new Date().toISOString()
  await putPresenceConfig(next)
  // Versioning is a paid promise, but snapshots cost nothing to keep for
  // everyone - only the restore UI is gated.
  await writeVersion(tenantId, snapshotOf(next), 'saved')
  await recordAudit({
    tenantId,
    actor: { type: 'user', id: actor.userId ?? '', label: actor.email || undefined },
    origin: 'ui',
    action: 'presence.page_updated',
    moduleId: 'presence',
    summary: `Page settings saved - style ${next.pageStyle ?? 'simple'}${next.faq?.length ? `, ${next.faq.length} FAQ items` : ''}`,
  })
  return json(200, { page: snapshotOf(next), tier })
}

export async function listVersions(tenantId: string): Promise<APIGatewayProxyResultV2> {
  const tier = await pageTier(tenantId)
  if (tier === 'free') {
    return json(402, { error: 'plan_required', message: 'Version history comes with the Trade plan.' })
  }
  const r = await ddb.send(new QueryCommand({
    TableName: Versions(),
    KeyConditionExpression: 'tenantId = :t',
    ExpressionAttributeValues: { ':t': tenantId },
    ScanIndexForward: false,
    Limit: KEEP_VERSIONS,
  }))
  return json(200, {
    versions: (r.Items ?? []).map((v) => ({
      sk: v.sk,
      at: String(v.sk).split('#')[0],
      label: v.label,
      style: (v.snapshot as Snapshot | undefined)?.pageStyle ?? 'simple',
      faqCount: (v.snapshot as Snapshot | undefined)?.faq?.length ?? 0,
    })),
  })
}

export async function restoreVersion(
  tenantId: string,
  b: Record<string, unknown>,
  actor: { userId?: string; email?: string },
): Promise<APIGatewayProxyResultV2> {
  const tier = await pageTier(tenantId)
  if (tier === 'free') {
    return json(402, { error: 'plan_required', message: 'Version history comes with the Trade plan.' })
  }
  const sk = String(b.sk ?? '')
  const r = await ddb.send(new QueryCommand({
    TableName: Versions(),
    KeyConditionExpression: 'tenantId = :t AND sk = :s',
    ExpressionAttributeValues: { ':t': tenantId, ':s': sk },
    Limit: 1,
  }))
  const version = r.Items?.[0]
  if (!version) return json(404, { error: 'not_found' })

  const config = await getPresenceConfig(tenantId)
  const restored: PresenceConfigRow = {
    ...config,
    ...(version.snapshot as Snapshot),
    tenantId,
    updatedAt: new Date().toISOString(),
  }
  await putPresenceConfig(restored)
  // The restore itself becomes the newest version, so nothing is lost by
  // restoring - history only ever moves forward.
  await writeVersion(tenantId, snapshotOf(restored), `restored ${String(sk).slice(0, 16)}`)
  await recordAudit({
    tenantId,
    actor: { type: 'user', id: actor.userId ?? '', label: actor.email || undefined },
    origin: 'ui',
    action: 'presence.page_restored',
    moduleId: 'presence',
    summary: `Page settings restored to the version from ${String(sk).slice(0, 16).replace('T', ' ')}`,
  })
  return json(200, { page: snapshotOf(restored) })
}
