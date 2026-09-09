/**
 * How a Better Auth row becomes a DynamoDB item (issue 157).
 *
 * Single table. The primary key is `<model>#<id>`, so every lookup by id is
 * one GetItem. Three global secondary indexes carry the lookups Better Auth
 * actually makes - by email, by session token, by provider account, by
 * verification identifier, by userId - and a "model partition" so a query
 * with no usable key still only reads one model's rows rather than the
 * whole table.
 *
 * Which fields form a key is a table, not code: adding a model or a lookup
 * is one line here and nothing else changes.
 */

/** Per model, the field sets that get their own GSI (gsi1 first, gsi2 second). */
export const INDEXES: Record<string, string[][]> = {
  user: [['email']],
  session: [['token'], ['userId']],
  account: [['providerId', 'accountId'], ['userId']],
  verification: [['identifier']],
  jwks: [],
  rateLimit: [['key']],
  passkey: [['credentialID'], ['userId']],
  organization: [['slug']],
  member: [['organizationId'], ['userId']],
  invitation: [['organizationId'], ['email']],
  team: [['organizationId']],
  teamMember: [['teamId'], ['userId']],
  twoFactor: [['userId'], ['secret']],
  apikey: [['key'], ['userId']],
  oauthApplication: [['clientId'], ['userId']],
  oauthAccessToken: [['accessToken'], ['refreshToken']],
  oauthConsent: [['clientId'], ['userId']],
}

/** Models whose rows expire; DynamoDB TTL removes them an hour after `expiresAt`. */
export const EXPIRING = new Set(['session', 'verification', 'rateLimit', 'invitation', 'oauthAccessToken'])

/** Attribute names this adapter owns on every item. Never returned to Better Auth. */
export const INTERNAL = new Set(['pk', '_model', 'gsi1pk', 'gsi1sk', 'gsi2pk', 'gsi2sk', 'gsi3pk', 'gsi3sk', 'ttl'])

export const pkOf = (model: string, id: unknown): string => `${model}#${String(id)}`

/**
 * Email-like fields are compared case-insensitively everywhere in practice,
 * and Better Auth asks for them with `mode: 'insensitive'` in places. The key
 * is lowercased so both a sensitive and an insensitive equality land on the
 * same GSI partition; the stored attribute keeps the user's casing.
 */
export const isEmailField = (field: string): boolean => /email/i.test(field)

export const keyValue = (field: string, value: unknown): string =>
  isEmailField(field) ? String(value).toLowerCase() : String(value)

/** The GSI partition key for one index definition, or undefined if a field is missing. */
export function indexPk(model: string, fields: string[], item: Record<string, unknown>): string | undefined {
  const parts: string[] = [model]
  for (const f of fields) {
    const v = item[f]
    if (v === undefined || v === null) return undefined
    parts.push(f, keyValue(f, v))
  }
  return parts.join('#')
}

/** Sort key shared by every GSI: creation time when known, else the id, so ranges read in insertion order. */
const sortKey = (item: Record<string, unknown>): string =>
  typeof item.createdAt === 'string' ? item.createdAt : String(item.id ?? '')

/** Every adapter-owned attribute for an item, recomputed on each write. */
export function internalAttrs(model: string, item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    pk: pkOf(model, item.id),
    _model: model,
    gsi3pk: model,
    gsi3sk: sortKey(item),
    // Cleared explicitly so an update that removes an indexed field also
    // removes it from the index rather than leaving a stale pointer.
    gsi1pk: undefined,
    gsi1sk: undefined,
    gsi2pk: undefined,
    gsi2sk: undefined,
    ttl: undefined,
  }
  const defs = INDEXES[model] ?? []
  defs.slice(0, 2).forEach((fields, i) => {
    const pk = indexPk(model, fields, item)
    if (pk) {
      out[`gsi${i + 1}pk`] = pk
      out[`gsi${i + 1}sk`] = sortKey(item)
    }
  })
  if (EXPIRING.has(model) && typeof item.expiresAt === 'string') {
    const t = Date.parse(item.expiresAt)
    if (Number.isFinite(t)) out.ttl = Math.floor(t / 1000) + 3600
  }
  return out
}

/** The uniqueness marker for a user's email. GSIs do not enforce uniqueness; this item does. */
export const emailMarkerPk = (email: unknown): string => `unique#user#email#${String(email).toLowerCase()}`
