import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { ddb, type CallerContext } from '@makerbay/core'

/**
 * Pending actions: an agent proposes, a human confirms, and only then does
 * anything happen.
 *
 * Generalised from Genie's version, with the fix from issue 97 built in
 * rather than bolted on: an action records **who proposed it**, and only a
 * signed-in human can confirm. Without that, any valid token for the tenant
 * could confirm any card, so the moment a second principal exists in a
 * workspace - a setup delegation, an integration key - it could approve its
 * own work and the card would be decoration.
 */

export interface PendingAction {
  pk: string
  sk: 'action'
  tenantId: string
  /** Groups the actions of one job so they confirm together, not eight times. */
  groupId?: string
  sessionId: string
  actionId: string
  tool: string
  params: Record<string, string>
  summary: string
  status: 'proposed' | 'executed' | 'declined'
  proposedBy: string
  proposedByKind: 'user' | 'apikey'
  createdAt: string
  expiresAt: number
  receipt?: string
}

export const principal = (ctx: CallerContext): { id: string; kind: 'user' | 'apikey' } =>
  ctx.userId ? { id: ctx.userId, kind: 'user' } : { id: ctx.keyId ?? 'unknown', kind: 'apikey' }

/**
 * Genie's cards expire in ten minutes on purpose: a stale confirmation in a
 * chat is worse than asking again. A setup job is different - the owner will
 * look at it tomorrow morning - so callers pass their own lifetime and the
 * preview is recomputed when the review screen opens.
 */
export const CHAT_ACTION_TTL_SECONDS = 600
export const JOB_ACTION_TTL_SECONDS = 48 * 60 * 60

export function newAction(input: {
  tenantId: string
  sessionId: string
  actionId: string
  tool: string
  proposed: { summary: string; params: Record<string, string> }
  by: { id: string; kind: 'user' | 'apikey' }
  ttlSeconds: number
  groupId?: string
}): PendingAction {
  return {
    pk: `${input.tenantId}#action#${input.actionId}`,
    sk: 'action',
    tenantId: input.tenantId,
    groupId: input.groupId,
    sessionId: input.sessionId,
    actionId: input.actionId,
    tool: input.tool,
    params: input.proposed.params,
    summary: input.proposed.summary,
    status: 'proposed',
    proposedBy: input.by.id,
    proposedByKind: input.by.kind,
    createdAt: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + input.ttlSeconds,
  }
}

export async function getAction(
  table: string,
  tenantId: string,
  actionId: string,
): Promise<PendingAction | undefined> {
  const r = await ddb.send(new GetCommand({
    TableName: table,
    Key: { pk: `${tenantId}#action#${actionId}`, sk: 'action' },
  }))
  return r.Item as PendingAction | undefined
}

export async function putAction(table: string, row: PendingAction): Promise<void> {
  await ddb.send(new PutCommand({ TableName: table, Item: row }))
}

export type ConfirmRefusal =
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'expired' }
  | { ok: false; reason: 'requires_a_person' }

/**
 * Everything that must be true before an action may execute, in one place so
 * no caller can forget half of it.
 */
export function mayConfirm(
  action: PendingAction | undefined,
  ctx: CallerContext,
  now = Date.now(),
): { ok: true; who: { id: string; kind: 'user' | 'apikey' } } | ConfirmRefusal {
  if (!action || action.status !== 'proposed') return { ok: false, reason: 'not_found' }
  if (action.expiresAt * 1000 < now) return { ok: false, reason: 'expired' }
  const who = principal(ctx)
  // A key of any kind may propose all it likes and may never approve its own
  // work. This single check is what makes the card a control.
  if (who.kind !== 'user') return { ok: false, reason: 'requires_a_person' }
  if (action.proposedByKind !== 'user' && action.proposedBy === who.id) {
    return { ok: false, reason: 'requires_a_person' }
  }
  return { ok: true, who }
}
