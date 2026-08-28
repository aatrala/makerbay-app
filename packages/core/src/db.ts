import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import type { ApiKeyRow, Entitlements, ModuleEntitlement, TenantRow, UserRow } from './types'

/** Shared document client. Module data access must stay tenant-scoped. */
export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
})

const Tables = {
  tenants: () => process.env.TABLE_TENANTS!,
  users: () => process.env.TABLE_USERS!,
  apiKeys: () => process.env.TABLE_APIKEYS!,
  entitlements: () => process.env.TABLE_ENTITLEMENTS!,
  usage: () => process.env.TABLE_USAGE!,
}

// ── Users ────────────────────────────────────────────────────────────────

export async function getUser(userId: string): Promise<UserRow | undefined> {
  const r = await ddb.send(new GetCommand({ TableName: Tables.users(), Key: { userId } }))
  return r.Item as UserRow | undefined
}

// ── Tenants ──────────────────────────────────────────────────────────────

export async function getTenant(tenantId: string): Promise<TenantRow | undefined> {
  const r = await ddb.send(new GetCommand({ TableName: Tables.tenants(), Key: { tenantId } }))
  return r.Item as TenantRow | undefined
}

export async function getTenantBySlug(slug: string): Promise<TenantRow | undefined> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.tenants(),
      IndexName: 'bySlug',
      KeyConditionExpression: 'slug = :s',
      ExpressionAttributeValues: { ':s': slug },
      Limit: 1,
    }),
  )
  const tenant = r.Items?.[0] as TenantRow | undefined
  // Every public surface (chat, booking, quote links, help centre) resolves
  // its tenant here, so a suspension takes them all down in one place. The
  // dashboard is denied separately, in the authorizer.
  if (tenant?.status === 'suspended') return undefined
  return tenant
}

// ── Slug aliases ─────────────────────────────────────────────────────────
// Extra public addresses that 301 to the primary slug. One row per alias,
// keyed by the alias itself so claiming is a conditional put - the same
// uniqueness guarantee the primary slug gets from its GSI.

export interface SlugAliasRow {
  slug: string
  tenantId: string
  createdAt: string
}

const aliasTable = () => process.env.TABLE_SLUGALIASES!

/**
 * A tenant by any address it has ever had (issue 118).
 *
 * Every public surface that resolves a customer link must use this rather than
 * getTenantBySlug. Renaming a workspace changes the primary slug, and five
 * modules independently looked up the primary only - so a rename silently 404d
 * every quote, invoice, booking-cancel and review link already sitting in a
 * customer's messages. An invoice link is a payment instrument people dig out
 * months later; there is no date at which breaking one is acceptable.
 *
 * Serves under the old address rather than redirecting. Presence 301s because
 * it is canonicalising a page it wants indexed; a document link is noindex,
 * has nothing to canonicalise, and a redirect is one more hop inside a
 * link-preview crawler's short timeout.
 */
export async function getTenantBySlugOrAlias(slug: string): Promise<TenantRow | undefined> {
  const direct = await getTenantBySlug(slug)
  if (direct) return direct
  const alias = await getSlugAlias(slug)
  if (!alias) return undefined
  const tenant = await getTenant(alias.tenantId)
  // The suspension check getTenantBySlug applies has to apply here too, or an
  // alias becomes a way around it.
  return tenant?.status === 'suspended' ? undefined : tenant
}

export async function getSlugAlias(slug: string): Promise<SlugAliasRow | undefined> {
  const r = await ddb.send(new GetCommand({ TableName: aliasTable(), Key: { slug } }))
  return r.Item as SlugAliasRow | undefined
}

export async function listSlugAliases(tenantId: string): Promise<SlugAliasRow[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: aliasTable(),
      IndexName: 'byTenant',
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': tenantId },
    }),
  )
  return (r.Items ?? []) as SlugAliasRow[]
}

/** Claims atomically; throws ConditionalCheckFailedException when taken. */
export async function claimSlugAlias(slug: string, tenantId: string): Promise<SlugAliasRow> {
  const row: SlugAliasRow = { slug, tenantId, createdAt: new Date().toISOString() }
  await ddb.send(
    new PutCommand({
      TableName: aliasTable(),
      Item: row,
      ConditionExpression: 'attribute_not_exists(slug)',
    }),
  )
  return row
}

export async function releaseSlugAlias(slug: string, tenantId: string): Promise<void> {
  await ddb.send(
    new DeleteCommand({
      TableName: aliasTable(),
      Key: { slug },
      // Only the owner releases their alias - never someone else's.
      ConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': tenantId },
    }),
  )
}

/** The abuse kill switch. Staff-console only; every call is audited there. */
export async function setTenantStatus(
  tenantId: string,
  status: TenantRow['status'],
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: Tables.tenants(),
      Key: { tenantId },
      UpdateExpression: 'SET #s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status },
      ConditionExpression: 'attribute_exists(tenantId)',
    }),
  )
}

