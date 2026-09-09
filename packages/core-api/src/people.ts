import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { lastSignIn, revokeUserSessions } from '@makerbay/auth/sessions'
import { invitation as invitationMail, removed as removedMail } from '@makerbay/email'
import {
  addUser,
  createInvitation,
  extendInvitation,
  getInvitation,
  getTenant,
  getUser,
  isEmptyWorkspace,
  json,
  listInvitationsForEmail,
  listTenantInvitations,
  listTenantUsers,
  MAX_PENDING_INVITATIONS,
  recordAudit,
  removeUser,
  SEATS,
  seatWall,
  sendEmail,
  setTenantStatus,
  settleInvitation,
  updateUser,
  workspaceTier,
  type CallerContext,
  type InvitationRow,
  type TenantRow,
  type UserRow,
} from '@makerbay/core'

/**
 * People in a workspace (issue 158, docs/spec-auth-phase2.md).
 *
 * Owners invite, remove and change roles; anyone signed in can see who is
 * on the workspace, accept or decline an invitation waiting for their
 * address, and leave. Every write here is one conditional write on the
 * Users or Invitations table, and the authorizer keeps reading the Users
 * row exactly as it always has.
 */
type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<CallerContext>

const actorOf = (ctx: CallerContext) => ({ type: 'user' as const, id: ctx.userId ?? '', label: ctx.email || undefined })
const mask = (e: string) => e.replace(/^(.).*(@.*)$/, '$1***$2')
const lower = (s: unknown) => String(s ?? '').trim().toLowerCase()

/** The caller's own row, read fresh: the authorizer context can be five minutes stale. */
async function self(ctx: CallerContext): Promise<UserRow | undefined> {
  if (!ctx.userId) return undefined
  return getUser(ctx.userId)
}

async function owner(ctx: CallerContext): Promise<UserRow | undefined> {
  const me = await self(ctx)
  return me?.role === 'owner' ? me : undefined
}

const publicPerson = (u: UserRow, me: string | undefined, signedIn?: string) => ({
  userId: u.userId,
  email: u.email ?? null,
  role: u.role,
  notify: u.notify !== false,
  createdAt: u.createdAt,
  lastSignIn: signedIn ?? null,
  you: u.userId === me,
})

const publicInvitation = (i: InvitationRow) => ({
  invitationId: i.invitationId,
  email: i.email,
  role: i.role,
  inviterEmail: i.inviterEmail ?? null,
  createdAt: i.createdAt,
  expiresAt: i.expiresAt,
})

async function seats(tenantId: string, users: UserRow[], pending: InvitationRow[]) {
  const tier = await workspaceTier(tenantId)
  return { tier, max: SEATS[tier], used: users.length + pending.length, wall: seatWall(tier) }
}

// ── Listing ──────────────────────────────────────────────────────────────

/** Anyone on the workspace sees who else is; only an owner sees the invitations and the seat count. */
export async function listPeople(ctx: CallerContext): Promise<APIGatewayProxyResultV2> {
  const me = await self(ctx)
  if (!me) return json(404, { error: 'no_tenant' })
  const users = await listTenantUsers(me.tenantId)
  const signIns = await Promise.all(users.map((u) => lastSignIn(u.userId).catch(() => undefined)))
  const people = users
    .map((u, i) => publicPerson(u, ctx.userId, signIns[i]))
    .sort((a, b) => (a.role === b.role ? a.createdAt.localeCompare(b.createdAt) : a.role === 'owner' ? -1 : 1))
  if (me.role !== 'owner') return json(200, { people, role: me.role })
  const pending = await listTenantInvitations(me.tenantId)
  return json(200, {
    people,
    role: me.role,
    invitations: pending.map(publicInvitation),
    seats: await seats(me.tenantId, users, pending),
  })
}

// ── Inviting ─────────────────────────────────────────────────────────────

