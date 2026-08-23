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
  return r.Items?.[0] as TenantRow | undefined
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
      UpdateExpression: `SET ${entries.map(([k], i) => `#k${i} = :v${i}`).join(', ')}`,
      ExpressionAttributeNames: Object.fromEntries(entries.map(([k], i) => [`#k${i}`, k])),
      ExpressionAttributeValues: Object.fromEntries(entries.map(([, v], i) => [`:v${i}`, v])),
      ConditionExpression: 'attribute_exists(tenantId)',
    }),
  )
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
): Promise<void> {
  const [yyyy, mm, dd] = date.split('-')
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