/** Every ticket arrives as an email address; this turns one into a user. */
export async function findUserByEmail(email: string): Promise<UserRow | undefined> {
  const r = await ddb.send(
    new ScanCommand({
      TableName: Tables.users(),
      FilterExpression: 'email = :e',
      ExpressionAttributeValues: { ':e': email.trim().toLowerCase() },
    }),
  )
  return (r.Items ?? [])[0] as UserRow | undefined
}

export async function listTenantUsers(tenantId: string): Promise<UserRow[]> {
  const r = await ddb.send(
    new ScanCommand({
      TableName: Tables.users(),
      FilterExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': tenantId },
    }),
  )
  return (r.Items ?? []) as UserRow[]
}

/**
 * Rename a workspace's public address. The bySlug index follows the
 * attribute, so old links die the moment this lands - the caller owns
 * warning the user about that.
 */
export async function updateTenantSlug(tenantId: string, slug: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: Tables.tenants(),
      Key: { tenantId },
      UpdateExpression: 'SET slug = :s',
      ExpressionAttributeValues: { ':s': slug },
      ConditionExpression: 'attribute_exists(tenantId)',
    }),
  )
}

export async function updateTenantName(tenantId: string, name: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: Tables.tenants(),
      Key: { tenantId },
      UpdateExpression: 'SET #n = :n',
      ExpressionAttributeNames: { '#n': 'name' },
      ExpressionAttributeValues: { ':n': name },
      ConditionExpression: 'attribute_exists(tenantId)',
    }),
  )
}

export async function createTenant(tenant: TenantRow, owner: UserRow): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: Tables.tenants(),
      Item: tenant,
      ConditionExpression: 'attribute_not_exists(tenantId)',
    }),
  )
  await ddb.send(new PutCommand({ TableName: Tables.users(), Item: owner }))
  await ddb.send(
    new PutCommand({
      TableName: Tables.entitlements(),
      Item: { tenantId: tenant.tenantId, modules: {} },
    }),
  )
}

type BillingFields = Pick<
  TenantRow,
  | 'plan'
  | 'stripeCustomerId'
  | 'stripeSubscriptionId'
  | 'stripeMeteredItemId'
  | 'subscriptionStatus'
  | 'currentPeriodEnd'
  | 'lastWebhookAt'
  | 'lastWebhookType'
  | 'lastWebhookLive'
>

export async function setTenantBilling(
  tenantId: string,
  fields: Partial<BillingFields>,
): Promise<void> {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return
  await ddb.send(
    new UpdateCommand({
      TableName: Tables.tenants(),
      Key: { tenantId },
      UpdateExpression: `SET ${entries.map((_, i) => `#k${i} = :v${i}`).join(', ')}`,
      ExpressionAttributeNames: Object.fromEntries(entries.map(([k], i) => [`#k${i}`, k])),
      ExpressionAttributeValues: Object.fromEntries(entries.map(([, v], i) => [`:v${i}`, v])),
      ConditionExpression: 'attribute_exists(tenantId)',
    }),
  )
}

type ConnectFields = Pick<TenantRow, 'stripeAccountId' | 'payoutsEnabled' | 'connectOnboardedAt'>

/** Stripe Connect state. Written only by the payments module. */
export async function setTenantConnect(
  tenantId: string,
  fields: Partial<ConnectFields>,
): Promise<void> {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return
  await ddb.send(
    new UpdateCommand({
      TableName: Tables.tenants(),
      Key: { tenantId },
      UpdateExpression: `SET ${entries.map(([, ], i) => `#k${i} = :v${i}`).join(', ')}`,
      ExpressionAttributeNames: Object.fromEntries(entries.map(([k], i) => [`#k${i}`, k])),
      ExpressionAttributeValues: Object.fromEntries(entries.map(([, v], i) => [`:v${i}`, v])),
      ConditionExpression: 'attribute_exists(tenantId)',
    }),
  )
}

/** The tenant owning a Stripe Connect account - webhook events arrive keyed by account id. */
export async function getTenantByStripeAccount(accountId: string): Promise<TenantRow | undefined> {
  const r = await ddb.send(
    new ScanCommand({
      TableName: Tables.tenants(),
      FilterExpression: 'stripeAccountId = :a',
      ExpressionAttributeValues: { ':a': accountId },
    }),
  )
  return (r.Items ?? [])[0] as TenantRow | undefined
}

/** Tenants with a Stripe subscription — the daily metered-usage report set. */
export async function listBillableTenants(): Promise<TenantRow[]> {
  const r = await ddb.send(
    new ScanCommand({
      TableName: Tables.tenants(),
      FilterExpression: 'attribute_exists(stripeSubscriptionId)',
    }),
  )
  return (r.Items ?? []) as TenantRow[]
}

