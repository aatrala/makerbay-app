import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { ddb } from './db'

/**
 * The draft page a stranger gets back from the homepage, before they have an
 * account (issue 145).
 *
 * It lives here rather than in either module because two modules need it and
 * CLAUDE.md is explicit: cross-module data access goes through packages/core
 * and is never hand-rolled in module code. Setup writes the draft after
 * reading somebody's website; presence reads it to render a preview, because
 * presence owns page rendering and should not grow a second renderer.
 *
 * The alternative was one module importing the other's database helper, which
 * has no precedent in this repo and would have been the first crack in the
 * module seam.
 *
 * A prospect row is NOT tenant-scoped, and that is the one deliberate
 * exception to the tenant rule in the whole codebase: there is no tenant yet.
 * It is keyed on an unguessable token, expires in a fortnight, and holds only
 * what was read off a public website.
 */

const TABLE = () => process.env.TABLE_SETUPJOBS!

export interface ProspectPreview {
  /** The address we read, shown back so nobody wonders where this came from. */
  url: string
  businessName?: string
  /** Partial presence config: headline, intro, phone, email, serviceAreas. */
  proposed: Record<string, unknown>
  createdAt: string
  claimedBy?: string
}

/**
 * Read a draft by its token.
 *
 * The token is the only credential, so this is deliberately narrow: it
 * returns what is needed to render a preview and nothing else. The raw
 * scraped excerpt and the internal diff stay in the setup module, because a
 * public renderer has no business with either.
 */
export async function getProspectPreview(
  token: string,
): Promise<ProspectPreview | undefined> {
  const clean = String(token ?? '').trim()
  // Tokens are opaque and fixed-shape; anything else is not worth a read.
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(clean)) return undefined

  const r = await ddb.send(new GetCommand({
    TableName: TABLE(),
    Key: { pk: `prospect#${clean}`, sk: 'draft' },
  }))
  const item = r.Item as
    | { url?: string; businessName?: string; proposed?: Record<string, unknown>
        createdAt?: string; claimedBy?: string }
    | undefined
  if (!item?.proposed) return undefined

  return {
    url: String(item.url ?? ''),
    businessName: item.businessName ? String(item.businessName) : undefined,
    proposed: item.proposed,
    createdAt: String(item.createdAt ?? ''),
    claimedBy: item.claimedBy,
  }
}
