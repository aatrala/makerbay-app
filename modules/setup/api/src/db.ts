import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { ddb } from '@makerbay/core'

/**
 * A setup job: the agent does the work, the owner approves it, and nothing
 * reaches a live surface until they do. See docs/spec-concierge.md.
 */

export type JobStatus =
  | 'scoping'      // reading their site, working out what it can do
  | 'quoted'       // scope card shown, waiting for them to accept the plan
  | 'working'      // running
  | 'ready'        // artifacts staged, waiting on review
  | 'revising'     // they asked for changes; unlimited, scope stays frozen
  | 'confirmed'    // applied
  | 'released'     // they said no. Nothing applied, nothing charged
  | 'needs_you'    // blocked on something only they can supply
  | 'needs_person' // third revision, or the agent is out of ideas. Free
  | 'failed'

/** Phase 1 ships one. The rest are in the spec's phase 2. */
export type JobKind = 'presence.page'

export interface JobPlan {
  /** Exactly what it will touch. Frozen at `quoted`, immutable after. */
  resources: string[]
  /** Fixed at scope time. A URL found inside scraped content is never followed. */
  sourceUrls: string[]
  steps: string[]
}

export interface JobRow {
  tenantId: string
  jobId: string
  kind: JobKind
  status: JobStatus
  plan: JobPlan
  /** Zero when the workspace is on a paid plan. Free tier pays per job. */
  priceCents: number
  scopes: string[]
  reviseCount: number
  createdBy: string
  createdAt: string
  updatedAt: string
  error?: string
}

export interface JobArtifact {
  pk: string
  sk: string
  jobId: string
  kind: 'presence.config'
  /** What the agent wants to write. */
  proposed: Record<string, unknown>
  /** What is there now, read at propose time, so the diff is against truth. */
  current: Record<string, unknown>
  /** Field-level, rendered by the review screen. Never model prose. */
  diff: Array<{ field: string; label: string; from: string; to: string }>
  /** The URL and the sentence each fact came from, so a human can check it. */
  provenance: Record<string, { url: string; excerpt: string }>
  status: 'staged' | 'applied' | 'rejected'
}

const JOBS = () => process.env.TABLE_SETUPJOBS!
const ARTIFACTS = () => process.env.TABLE_SETUPARTIFACTS!

export async function putJob(row: JobRow): Promise<void> {
  await ddb.send(new PutCommand({ TableName: JOBS(), Item: { ...row, updatedAt: new Date().toISOString() } }))
}

export async function getJob(tenantId: string, jobId: string): Promise<JobRow | undefined> {
  const r = await ddb.send(new GetCommand({ TableName: JOBS(), Key: { tenantId, jobId } }))
  return r.Item as JobRow | undefined
}

export async function listJobs(tenantId: string): Promise<JobRow[]> {
  const r = await ddb.send(new QueryCommand({
    TableName: JOBS(),
    KeyConditionExpression: 'tenantId = :t',
    ExpressionAttributeValues: { ':t': tenantId },
    ScanIndexForward: false,
    Limit: 20,
  }))
  return (r.Items ?? []) as JobRow[]
}

export async function putArtifact(a: JobArtifact): Promise<void> {
  await ddb.send(new PutCommand({ TableName: ARTIFACTS(), Item: a }))
}

export async function listArtifacts(tenantId: string, jobId: string): Promise<JobArtifact[]> {
  const r = await ddb.send(new QueryCommand({
    TableName: ARTIFACTS(),
    KeyConditionExpression: 'pk = :p',
    ExpressionAttributeValues: { ':p': `${tenantId}#${jobId}` },
  }))
  return (r.Items ?? []) as JobArtifact[]
}
