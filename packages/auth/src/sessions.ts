import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb'

/**
 * The two things core needs to know about a person's sessions without
 * knowing Better Auth (issue 158): end them all, and when they last began.
 *
 * Deliberately a separate module with no `better-auth` import, so the core
 * API can bundle it without the auth server. It knows the adapter's key
 * layout (packages/auth/src/adapter/keys.ts: sessions are indexed on gsi2
 * by `session#userId#<id>`) and nothing else.
 */
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
})
const TABLE = () => process.env.TABLE_AUTH!

async function sessionsOf(userId: string): Promise<Array<{ pk: string; createdAt?: string }>> {
  const out: Array<{ pk: string; createdAt?: string }> = []
  let ExclusiveStartKey: Record<string, unknown> | undefined
  do {
    const r = await client.send(new QueryCommand({
      TableName: TABLE(),
      IndexName: 'gsi2',
      KeyConditionExpression: 'gsi2pk = :p',
      ExpressionAttributeValues: { ':p': `session#userId#${userId}` },
      ExclusiveStartKey,
    }))
    out.push(...((r.Items ?? []) as Array<{ pk: string; createdAt?: string }>))
    ExclusiveStartKey = r.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (ExclusiveStartKey)
  return out
}

/**
 * Sign a person out everywhere. Their next request after the authorizer
 * cache and their access token expire (up to 20 minutes) is refused.
 * Returns how many sessions were ended.
 */
export async function revokeUserSessions(userId: string): Promise<number> {
  const rows = await sessionsOf(userId)
  for (let i = 0; i < rows.length; i += 25) {
    let batch = rows.slice(i, i + 25).map((r) => ({ DeleteRequest: { Key: { pk: r.pk } } }))
    while (batch.length) {
      const res = await client.send(new BatchWriteCommand({ RequestItems: { [TABLE()]: batch } }))
      batch = (res.UnprocessedItems?.[TABLE()] ?? []) as typeof batch
    }
  }
  return rows.length
}

/** ISO time of the newest session, or undefined if they have never signed in. */
export async function lastSignIn(userId: string): Promise<string | undefined> {
  const rows = await sessionsOf(userId)
  let best: string | undefined
  for (const r of rows) if (r.createdAt && (!best || r.createdAt > best)) best = r.createdAt
  return best
}
