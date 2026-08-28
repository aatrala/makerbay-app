import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { ddb } from './db'
import { getTenant } from './db'

/**
 * What a tenant's email should look like (issue 94).
 *
 * The four facts an email needs - business name, brand colour, logo, and
 * whether MakerBay is named as the sender - live in two module-owned tables.
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
  logoUrl?: string
  /** Under the rule. Empty for MakerBay's own mail to an owner. */
  footerNote: string
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

  const p = presence.Item as { accentColor?: string; photoKey?: string } | undefined
  const accent = HEX.test(String(p?.accentColor ?? '')) ? String(p!.accentColor) : DEFAULT_ACCENT

  return {
    name: tenant?.name ?? 'MakerBay',
    accent,
    // The presence hero photo, which is the only image a tenant has today.
    ...(p?.photoKey ? { logoUrl: `https://chat.makerbay.app/${p.photoKey}` } : {}),
    // Names us as the sender of record on customer-bound mail. A homeowner has
    // never heard of MakerBay, so the footer is where that is explained rather
    // than the From line, which stays the business.
    footerNote: `Sent by ${tenant?.name ?? 'this business'} via MakerBay.`,
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
  footerNote: '',
})
