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

/**
 * One kind per menu line. Every kind runs the same machine: read, extract,
 * validate, stage a diff, wait for the owner. Adding one is a proposer and a
 * label, never a new pipeline - if a kind needs the machine changed, the
 * machine was wrong.
 */
export type JobKind =
  | 'presence.page'
  | 'booking.services'
  | 'assistant.knowledge'
  | 'help.centre'
  | 'quotes.documents'

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
  kind: JobKind
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

/**
 * Jobs and their artifacts share one table, keyed pk/sk. Two tables would be
 * tidier on paper; this stack sits close to CloudFormation's 500-resource
 * ceiling (issue 111), and a job and its artifacts are always read together
 * anyway.
 *
 *   job       pk = <tenantId>            sk = JOB#<jobId>
 *   artifact  pk = <tenantId>#<jobId>    sk = ARTIFACT#<kind>#<ulid>
 */
const TABLE = () => process.env.TABLE_SETUPJOBS!

export async function putJob(row: JobRow): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: TABLE(),
    Item: { ...row, pk: row.tenantId, sk: `JOB#${row.jobId}`, updatedAt: new Date().toISOString() },
  }))
}

export async function getJob(tenantId: string, jobId: string): Promise<JobRow | undefined> {
  const r = await ddb.send(new GetCommand({
    TableName: TABLE(),
    Key: { pk: tenantId, sk: `JOB#${jobId}` },
  }))
  return r.Item as JobRow | undefined
}

export async function listJobs(tenantId: string): Promise<JobRow[]> {
  const r = await ddb.send(new QueryCommand({
    TableName: TABLE(),
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': tenantId, ':s': 'JOB#' },
    ScanIndexForward: false,
    Limit: 20,
  }))
  return (r.Items ?? []) as JobRow[]
}

export async function putArtifact(a: JobArtifact): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE(), Item: a }))
}

export async function listArtifacts(tenantId: string, jobId: string): Promise<JobArtifact[]> {
  const r = await ddb.send(new QueryCommand({
    TableName: TABLE(),
    KeyConditionExpression: 'pk = :p',
    ExpressionAttributeValues: { ':p': `${tenantId}#${jobId}` },
  }))
  return (r.Items ?? []) as JobArtifact[]
}