export async function invite(ctx: CallerContext, event: Event): Promise<APIGatewayProxyResultV2> {
  const me = await owner(ctx)
  if (!me) return json(403, { error: 'owner_required' })
  const body = JSON.parse(event.body ?? '{}')
  const email = lower(body.email)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return json(400, { error: 'email_invalid', message: 'That does not look like an email address.' })
  }
  // Owner is accepted by the API for a deliberate hand-over; the form never offers it.
  const role: UserRow['role'] = body.role === 'owner' ? 'owner' : 'member'

  const [tenant, users, pending] = await Promise.all([
    getTenant(me.tenantId),
    listTenantUsers(me.tenantId),
    listTenantInvitations(me.tenantId),
  ])
  if (users.some((u) => lower(u.email) === email)) {
    return json(409, { error: 'already_member', message: 'That person is already on this workspace.' })
  }
  if (pending.some((i) => i.email === email)) {
    return json(409, { error: 'already_invited', message: 'That address already has an invitation waiting. Resend it from the list below.' })
  }
  const s = await seats(me.tenantId, users, pending)
  if (s.used >= s.max) return json(403, { error: 'seat_limit', message: s.wall, seats: s })
  if (pending.length >= MAX_PENDING_INVITATIONS) {
    return json(409, { error: 'too_many_pending', message: 'Ten invitations are already waiting. Cancel one first.' })
  }

  const row = await createInvitation({
    tenantId: me.tenantId, email, role, inviterId: me.userId, inviterEmail: me.email,
  })
  const sent = await sendInvitationMail(row, tenant, me)
  await recordAudit({
    tenantId: me.tenantId,
    actor: actorOf(ctx),
    origin: 'ui',
    action: 'people.invited',
    moduleId: 'platform',
    targetId: row.invitationId,
    summary: `${mask(email)} invited to join as ${role}`,
  })
  return json(201, {
    invitation: publicInvitation(row),
    sent,
    message: 'Invitation sent. If that address already has its own workspace they will be asked to close it before joining.',
  })
}

async function sendInvitationMail(row: InvitationRow, tenant: TenantRow | undefined, inviter: UserRow): Promise<boolean> {
  const m = invitationMail({
    businessName: tenant?.name ?? 'a MakerBay workspace',
    inviterEmail: inviter.email ?? 'The owner',
    email: row.email,
  })
  const r = await sendEmail({
    to: row.email,
    audience: 'owner',
    fromName: tenant?.name,
    ...(inviter.email ? { replyTo: inviter.email } : {}),
    subject: m.subject,
    text: m.text,
    html: m.html,
  })
  if (!r.sent) console.warn('invitation not sent', { tenantId: row.tenantId, error: r.error })
  return r.sent
}

export async function resendInvitation(ctx: CallerContext, invitationId: string): Promise<APIGatewayProxyResultV2> {
  const me = await owner(ctx)
  if (!me) return json(403, { error: 'owner_required' })
  const row = await extendInvitation(me.tenantId, invitationId)
  if (!row) return json(404, { error: 'not_found' })
  const sent = await sendInvitationMail(row, await getTenant(me.tenantId), me)
  return json(200, { invitation: publicInvitation(row), sent })
}

export async function cancelInvitation(ctx: CallerContext, invitationId: string): Promise<APIGatewayProxyResultV2> {
  const me = await owner(ctx)
  if (!me) return json(403, { error: 'owner_required' })
  const row = await getInvitation(me.tenantId, invitationId)
  if (!row || !(await settleInvitation(me.tenantId, invitationId, 'canceled'))) return json(404, { error: 'not_found' })
  await recordAudit({
    tenantId: me.tenantId, actor: actorOf(ctx), origin: 'ui', action: 'people.invitation_canceled',
    moduleId: 'platform', targetId: invitationId, summary: `Invitation for ${mask(row.email)} cancelled`,
  })
  return json(200, { canceled: invitationId })
}

// ── Members ──────────────────────────────────────────────────────────────

export async function patchPerson(ctx: CallerContext, userId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const me = await self(ctx)
  if (!me) return json(404, { error: 'no_tenant' })
  const target = await getUser(userId)
  if (!target || target.tenantId !== me.tenantId) return json(404, { error: 'not_found' })
  const body = JSON.parse(event.body ?? '{}')
  const patch: { role?: UserRow['role']; notify?: boolean } = {}

  if (typeof body.notify === 'boolean') {
    // A person may silence their own notifications; an owner may silence anyone's.
    if (me.role !== 'owner' && target.userId !== me.userId) return json(403, { error: 'owner_required' })
    patch.notify = body.notify
  }
  if (body.role !== undefined) {
    if (me.role !== 'owner') return json(403, { error: 'owner_required' })
    if (body.role !== 'owner' && body.role !== 'member') return json(400, { error: 'role_invalid' })
    if (target.role === 'owner' && body.role === 'member') {
      const owners = (await listTenantUsers(me.tenantId)).filter((u) => u.role === 'owner')
      if (owners.length <= 1) {
        return json(409, { error: 'last_owner', message: 'A workspace needs an owner. Make someone else an owner first.' })
      }
    }
    patch.role = body.role
  }
  if (!Object.keys(patch).length) return json(400, { error: 'nothing_to_change' })
  await updateUser(userId, patch)
  if (patch.role) {
    await recordAudit({
      tenantId: me.tenantId, actor: actorOf(ctx), origin: 'ui', action: 'people.role_changed',
      moduleId: 'platform', targetId: userId, summary: `${mask(target.email ?? userId)} is now ${patch.role === 'owner' ? 'an owner' : 'a member'}`,
    })
  }
  return json(200, { userId, ...patch })
}

