import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { ddb, getEntitlements, getTenant, listTenantUsers } from './db'
import { listGrants } from './entitlements'
import { ulid } from './ids'
import type { InvitationRow, TenantRow, UserRow } from './types'

/**
 * People in a workspace (issue 158, docs/spec-auth-phase2.md).
 *
 * Membership is a Users row - it always was, and the authorizer reads it on
 * every request. What this file adds is the writes that were missing (a
 * second person, a removal, a role) and the invitation that gets someone
 * there. Identity - who a person is, how they sign in - stays with Better
 * Auth; this is only who belongs where.
 *
 * Every transition is one conditional write. That is the whole reason
 * membership is here rather than mirrored from an auth-side model: there is
 * nothing to fall out of step.
 */

const USERS = () => process.env.TABLE_USERS!
const INVITATIONS = () => process.env.TABLE_INVITATIONS!

// ── Tiers and seats ──────────────────────────────────────────────────────

export type WorkspaceTier = 'free' | 'trade' | 'genie'

/**
 * Which tier a workspace is on, from grants and entitlements. The same
 * reading the alias allowance uses; shared so the two can never disagree
 * about what "Trade" means.
 */
export async function workspaceTier(tenantId: string): Promise<WorkspaceTier> {
  const [grants, entitlements] = await Promise.all([listGrants(tenantId), getEntitlements(tenantId)])
  const now = new Date().toISOString()
  const live = grants.filter((g) => g.status === 'active' && (!g.expiresAt || g.expiresAt > now))
  const genie = entitlements.modules.genie?.enabled === true || live.some((g) => g.moduleId === 'genie')
  if (genie) return 'genie'
  const trade =
    entitlements.modules.assistant?.plan === 'pro'
    || live.some((g) => g.moduleId === 'assistant' && g.planTier === 'pro')
  return trade ? 'trade' : 'free'
}

/**
 * People per tier, the owner included. Free carries two on purpose: a sole
 * trader and their partner is a household, not a firm, and "you cannot add
 * your wife" is the wrong first paywall for a tier that must not feel
 * paywalled on basics. Bundled, never per seat.
 */
export const SEATS: Record<WorkspaceTier, number> = { free: 2, trade: 3, genie: 10 }

/** Pending invitations per workspace, whatever the tier. */
export const MAX_PENDING_INVITATIONS = 10

/** What the wall says, in the owner's words. The same sentence is on the pricing and billing pages. */
export function seatWall(tier: WorkspaceTier): string {
  if (tier === 'free') return 'Free includes two people. Trade lets you add up to three, from $29 a month.'
  if (tier === 'trade') return 'Trade includes three people. The Genie tier includes ten.'
  return 'This workspace already has the ten people the Genie tier includes.'
}

// ── Users ────────────────────────────────────────────────────────────────

/** Add a person. Refuses if they already belong anywhere: one workspace per person. */
export async function addUser(row: UserRow): Promise<'added' | 'exists'> {
  try {
    await ddb.send(new PutCommand({
      TableName: USERS(),
      Item: row,
      ConditionExpression: 'attribute_not_exists(userId)',
    }))
    return 'added'
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return 'exists'
    throw err
  }
}

export async function removeUser(userId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: USERS(), Key: { userId } }))
}

export async function updateUser(
  userId: string,
  patch: { role?: UserRow['role']; notify?: boolean },
): Promise<void> {
  const sets: string[] = []
  const names: Record<string, string> = {}
  const values: Record<string, unknown> = {}
  // Every name aliased, reserved or not - the rule since issue 107's `at`.
  if (patch.role !== undefined) { sets.push('#role = :role'); names['#role'] = 'role'; values[':role'] = patch.role }
  if (patch.notify !== undefined) { sets.push('#notify = :notify'); names['#notify'] = 'notify'; values[':notify'] = patch.notify }
  if (!sets.length) return
  await ddb.send(new UpdateCommand({
    TableName: USERS(),
    Key: { userId },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ConditionExpression: 'attribute_exists(userId)',
  }))
}

/**
 * Who gets the workspace's notifications: everyone with notify on, plus the
 * module's own configured address when it has one (the booking module keeps
 * a notifyEmail of its own). De-duplicated, lowercased, never empty when the
 * workspace has an owner with an email.
 */
export async function notificationRecipients(tenantId: string, preferred?: string): Promise<string[]> {
  const users = await listTenantUsers(tenantId)
  const out = new Set<string>()
  const p = (preferred ?? '').trim().toLowerCase()
  if (p.includes('@')) out.add(p)
  for (const u of users) {
    if (u.notify === false) continue
    const e = (u.email ?? '').trim().toLowerCase()
    if (e.includes('@')) out.add(e)
  }
  return [...out]
}

// ── Invitations ──────────────────────────────────────────────────────────

export const INVITATION_DAYS = 7

