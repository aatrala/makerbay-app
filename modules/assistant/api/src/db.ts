import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { ddb } from '@makerbay/core'

const Tables = {
  sources: () => process.env.TABLE_SOURCES!,
  conversations: () => process.env.TABLE_CONVERSATIONS!,
  config: () => process.env.TABLE_ASSISTANT_CONFIG!,
}

export interface SourceRow {
  tenantId: string
  sourceId: string
  name: string
  type: 'file' | 'text' | 'url'
  s3Key: string
  status: 'awaiting_upload' | 'processing' | 'ready' | 'failed'
  sizeBytes?: number
  ingestionJobId?: string
  /** url sources: the page fetched, when, and how much text it yielded. */
  sourceUrl?: string
  fetchedAt?: string
  charCount?: number
  warning?: string
  createdAt: string
  updatedAt: string
}

export interface MessageRow {
  pk: string // tenantId#sessionId
  sk: string // sortable timestamp id
  tenantId: string // byTenant GSI partition key
  sessionId: string
  role: 'user' | 'assistant'
  text: string
  citations?: Array<{ sourceId: string; name: string; excerpt: string }>
  fallback?: boolean
  feedback?: 'up' | 'down'
}

export interface AssistantConfigRow {
  tenantId: string
  name: string
  greeting: string
  instructions: string
  fallbackMessage: string
  brandColor: string
}

export const DEFAULT_CONFIG: Omit<AssistantConfigRow, 'tenantId'> = {
  name: 'Assistant',
  greeting: 'Hi! Ask me anything about our docs.',
  instructions: '',
  fallbackMessage: "I don't have that information yet. Please contact the team directly.",
  brandColor: '#1a73e8',
}

// ── Sources ──────────────────────────────────────────────────────────────

export async function putSource(row: SourceRow): Promise<void> {
  await ddb.send(new PutCommand({ TableName: Tables.sources(), Item: row }))
}

export async function getSource(tenantId: string, sourceId: string): Promise<SourceRow | undefined> {
  const r = await ddb.send(
    new GetCommand({ TableName: Tables.sources(), Key: { tenantId, sourceId } }),
  )
  return r.Item as SourceRow | undefined
}

export async function listSources(tenantId: string): Promise<SourceRow[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.sources(),
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': tenantId },
    }),
  )
  return (r.Items ?? []) as SourceRow[]
}

export async function updateSourceStatus(
  tenantId: string,
  sourceId: string,
  status: SourceRow['status'],
  ingestionJobId?: string,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: Tables.sources(),
      Key: { tenantId, sourceId },
      UpdateExpression: 'SET #s = :s, updatedAt = :u' + (ingestionJobId ? ', ingestionJobId = :j' : ''),
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s': status,
        ':u': new Date().toISOString(),
        ...(ingestionJobId ? { ':j': ingestionJobId } : {}),
      },
    }),
  )
}

export async function deleteSource(tenantId: string, sourceId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: Tables.sources(), Key: { tenantId, sourceId } }))
}

// ── Conversations ────────────────────────────────────────────────────────

export async function putMessage(row: MessageRow): Promise<void> {
  await ddb.send(new PutCommand({ TableName: Tables.conversations(), Item: row }))
}

export async function getSessionMessages(
  tenantId: string,
  sessionId: string,
  limit = 20,
): Promise<MessageRow[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.conversations(),
      KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': `${tenantId}#${sessionId}` },
      ScanIndexForward: false,
      Limit: limit,
    }),
  )
  return ((r.Items ?? []) as MessageRow[]).reverse()
}

/**
 * Recent messages across every session for a tenant, newest first. Bounded:
 * the inbox and insights summarise a recent window, not all history. When
 * tenants outgrow this, move session summaries into their own table.
 */
export async function listRecentMessages(tenantId: string, limit = 400): Promise<MessageRow[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.conversations(),
      IndexName: 'byTenant',
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': tenantId },
      ScanIndexForward: false,
      Limit: limit,
    }),
  )
  return (r.Items ?? []) as MessageRow[]
}

export async function setMessageFeedback(
  tenantId: string,
  sessionId: string,
  sk: string,
  feedback: 'up' | 'down',
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: Tables.conversations(),
      Key: { pk: `${tenantId}#${sessionId}`, sk },
      UpdateExpression: 'SET feedback = :f',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':f': feedback },
    }),
  )
}

// ── Config ───────────────────────────────────────────────────────────────

export async function getConfig(tenantId: string): Promise<AssistantConfigRow> {
  const r = await ddb.send(new GetCommand({ TableName: Tables.config(), Key: { tenantId } }))
  return { tenantId, ...DEFAULT_CONFIG, ...(r.Item ?? {}) } as AssistantConfigRow
}

export async function putConfig(row: AssistantConfigRow): Promise<void> {
  await ddb.send(new PutCommand({ TableName: Tables.config(), Item: row }))
}