export async function removePerson(ctx: CallerContext, userId: string): Promise<APIGatewayProxyResultV2> {
  const me = await owner(ctx)
  if (!me) return json(403, { error: 'owner_required' })
  if (userId === me.userId) return json(400, { error: 'use_leave', message: 'To remove yourself, leave the workspace from your account page.' })
  const target = await getUser(userId)
  if (!target || target.tenantId !== me.tenantId) return json(404, { error: 'not_found' })
  if (target.role === 'owner') {
    return json(409, { error: 'owner_cannot_be_removed', message: 'Make them a member first, then remove them.' })
  }
  await endMembership(target, await getTenant(me.tenantId), false)
  await recordAudit({
    tenantId: me.tenantId, actor: actorOf(ctx), origin: 'ui', action: 'people.removed',
    moduleId: 'platform', targetId: userId, summary: `${mask(target.email ?? userId)} removed from the workspace`,
  })
  return json(200, { removed: userId })
}

/**
 * The one exit path, for removal and for leaving: drop the row, end every
 * session, tell the person. Residual access is the authorizer cache plus
 * the life of an access token, up to 20 minutes.
 */
async function endMembership(target: UserRow, tenant: TenantRow | undefined, left: boolean): Promise<void> {
  await removeUser(target.userId)
  try {
    await revokeUserSessions(target.userId)
  } catch (err) {
    console.error('session revocation failed', { userId: target.userId, err: String(err) })
  }
  if (target.email) {
    const m = removedMail({ businessName: tenant?.name ?? 'the workspace', left })
    await sendEmail({ to: target.email, audience: 'owner', subject: m.subject, text: m.text, html: m.html })
  }
}

export async function leaveWorkspace(ctx: CallerContext): Promise<APIGatewayProxyResultV2> {
  const me = await self(ctx)
  if (!me) return json(404, { error: 'no_tenant' })
  if (me.role === 'owner') {
    const owners = (await listTenantUsers(me.tenantId)).filter((u) => u.role === 'owner')
    if (owners.length <= 1) {
      return json(409, { error: 'last_owner', message: 'You are the only owner. Make someone else an owner first, or close the workspace under Settings.' })
    }
  }
  await endMembership(me, await getTenant(me.tenantId), true)
  await recordAudit({
    tenantId: me.tenantId, actor: actorOf(ctx), origin: 'ui', action: 'people.left',
    moduleId: 'platform', targetId: me.userId, summary: `${mask(me.email ?? me.userId)} left the workspace`,
  })
  return json(200, { left: me.tenantId })
}

// ── The invitee's side ───────────────────────────────────────────────────

async function invitationsFor(ctx: CallerContext) {
  const rows = await listInvitationsForEmail(ctx.email ?? '')
  const tenants = await Promise.all(rows.map((r) => getTenant(r.tenantId)))
  return rows.map((r, i) => ({
    ...publicInvitation(r),
    tenantId: r.tenantId,
    businessName: tenants[i]?.name ?? 'a MakerBay workspace',
  }))
}

export async function myInvitations(ctx: CallerContext): Promise<APIGatewayProxyResultV2> {
  if (!ctx.userId) return json(401, { error: 'user_token_required' })
  return json(200, { invitations: await invitationsFor(ctx) })
}

/** Exported so `me` can include the list without a second round trip from the dashboard. */
export { invitationsFor }