export async function createInvitation(input: {
  tenantId: string
  email: string
  role: UserRow['role']
  inviterId: string
  inviterEmail?: string
}): Promise<InvitationRow> {
  const now = new Date()
  const expires = new Date(now.getTime() + INVITATION_DAYS * 24 * 60 * 60 * 1000)
  const row: InvitationRow = {
    tenantId: input.tenantId,
    invitationId: ulid(),
    email: input.email.trim().toLowerCase(),
    role: input.role,
    inviterId: input.inviterId,
    inviterEmail: input.inviterEmail,
    status: 'pending',
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    // An hour after expiry, so a row is never removed while it still reads as live.
    ttl: Math.floor(expires.getTime() / 1000) + 3600,
  }
  await ddb.send(new PutCommand({ TableName: INVITATIONS(), Item: row }))
  return row
}

export async function getInvitation(tenantId: string, invitationId: string): Promise<InvitationRow | undefined> {
  const r = await ddb.send(new GetCommand({ TableName: INVITATIONS(), Key: { tenantId, invitationId } }))
  return r.Item as InvitationRow | undefined
}

const live = (rows: InvitationRow[], now = new Date().toISOString()) =>
  rows.filter((i) => i.status === 'pending' && i.expiresAt > now)

/** Open invitations for a workspace. */
export async function listTenantInvitations(tenantId: string): Promise<InvitationRow[]> {
  const r = await ddb.send(new QueryCommand({
    TableName: INVITATIONS(),
    KeyConditionExpression: 'tenantId = :t',
    ExpressionAttributeValues: { ':t': tenantId },
  }))
  return live((r.Items ?? []) as InvitationRow[])
}

/** Open invitations waiting for an address, whichever workspaces sent them. */
export async function listInvitationsForEmail(email: string): Promise<InvitationRow[]> {
  const e = email.trim().toLowerCase()
  if (!e.includes('@')) return []
  const r = await ddb.send(new QueryCommand({
    TableName: INVITATIONS(),
    IndexName: 'byEmail',
    KeyConditionExpression: 'email = :e',
    ExpressionAttributeValues: { ':e': e },
  }))
  return live((r.Items ?? []) as InvitationRow[])
}

/** Move a pending invitation to its final state. False if it was no longer pending. */
export async function settleInvitation(
  tenantId: string,
  invitationId: string,
  status: Exclude<InvitationRow['status'], 'pending'>,
): Promise<boolean> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: INVITATIONS(),
      Key: { tenantId, invitationId },
      UpdateExpression: 'SET #s = :s',
      ConditionExpression: '#s = :pending',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status, ':pending': 'pending' },
    }))
    return true
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false
    throw err
  }
}

/** Re-issue the same invitation with a fresh week, so a resend is not a second invitation. */
export async function extendInvitation(tenantId: string, invitationId: string): Promise<InvitationRow | undefined> {
  const expires = new Date(Date.now() + INVITATION_DAYS * 24 * 60 * 60 * 1000)
  try {
    const r = await ddb.send(new UpdateCommand({
      TableName: INVITATIONS(),
      Key: { tenantId, invitationId },
      UpdateExpression: 'SET #e = :e, #ttl = :ttl',
      ConditionExpression: '#s = :pending',
      ExpressionAttributeNames: { '#e': 'expiresAt', '#ttl': 'ttl', '#s': 'status' },
      ExpressionAttributeValues: {
        ':e': expires.toISOString(),
        ':ttl': Math.floor(expires.getTime() / 1000) + 3600,
        ':pending': 'pending',
      },
      ReturnValues: 'ALL_NEW',
    }))
    return r.Attributes as InvitationRow | undefined
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return undefined
    throw err
  }
}

// ── Workspace emptiness ──────────────────────────────────────────────────

/**
 * "Empty" for the purpose of letting an invitee close a workspace they made
 * and forgot: free, never billed, and no customer in it. Anything else and
 * closing it is a decision they make deliberately under Settings.
 */
export async function isEmptyWorkspace(tenant: TenantRow | undefined): Promise<boolean> {
  if (!tenant) return true
  if (tenant.plan !== 'free' || tenant.stripeCustomerId) return false
  const r = await ddb.send(new QueryCommand({
    TableName: process.env.TABLE_CONTACTS!,
    KeyConditionExpression: 'tenantId = :t',
    ExpressionAttributeValues: { ':t': tenant.tenantId },
    Limit: 1,
  }))
  return (r.Count ?? 0) === 0
}

/** The tenant a person belongs to, or undefined. */
export async function workspaceOf(userId: string): Promise<TenantRow | undefined> {
  const r = await ddb.send(new GetCommand({ TableName: USERS(), Key: { userId } }))
  const row = r.Item as UserRow | undefined
  return row ? getTenant(row.tenantId) : undefined
}
