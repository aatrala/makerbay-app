import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { ddb } from '@makerbay/core'

const Tables = {
  requests: () => process.env.TABLE_REQUESTS!,
  config: () => process.env.TABLE_REQUESTSCONFIG!,
}

export type RequestKind = 'handoff' | 'lead' | 'feedback' | 'missedcall'
export type RequestStatus = 'new' | 'open' | 'closed'

export interface RequestReply {
  at: string
  byUserId?: string
  text: string
  emailed: boolean
  emailError?: string
}

export interface RequestRow {
  tenantId: string
  requestId: string
  kind: RequestKind
  status: RequestStatus
  contactId: string
  name?: string
  email?: string
  phone?: string
  subject: string
  message: string
  sessionId?: string
  /** The last few turns of the conversation, so the owner has context. */
  transcript?: Array<{ role: string; text: string }>
  replies?: RequestReply[]
  source: 'widget' | 'hosted' | 'api' | 'rescue'
  /** Set when the owner's notification could not be delivered. */
  notifyError?: string
  createdAt: string
  updatedAt: string
  closedAt?: string
}

export interface RequestsConfigRow {
  tenantId: string
  /** Where owner notifications go. Falls back to the workspace owner's email. */
  notifyEmail: string
  /** Offered by the assistant when it cannot answer. */
  handoffEnabled: boolean
  handoffPrompt: string
  /** Every extra field costs completions, so this is deliberately short. */
  collectPhone: boolean
  autoReply: string
}

export const DEFAULT_REQUESTS_CONFIG: Omit<RequestsConfigRow, 'tenantId'> = {
  notifyEmail: '',
  handoffEnabled: true,
  handoffPrompt: "I couldn't find that in our documents. Would you like someone to get back to you?",
  collectPhone: false,
  autoReply: "Thanks — we've got your message and will come back to you shortly.",
}

export async function getRequestsConfig(tenantId: string): Promise<RequestsConfigRow> {
  const r = await ddb.send(new GetCommand({ TableName: Tables.config(), Key: { tenantId } }))
  return { tenantId, ...DEFAULT_REQUESTS_CONFIG, ...(r.Item ?? {}) } as RequestsConfigRow
}

export async function putRequestsConfig(row: RequestsConfigRow): Promise<void> {
  await ddb.send(new PutCommand({ TableName: Tables.config(), Item: row }))
}

export async function putRequest(row: RequestRow): Promise<void> {
  await ddb.send(new PutCommand({ TableName: Tables.requests(), Item: row }))
}

export async function getRequest(tenantId: string, requestId: string): Promise<RequestRow | undefined> {
  const r = await ddb.send(
    new GetCommand({ TableName: Tables.requests(), Key: { tenantId, requestId } }),
  )
  return r.Item as RequestRow | undefined
}

export async function listRequests(
  tenantId: string,
  opts: { status?: RequestStatus; kind?: RequestKind; limit?: number } = {},
): Promise<RequestRow[]> {
  const filters: string[] = []
  const values: Record<string, unknown> = { ':t': tenantId }
  const names: Record<string, string> = {}
  if (opts.status) {
    filters.push('#st = :st')
    names['#st'] = 'status'
    values[':st'] = opts.status
  }
  if (opts.kind) {
    filters.push('kind = :k')
    values[':k'] = opts.kind
  }
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.requests(),
      KeyConditionExpression: 'tenantId = :t',
      ...(filters.length ? { FilterExpression: filters.join(' AND ') } : {}),
      ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
      ExpressionAttributeValues: values,
      // requestId is a ULID, so descending is newest first.
      ScanIndexForward: false,
      Limit: Math.min(opts.limit ?? 100, 200),
    }),
  )
  return (r.Items ?? []) as RequestRow[]
}

/** Month-to-date count, for the free-plan cap. */
export async function countRequestsThisMonth(tenantId: string): Promise<number> {
  const monthStart = new Date().toISOString().slice(0, 7)
  const rows = await listRequests(tenantId, { limit: 200 })
  return rows.filter((r) => r.createdAt.startsWith(monthStart)).length
}
