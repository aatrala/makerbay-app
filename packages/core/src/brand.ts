import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { ddb } from './db'
import { getTenant } from './db'

/**
 * What a tenant's email should look like (issue 94).
 *
 * The two facts an email actually uses - business name and brand colour -
 * live in two module-owned tables.
 * CLAUDE.md says data access goes through packages/core and is never
 * hand-rolled in module code, so this is the one place that reads both. The
 * booking Lambda asks for a brand; it does not reach into the presence table.
 *
 * The spec proposed denormalising these onto TenantRow so no second read is
 * needed. That is the right end state and this is not it: one extra GetItem on
 * a path that is already doing several, in exchange for no write-side
 * invalidation to get wrong and no backfill to run. Revisit if email volume
 * ever makes the read matter, which at a few hundred a day it does not.
 */

export interface TenantBrand {
  /** What the inbox list shows, which on a phone is all it shows. */
  name: string
  accent: string
  /**
   * The number from Your page, for printed documents - paper is the one
   * surface with no reply button. Absent when the tenant has not given one.
   */
  phone?: string
  /** The business photo, worn as the document logo where config allows. */
  photoUrl?: string
}

/** MakerBay's own colour, used when a tenant has not chosen one. */
const DEFAULT_ACCENT = '#c2410c'

const HEX = /^#[0-9a-fA-F]{6}$/

export async function getTenantBrand(tenantId: string): Promise<TenantBrand> {
  const [tenant, presence] = await Promise.all([
    getTenant(tenantId),
    ddb.send(new GetCommand({
      TableName: process.env.TABLE_PRESENCECONFIG!,
      Key: { tenantId },
    })).catch(() => ({ Item: undefined })),
  ])

  const p = presence.Item as
    | { accentColor?: string; photoKey?: string; phone?: string }
    | undefined
  const accent = HEX.test(String(p?.accentColor ?? '')) ? String(p!.accentColor) : DEFAULT_ACCENT
  const phone = String(p?.phone ?? '').trim()

  return {
    name: tenant?.name ?? 'MakerBay',
    accent,
    ...(phone ? { phone } : {}),
    ...(p?.photoKey ? { photoUrl: `https://chat.makerbay.app/${String(p.photoKey)}` } : {}),
  }
}

/**
 * A brand without touching the database.
 *
 * For the paths that already hold the name and have no reason to spend a read
 * on a colour - the mail-events consumer telling an owner their own address is
 * bouncing, for one.
 */
export const plainBrand = (name: string): TenantBrand => ({
  name,
  accent: DEFAULT_ACCENT,
})