// ── Entitlements ─────────────────────────────────────────────────────────

export async function getEntitlements(tenantId: string): Promise<Entitlements> {
  const r = await ddb.send(
    new GetCommand({ TableName: Tables.entitlements(), Key: { tenantId } }),
  )
  return { modules: (r.Item?.modules as Entitlements['modules']) ?? {} }
}

export async function setModuleEntitlement(
  tenantId: string,
  moduleId: string,
  entitlement: ModuleEntitlement,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: Tables.entitlements(),
      Key: { tenantId },
      UpdateExpression: 'SET modules.#m = :e',
      ExpressionAttributeNames: { '#m': moduleId },
      ExpressionAttributeValues: { ':e': entitlement },
    }),
  )
}

// ── API keys ─────────────────────────────────────────────────────────────

export async function putApiKey(row: ApiKeyRow): Promise<void> {
  await ddb.send(new PutCommand({ TableName: Tables.apiKeys(), Item: row }))
}

export async function listApiKeys(tenantId: string): Promise<ApiKeyRow[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.apiKeys(),
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': tenantId },
    }),
  )
  return (r.Items ?? []) as ApiKeyRow[]
}

export async function deleteApiKey(tenantId: string, keyId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: Tables.apiKeys(), Key: { tenantId, keyId } }))
}

export async function findApiKeyByHash(keyHash: string): Promise<ApiKeyRow | undefined> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.apiKeys(),
      IndexName: 'byHash',
      KeyConditionExpression: 'keyHash = :h',
      ExpressionAttributeValues: { ':h': keyHash },
      Limit: 1,
    }),
  )
  return r.Items?.[0] as ApiKeyRow | undefined
}

// ── Usage ────────────────────────────────────────────────────────────────

export async function getMonthUsage(
  tenantId: string,
  yyyymm: string,
): Promise<Record<string, number>> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.usage(),
      KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': `${tenantId}#${yyyymm}` },
    }),
  )
  const totals: Record<string, number> = {}
  for (const item of r.Items ?? []) {
    const [moduleId, metric] = (item.sk as string).split('#')
    const key = `${moduleId}.${metric}`
    totals[key] = (totals[key] ?? 0) + Number(item.quantity ?? 0)
  }
  return totals
}

/** Quantity recorded for one metric on one calendar day. */
export async function getDayUsage(
  tenantId: string,
  moduleId: string,
  metric: string,
  date: string, // yyyy-mm-dd
): Promise<number> {
  const [yyyy, mm, dd] = date.split('-')
  const r = await ddb.send(
    new GetCommand({
      TableName: Tables.usage(),
      Key: { pk: `${tenantId}#${yyyy}-${mm}`, sk: `${moduleId}#${metric}#${dd}` },
    }),
  )
  return Number(r.Item?.quantity ?? 0)
}

export async function addUsage(
  tenantId: string,
  moduleId: string,
  metric: string,
  quantity: number,
  date: string, // yyyy-mm-dd
  idempotencyKey?: string,
): Promise<void> {
  const [yyyy, mm, dd] = date.split('-')
  // EventBridge delivers at least once, so the same usage event can arrive
  // twice. `ADD quantity` is not idempotent, and this counter is read by the
  // plan-limit checks AND reported to Stripe as metered usage - a duplicate
  // delivery overbills a real customer. Claim the key first; if someone
  // already has it, this delivery is a repeat and must not count.
  //
  // The marker lives under its own partition so getMonthUsage, which sums
  // every item under the counter partition, never sees it.
  if (idempotencyKey) {
    try {
      await ddb.send(
        new PutCommand({
          TableName: Tables.usage(),
          Item: {
            pk: `${tenantId}#dedupe#${yyyy}-${mm}`,
            sk: idempotencyKey,
            // Retries land within minutes; a week is generous and bounded.
            expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
          },
          ConditionExpression: 'attribute_not_exists(sk)',
        }),
      )
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return
      throw err
    }
  }
  await ddb.send(
    new UpdateCommand({
      TableName: Tables.usage(),
      Key: { pk: `${tenantId}#${yyyy}-${mm}`, sk: `${moduleId}#${metric}#${dd}` },
      UpdateExpression: 'ADD quantity :q',
      ExpressionAttributeValues: { ':q': quantity },
    }),
  )
}

/** Remove all Stripe linkage and return the tenant to the free plan. */
export async function clearTenantBilling(tenantId: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: Tables.tenants(),
      Key: { tenantId },
      UpdateExpression:
        'REMOVE stripeCustomerId, stripeSubscriptionId, stripeMeteredItemId, subscriptionStatus, currentPeriodEnd SET #p = :free',
      ExpressionAttributeNames: { '#p': 'plan' },
      ExpressionAttributeValues: { ':free': 'free' },
      ConditionExpression: 'attribute_exists(tenantId)',
    }),
  )
}
