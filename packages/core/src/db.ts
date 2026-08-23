import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
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