export async function acceptInvitation(ctx: CallerContext, invitationId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  if (!ctx.userId || !ctx.email) return json(401, { error: 'user_token_required' })
  // Matched on the session's email, never on the id alone: an id is a pointer, not a capability.
  const mine = (await listInvitationsForEmail(ctx.email)).find((i) => i.invitationId === invitationId)
  if (!mine) return json(404, { error: 'not_found', message: 'That invitation is no longer open.' })
  const body = JSON.parse(event.body ?? '{}')

  const existing = await getUser(ctx.userId)
  if (existing) {
    if (existing.tenantId === mine.tenantId) {
      await settleInvitation(mine.tenantId, invitationId, 'accepted')
      return json(200, { joined: mine.tenantId, already: true })
    }
    const theirs = await getTenant(existing.tenantId)
    const empty = existing.role === 'owner' && (await isEmptyWorkspace(theirs))
    if (!(body.closeExisting === true && empty)) {
      return json(409, {
        error: 'has_workspace',
        emptyWorkspace: empty,
        workspaceName: theirs?.name ?? '',
        message: empty
          ? `You have an empty workspace of your own, ${theirs?.name ?? ''}. Close it and join instead?`
          : `This email already runs its own MakerBay workspace, ${theirs?.name ?? ''}. To join instead, close that workspace under Settings first, or ask the owner to invite a different address.`,
      })
    }
    await closeTenant(theirs!, existing, ctx, 'closed by its owner to join another workspace')
  }

  const joining = await getTenant(mine.tenantId)
  if (!joining || joining.status !== 'active') return json(410, { error: 'workspace_gone' })
  const added = await addUser({
    userId: ctx.userId,
    email: ctx.email,
    tenantId: mine.tenantId,
    role: mine.role,
    notify: true,
    invitedBy: mine.inviterId,
    createdAt: new Date().toISOString(),
  })
  if (added === 'exists') return json(409, { error: 'has_workspace' })
  await settleInvitation(mine.tenantId, invitationId, 'accepted')
  await recordAudit({
    tenantId: mine.tenantId, actor: actorOf(ctx), origin: 'ui', action: 'people.joined',
    moduleId: 'platform', targetId: ctx.userId, summary: `${mask(ctx.email)} joined as ${mine.role}`,
  })
  return json(200, { joined: mine.tenantId, name: joining.name })
}

export async function declineInvitation(ctx: CallerContext, invitationId: string): Promise<APIGatewayProxyResultV2> {
  if (!ctx.userId || !ctx.email) return json(401, { error: 'user_token_required' })
  const mine = (await listInvitationsForEmail(ctx.email)).find((i) => i.invitationId === invitationId)
  if (!mine) return json(404, { error: 'not_found' })
  await settleInvitation(mine.tenantId, invitationId, 'declined')
  await recordAudit({
    tenantId: mine.tenantId, actor: actorOf(ctx), origin: 'ui', action: 'people.declined',
    moduleId: 'platform', targetId: invitationId, summary: `${mask(ctx.email)} declined the invitation`,
  })
  return json(200, { declined: invitationId })
}

// ── Closing a workspace ──────────────────────────────────────────────────

/**
 * Suspend the tenant and end every membership. Suspension is what the kill
 * switch does, so every public page and every authenticated call is refused
 * by the paths that already exist; full erasure stays the privacy script's
 * job, run by a person.
 */
async function closeTenant(tenant: TenantRow, by: UserRow, ctx: CallerContext, why: string): Promise<void> {
  await setTenantStatus(tenant.tenantId, 'suspended')
  for (const u of await listTenantUsers(tenant.tenantId)) {
    await removeUser(u.userId)
    try {
      await revokeUserSessions(u.userId)
    } catch (err) {
      console.error('session revocation failed', { userId: u.userId, err: String(err) })
    }
  }
  await recordAudit({
    tenantId: tenant.tenantId, actor: actorOf(ctx), origin: 'ui', action: 'workspace.closed',
    moduleId: 'platform', summary: `Workspace ${tenant.name} ${why} by ${mask(by.email ?? by.userId)}`,
  })
}

export async function closeWorkspace(ctx: CallerContext, tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const me = await owner(ctx)
  if (!me || me.tenantId !== tenantId) return json(403, { error: 'owner_required' })
  const tenant = await getTenant(tenantId)
  if (!tenant) return json(404, { error: 'not_found' })
  const body = JSON.parse(event.body ?? '{}')
  // Typed confirmation: the public address, which the owner knows by heart.
  if (lower(body.confirm) !== tenant.slug) {
    return json(400, { error: 'confirm_mismatch', message: `Type the workspace address, ${tenant.slug}, to confirm.` })
  }
  await closeTenant(tenant, me, ctx, 'closed')
  return json(200, { closed: tenantId })
}
