import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import {
  DeleteSuppressedDestinationCommand,
  GetSuppressedDestinationCommand,
  SESv2Client,
  SendEmailCommand,
} from '@aws-sdk/client-sesv2'
import {
  AdminResetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider'
import { GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import {
  ddb,
  findUserByEmail,
  getEffectiveEntitlement,
  getMonthUsage,
  getTenant,
  grantManual,
  json,
  listGrants,
  listTenantUsers,
  MODULES,
  PLATFORM_VERSION,
  revokeGrant,
  sendEmail,
  setTenantStatus,
  ulid,
  type Grant,
} from '@makerbay/core'
import { PLATFORM, customerFooter, ownerFooter, ticketReply } from '@makerbay/email'

/**
 * Staff-facing admin API. Its purpose in v1 is narrow and worth stating:
 * replace unaudited hand edits of DynamoDB with guarded, audited writes.
 *
 * It lives on its own gateway and its own Lambda so that admin routes do not
 * exist on the customer API at all — a stronger guarantee than "the route
 * table is configured correctly".
 */

interface StaffContext {
  staffSub: string
  staffEmail: string
  staffRole: string
}
type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<StaffContext>

const PLANS: Record<string, Record<string, number>> = {
  free: { messagesPerMonth: 200, sources: 20, sourceBytes: 25 * 1024 * 1024 },
  pro: { messagesPerMonth: 100000, sources: 500, sourceBytes: 2 * 1024 * 1024 * 1024 },
}

const ses = new SESv2Client({})
const cognito = new CognitoIdentityProviderClient({})

export const handler = async (event: Event): Promise<APIGatewayProxyResultV2> => {
  const staff = event.requestContext.authorizer.lambda
  const method = event.requestContext.http.method
  const path = event.rawPath

  try {
    if (method === 'GET' && path === '/admin/v1/whoami') {
      return json(200, { staff, platform: PLATFORM_VERSION, modules: MODULES.map((m) => m.id) })
    }
    if (method === 'GET' && path === '/admin/v1/tenants') return await listTenants()

    const detail = path.match(/^\/admin\/v1\/tenants\/([A-Z0-9]+)$/)
    if (method === 'GET' && detail) return await tenantDetail(detail[1])

    const grantPath = path.match(/^\/admin\/v1\/tenants\/([A-Z0-9]+)\/grants$/)
    if (method === 'POST' && grantPath) return await createGrant(staff, grantPath[1], event)

    const revokePath = path.match(/^\/admin\/v1\/tenants\/([A-Z0-9]+)\/grants\/revoke$/)
    if (method === 'POST' && revokePath) return await revoke(staff, revokePath[1], event)

    if (method === 'POST' && path === '/admin/v1/email/test') return await sendTestEmail(staff, event)

    if (method === 'GET' && path === '/admin/v1/lookup') return await lookupByEmail(staff, event)

    const reset = path.match(/^\/admin\/v1\/users\/([A-Za-z0-9-]+)\/reset-password$/)
    if (method === 'POST' && reset) return await resetPassword(staff, reset[1], event)

    const susp = path.match(/^\/admin\/v1\/tenants\/([A-Z0-9]+)\/(suspend|unsuspend)$/)
    if (method === 'POST' && susp) return await setSuspension(staff, susp[1], susp[2] === 'suspend', event)

    if (method === 'GET' && path === '/admin/v1/platform') return platformIdentity()

    if (method === 'GET' && path === '/admin/v1/audit') return await auditLog(event)

    if (method === 'GET' && path === '/admin/v1/email/suppression') return await suppressionLookup(staff, event)
    const unsup = path.match(/^\/admin\/v1\/email\/suppression\/(.+)$/)
    if (method === 'DELETE' && unsup) return await suppressionRemove(staff, decodeURIComponent(unsup[1]))

    const convs = path.match(/^\/admin\/v1\/tenants\/([A-Z0-9]+)\/conversations$/)
    if (method === 'GET' && convs) return await conversations(staff, convs[1], event)

    if (method === 'GET' && path === '/admin/v1/overview') return await overview()
    if (method === 'GET' && path === '/admin/v1/tickets') return await listAllTickets()
    const tk = path.match(/^\/admin\/v1\/tickets\/([A-Z0-9]{26})\/([A-Z0-9]{26})\/(reply|close)$/)
    if (method === 'POST' && tk) {
      return tk[3] === 'reply'
        ? await staffReply(staff, tk[1], tk[2], event)
        : await closeTicket(staff, tk[1], tk[2])
    }
    const note = path.match(/^\/admin\/v1\/tenants\/([A-Z0-9]+)\/note$/)
    if (method === 'POST' && note) return await addNote(staff, note[1], event)

    return json(404, { error: 'not_found' })
  } catch (err) {
    console.error('admin error', { path, method, err })
    return json(500, { error: 'internal_error' })
  }
}

/**
 * Proves the SES setup end to end: domain verified, DKIM signing, config set
 * applied, and out of the sandbox. Staff-only, and it will only send to a
 * staff member's own address so this can never become an open relay.
 */
async function sendTestEmail(staff: StaffContext, event: Event): Promise<APIGatewayProxyResultV2> {
  const body = JSON.parse(event.body ?? '{}')
  const to = String(body.to ?? staff.staffEmail ?? '').trim().toLowerCase()
  if (!to.includes('@')) return json(400, { error: 'recipient_required' })
  if (to !== (staff.staffEmail ?? '').toLowerCase()) {
    await audit(staff, 'email.test', '-', { to }, 'denied')
    return json(403, {
      error: 'self_only',
      message: 'A test email can only be sent to your own staff address.',
    })
  }

  const from = process.env.EMAIL_FROM!
  try {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        ConfigurationSetName: process.env.EMAIL_CONFIG_SET,
        Content: {
          Simple: {
            Subject: { Data: 'MakerBay email test' },
            Body: {
              Text: {
                Data: [
                  'This is a test from the MakerBay staff console.',
                  '',
                  `Sent from ${from} at ${new Date().toISOString()}.`,
                  'If it arrived, DKIM signing and the configuration set are working.',
                  'Check the raw headers for a DKIM pass.',
                ].join('\n'),
              },
            },
          },
        },
      }),
    )
  } catch (err) {
    const name = (err as { name?: string }).name ?? 'unknown'
    await audit(staff, 'email.test', '-', { to, error: name }, 'error')
    // The sandbox is the overwhelmingly likely cause; say so plainly.
    return json(502, {
      error: 'send_failed',
      message:
        name === 'MessageRejected'
          ? 'SES rejected the message. The account is probably still in the sandbox, where you can only send to verified addresses.'
          : `SES refused the request (${name}).`,
    })
  }

  await audit(staff, 'email.test', '-', { to })
  return json(200, { sent: to, from })
}

/**
 * Append-only audit. The admin role has PutItem on this table and nothing
 * else, so this Lambda physically cannot rewrite or delete its own trail.
 */
async function audit(
  staff: StaffContext,
  action: string,
  targetTenantId: string,
  detail: Record<string, unknown>,
  result: 'ok' | 'denied' | 'error' = 'ok',
): Promise<void> {
  const now = new Date().toISOString()
  await ddb.send(
    new PutCommand({
      TableName: process.env.TABLE_ADMINAUDIT!,
      Item: {
        pk: `AUDIT#${now.slice(0, 7)}`,
        sk: `${now}#${ulid()}`,
        ts: now,
        staffSub: staff.staffSub,
        staffEmail: staff.staffEmail,
        staffRole: staff.staffRole,
        action,
        targetTenantId,
        detail,
        result,
      },
    }),
  )
}

async function listTenants(): Promise<APIGatewayProxyResultV2> {
  // Small table at this stage; revisit when tenant count makes a scan silly.
  const r = await ddb.send(new ScanCommand({ TableName: process.env.TABLE_TENANTS! }))
  const tenants = (r.Items ?? []).map((t) => {
    // Health flags turn the directory into a triage queue - each one is
    // derivable from the tenant row alone, so the list stays one scan.
    const flags: string[] = []
    if (t.status === 'suspended') flags.push('suspended')
    if (t.stripeCustomerId && !t.lastWebhookAt) flags.push('no webhook events')
    if (t.stripeAccountId && !t.payoutsEnabled) flags.push('Connect incomplete')
    return {
      tenantId: t.tenantId,
      name: t.name,
      slug: t.slug,
      plan: t.plan,
      status: t.status,
      subscriptionStatus: t.subscriptionStatus ?? 'none',
      createdAt: t.createdAt,
      flags,
    }
  })
  tenants.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return json(200, { tenants, count: tenants.length })
}

async function tenantDetail(tenantId: string): Promise<APIGatewayProxyResultV2> {
  const tenant = await getTenant(tenantId)
  if (!tenant) return json(404, { error: 'tenant_not_found' })

  const [grants, usage, users, presence, sourceCount] = await Promise.all([
    listGrants(tenantId),
    getMonthUsage(tenantId, new Date().toISOString().slice(0, 7)),
    listTenantUsers(tenantId),
    ddb.send(new GetCommand({ TableName: process.env.TABLE_PRESENCECONFIG!, Key: { tenantId } }))
      .then((r) => r.Item).catch(() => undefined),
    ddb.send(new QueryCommand({
      TableName: process.env.TABLE_SOURCES!,
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': tenantId },
      Select: 'COUNT',
    })).then((r) => r.Count ?? 0).catch(() => null),
  ])
  const entitlements: Record<string, unknown> = {}
  for (const m of MODULES) entitlements[m.id] = await getEffectiveEntitlement(tenantId, m.id)

  return json(200, {
    tenant: {
      tenantId: tenant.tenantId,
      name: tenant.name,
      slug: tenant.slug,
      plan: tenant.plan,
      status: tenant.status,
      subscriptionStatus: tenant.subscriptionStatus ?? 'none',
      currentPeriodEnd: tenant.currentPeriodEnd ?? null,
      // Identifiers only — never secret material.
      stripeCustomerId: tenant.stripeCustomerId ?? null,
      createdAt: tenant.createdAt,
    },
    // The rest of the 360: is Stripe reaching us, can they take money, who
    // can log in, what is public - the first look for most support tickets.
    webhook: {
      lastAt: tenant.lastWebhookAt ?? null,
      lastType: tenant.lastWebhookType ?? null,
      lastLive: tenant.lastWebhookLive ?? null,
    },
    connect: {
      stripeAccountId: tenant.stripeAccountId ?? null,
      payoutsEnabled: tenant.payoutsEnabled ?? false,
      onboardedAt: tenant.connectOnboardedAt ?? null,
    },
    users: users.map((u) => ({
      userId: u.userId, email: u.email ?? null, role: u.role, createdAt: u.createdAt,
    })),
    moduleState: {
      presence: presence
        ? {
            published: Boolean(presence.published),
            customDomain: presence.customDomain ?? null,
            domainStatus: presence.domainStatus ?? null,
          }
        : null,
      assistant: { sourceCount },
    },
    entitlements,
    grants: grants.map((g: Grant) => ({
      sk: g.sk, source: g.source, moduleId: g.moduleId, planTier: g.planTier,
      status: g.status, expiresAt: g.expiresAt ?? null, reason: g.reason ?? null,
      grantedBy: g.grantedBy, createdAt: g.createdAt,
    })),
    usage,
  })
}

/** G3: every support ticket arrives as an email address. */
async function lookupByEmail(staff: StaffContext, event: Event): Promise<APIGatewayProxyResultV2> {
  const email = String(event.queryStringParameters?.email ?? '').trim().toLowerCase()
  if (!email.includes('@')) return json(400, { error: 'email_required' })

  const user = await findUserByEmail(email)
  if (!user) return json(404, { error: 'no_user', message: 'No user with that email address.' })
  const tenant = await getTenant(user.tenantId)
  await audit(staff, 'user.lookup', user.tenantId, { email })
  return json(200, {
    user: { userId: user.userId, email: user.email, role: user.role, createdAt: user.createdAt },
    tenant: tenant
      ? {
          tenantId: tenant.tenantId, name: tenant.name, slug: tenant.slug,
          plan: tenant.plan, status: tenant.status,
          subscriptionStatus: tenant.subscriptionStatus ?? 'none',
        }
      : null,
  })
}

/**
 * Sends Cognito's own reset code to the user's verified email. Staff never
 * see or set a password - the user proves the mailbox, same as self-service.
 */
async function resetPassword(staff: StaffContext, userId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const body = JSON.parse(event.body ?? '{}')
  const reason = String(body.reason ?? '').trim()
  if (reason.length < 10) {
    return json(400, { error: 'reason_required', message: 'Give a reason of at least 10 characters - it is recorded in the audit log.' })
  }
  try {
    await cognito.send(new AdminResetUserPasswordCommand({
      UserPoolId: process.env.CUSTOMER_POOL_ID!,
      Username: userId,
    }))
  } catch (err) {
    const name = (err as { name?: string }).name ?? 'unknown'
    await audit(staff, 'user.reset_password', '-', { userId, error: name }, 'error')
    return json(502, {
      error: 'reset_failed',
      message: name === 'InvalidParameterException'
        ? 'Cognito refused - the user may have no verified email to send the code to.'
        : `Cognito refused the request (${name}).`,
    })
  }
  await audit(staff, 'user.reset_password', '-', { userId, reason })
  return json(200, { reset: userId, note: 'Cognito emailed the user a reset code.' })
}

/**
 * The home dashboard: the numbers a solo founder checks between jobs.
 * Everything comes from tables this Lambda already reads; a scan at this
 * scale is instant and honest.
 */
async function overview(): Promise<APIGatewayProxyResultV2> {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const [tenantScan, ticketScan, auditMonth] = await Promise.all([
    ddb.send(new ScanCommand({ TableName: process.env.TABLE_TENANTS! })),
    ddb.send(new ScanCommand({ TableName: process.env.TABLE_TICKETS! })),
    ddb.send(new QueryCommand({
      TableName: process.env.TABLE_ADMINAUDIT!,
      KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': `AUDIT#${new Date().toISOString().slice(0, 7)}` },
      ScanIndexForward: false,
      Limit: 20,
    })),
  ])
  const tenants = tenantScan.Items ?? []
  const ticketRows = ticketScan.Items ?? []

  // Near-cap sweep: usage vs assistant message limits, the cap people hit.
  const nearCap: Array<{ tenantId: string; name: string; metric: string; used: number; limit: number }> = []
  const month = new Date().toISOString().slice(0, 7)
  await Promise.all(tenants.map(async (t) => {
    try {
      const usage = await getMonthUsage(String(t.tenantId), month)
      const ent = await getEffectiveEntitlement(String(t.tenantId), 'assistant')
      const used = usage['assistant.message'] ?? 0
      const limit = ent.limits.messagesPerMonth ?? 0
      if (limit > 0 && used >= limit * 0.8) {
        nearCap.push({ tenantId: String(t.tenantId), name: String(t.name), metric: 'assistant messages', used, limit })
      }
    } catch { /* one bad tenant never hides the dashboard */ }
  }))

  return json(200, {
    tenants: tenants.length,
    signups7d: tenants.filter((t) => String(t.createdAt) >= weekAgo).length,
    activeSubscriptions: tenants.filter((t) => ['active', 'trialing'].includes(String(t.subscriptionStatus))).length,
    suspended: tenants.filter((t) => t.status === 'suspended').length,
    openTickets: ticketRows.filter((t) => t.status !== 'closed').length,
    priorityTickets: ticketRows.filter((t) => t.status !== 'closed' && t.priority === 'priority').length,
    nearCap,
    recentAudit: (auditMonth.Items ?? []).map((e) => ({
      ts: e.ts, staffEmail: e.staffEmail, action: e.action, targetTenantId: e.targetTenantId,
    })),
  })
}

// ── Tickets (issue 49) ───────────────────────────────────────────────────

async function listAllTickets(): Promise<APIGatewayProxyResultV2> {
  const r = await ddb.send(new ScanCommand({ TableName: process.env.TABLE_TICKETS! }))
  const rows = (r.Items ?? []).sort((a, b) => {
    // Open before answered before closed; priority first inside a status;
    // then most recently touched.
    const rank = (t: Record<string, unknown>) =>
      (t.status === 'open' ? 0 : t.status === 'answered' ? 1 : 2) * 10 +
      (t.priority === 'priority' ? 0 : 1)
    return rank(a) - rank(b) || String(b.updatedAt).localeCompare(String(a.updatedAt))
  })
  return json(200, { tickets: rows })
}

async function staffReply(
  staff: StaffContext,
  tenantId: string,
  ticketId: string,
  event: Event,
): Promise<APIGatewayProxyResultV2> {
  const body = JSON.parse(event.body ?? '{}')
  const text = String(body.message ?? '').trim().slice(0, 4000)
  if (text.length < 2) return json(400, { error: 'message_required' })

  const r = await ddb.send(new GetCommand({ TableName: process.env.TABLE_TICKETS!, Key: { tenantId, ticketId } }))
  const ticket = r.Item
  if (!ticket) return json(404, { error: 'not_found' })

  const now = new Date().toISOString()
  const updated = {
    ...ticket,
    status: 'answered',
    messages: [...(ticket.messages as unknown[]), { from: 'staff', text, at: now, by: staff.staffEmail }],
    updatedAt: now,
  }
  await ddb.send(new PutCommand({ TableName: process.env.TABLE_TICKETS!, Item: updated }))

  if (ticket.openedByEmail) {
    /*
     * Through sendEmail like every other message in the product (issue 132).
     *
     * This was a hand-rolled SendEmailCommand, and each thing it skipped was
     * load-bearing: the per-tenant suppression check (so we mailed addresses
     * we already knew were dead), the ref that writes delivery failure back
     * onto the record, and the footer carrying the postal address. It is also
     * the one email a business owner reads while already unhappy with us.
     */
    const tenant = await getTenant(tenantId)
    const mail = ticketReply({
      businessName: tenant?.name ?? 'your business',
      subject: String(ticket.subject ?? 'your message'),
      reply: text,
    })
    const r = await sendEmail({
      to: String(ticket.openedByEmail),
      audience: 'owner',
      ref: { tenantId, moduleId: 'support', refType: 'ticket', refId: ticketId },
      // A support answer is transactional: the owner asked us a question and
      // is waiting for it. No unsubscribe.
      optional: false,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    })
    if (!r.sent) console.warn('ticket reply email failed', { ticketId, error: r.error })
  }
  await audit(staff, 'ticket.replied', tenantId, { ticketId, subject: ticket.subject })
  return json(200, { ticket: updated })
}

async function closeTicket(staff: StaffContext, tenantId: string, ticketId: string): Promise<APIGatewayProxyResultV2> {
  const r = await ddb.send(new GetCommand({ TableName: process.env.TABLE_TICKETS!, Key: { tenantId, ticketId } }))
  if (!r.Item) return json(404, { error: 'not_found' })
  await ddb.send(new PutCommand({
    TableName: process.env.TABLE_TICKETS!,
    Item: { ...r.Item, status: 'closed', updatedAt: new Date().toISOString() },
  }))
  await audit(staff, 'ticket.closed', tenantId, { ticketId, subject: r.Item.subject })
  return json(200, { closed: ticketId })
}

/** The runbook's audit-note rule, finally a first-class action. */
async function addNote(staff: StaffContext, tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const body = JSON.parse(event.body ?? '{}')
  const text = String(body.text ?? '').trim().slice(0, 1000)
  if (text.length < 5) return json(400, { error: 'text_required' })
  await audit(staff, 'note.added', tenantId, { text })
  return json(201, { noted: true })
}

/** G8: the staff audit trail, one month per request, newest first. */
async function auditLog(event: Event): Promise<APIGatewayProxyResultV2> {
  const month = /^\d{4}-\d{2}$/.test(String(event.queryStringParameters?.month))
    ? String(event.queryStringParameters?.month)
    : new Date().toISOString().slice(0, 7)
  const r = await ddb.send(
    new QueryCommand({
      TableName: process.env.TABLE_ADMINAUDIT!,
      KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': `AUDIT#${month}` },
      ScanIndexForward: false,
      Limit: 200,
    }),
  )
  return json(200, {
    month,
    entries: (r.Items ?? []).map((e) => ({
      ts: e.ts, staffEmail: e.staffEmail, action: e.action,
      targetTenantId: e.targetTenantId, detail: e.detail, result: e.result,
    })),
  })
}

/**
 * G5: is this address on the SES suppression list, and the audited way off
 * it. A bounced address stays suppressed until removed - the single most
 * common reason "my customer never got the email".
 */
async function suppressionLookup(staff: StaffContext, event: Event): Promise<APIGatewayProxyResultV2> {
  const email = String(event.queryStringParameters?.email ?? '').trim().toLowerCase()
  if (!email.includes('@')) return json(400, { error: 'email_required' })
  try {
    const r = await ses.send(new GetSuppressedDestinationCommand({ EmailAddress: email }))
    await audit(staff, 'email.suppression_lookup', '-', { email, suppressed: true })
    return json(200, {
      email,
      suppressed: true,
      reason: r.SuppressedDestination?.Reason ?? null,
      since: r.SuppressedDestination?.LastUpdateTime?.toISOString() ?? null,
    })
  } catch (err) {
    if ((err as { name?: string }).name === 'NotFoundException') {
      await audit(staff, 'email.suppression_lookup', '-', { email, suppressed: false })
      return json(200, { email, suppressed: false })
    }
    throw err
  }
}

async function suppressionRemove(staff: StaffContext, email: string): Promise<APIGatewayProxyResultV2> {
  const addr = email.trim().toLowerCase()
  if (!addr.includes('@')) return json(400, { error: 'email_required' })
  try {
    await ses.send(new DeleteSuppressedDestinationCommand({ EmailAddress: addr }))
  } catch (err) {
    if ((err as { name?: string }).name === 'NotFoundException') {
      return json(404, { error: 'not_suppressed', message: 'That address is not on the suppression list.' })
    }
    throw err
  }
  await audit(staff, 'email.suppression_removed', '-', { email: addr })
  return json(200, { removed: addr, note: 'If the mailbox bounces again it will be re-suppressed automatically.' })
}

/**
 * G6: read-only conversation viewer for "the AI answered wrong" tickets.
 * Reading customer conversations is sensitive, so every view is audited.
 * View-as-tenant stays read-only through this API on purpose - real
 * impersonation would break the pool-separation guarantee.
 */
async function conversations(staff: StaffContext, tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const sessionId = String(event.queryStringParameters?.sessionId ?? '')
  if (sessionId) {
    const r = await ddb.send(
      new QueryCommand({
        TableName: process.env.TABLE_CONVERSATIONS!,
        KeyConditionExpression: 'pk = :p',
        ExpressionAttributeValues: { ':p': `${tenantId}#${sessionId}` },
        Limit: 50,
      }),
    )
    await audit(staff, 'conversations.view', tenantId, { sessionId })
    return json(200, {
      sessionId,
      messages: (r.Items ?? []).map((m) => ({
        role: m.role, text: m.text, ts: m.ts ?? m.createdAt ?? null, feedback: m.feedback ?? null,
      })),
    })
  }

  const r = await ddb.send(
    new QueryCommand({
      TableName: process.env.TABLE_CONVERSATIONS!,
      IndexName: 'byTenant',
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': tenantId },
      ScanIndexForward: false,
      Limit: 300,
    }),
  )
  // Group the recent window into session summaries, thumbs-down first.
  const sessions = new Map<string, { sessionId: string; count: number; lastAt: string; preview: string; thumbsDown: number }>()
  for (const m of r.Items ?? []) {
    const sid = String(m.pk ?? '').split('#')[1] ?? ''
    if (!sid) continue
    const s = sessions.get(sid) ?? { sessionId: sid, count: 0, lastAt: '', preview: '', thumbsDown: 0 }
    s.count++
    const ts = String(m.ts ?? m.createdAt ?? '')
    if (ts > s.lastAt) { s.lastAt = ts; s.preview = String(m.text ?? '').slice(0, 120) }
    if (m.feedback === 'down') s.thumbsDown++
    sessions.set(sid, s)
  }
  await audit(staff, 'conversations.list', tenantId, {})
  return json(200, {
    sessions: [...sessions.values()].sort((a, b) =>
      b.thumbsDown - a.thumbsDown || b.lastAt.localeCompare(a.lastAt)).slice(0, 40),
  })
}

/**
 * G4: the abuse kill switch. Suspension hides every public page (slug
 * resolution refuses) and denies every authenticated call (authorizer
 * check). The authorizer caches per header, so allow a few minutes.
 */
async function setSuspension(
  staff: StaffContext,
  tenantId: string,
  suspend: boolean,
  event: Event,
): Promise<APIGatewayProxyResultV2> {
  const body = JSON.parse(event.body ?? '{}')
  const reason = String(body.reason ?? '').trim()
  if (reason.length < 10) {
    return json(400, { error: 'reason_required', message: 'Give a reason of at least 10 characters - it is recorded in the audit log.' })
  }
  const tenant = await getTenant(tenantId)
  if (!tenant) return json(404, { error: 'tenant_not_found' })

  await setTenantStatus(tenantId, suspend ? 'suspended' : 'active')
  await audit(staff, suspend ? 'tenant.suspend' : 'tenant.unsuspend', tenantId, { reason })
  return json(200, {
    tenantId,
    status: suspend ? 'suspended' : 'active',
    note: suspend
      ? 'Public pages are hidden now; dashboard and API access dies as authorizer caches expire (a few minutes).'
      : 'Reinstated. Public pages return immediately; sign-ins as caches expire.',
  })
}

/**
 * Grant a module without payment: pilots, comps, internal testing.
 *
 * A reason is required and an expiry is always set — "never" has to be asked
 * for explicitly. A comp that quietly becomes permanent is real money leaking
 * through Bedrock costs, and the expiry is what stops that happening by
 * forgetfulness.
 */
async function createGrant(
  staff: StaffContext,
  tenantId: string,
  event: Event,
): Promise<APIGatewayProxyResultV2> {
  const body = JSON.parse(event.body ?? '{}')
  const moduleId = String(body.moduleId ?? '')
  const planTier = String(body.planTier ?? 'pro')
  const reason = String(body.reason ?? '').trim()
  const days = Number(body.days ?? 30)

  if (!MODULES.some((m) => m.id === moduleId)) return json(400, { error: 'unknown_module' })
  if (!PLANS[planTier]) return json(400, { error: 'unknown_plan_tier' })
  if (reason.length < 10) {
    return json(400, { error: 'reason_required', message: 'Give a reason of at least 10 characters — it is recorded in the audit log.' })
  }
  const tenant = await getTenant(tenantId)
  if (!tenant) return json(404, { error: 'tenant_not_found' })

  const expiresAt =
    body.expiresAt === 'never'
      ? 'never'
      : new Date(Date.now() + Math.min(Math.max(days, 1), 365) * 864e5).toISOString()

  const grant = await grantManual({
    tenantId,
    moduleId,
    planTier,
    limits: PLANS[planTier],
    grantedBy: staff.staffEmail || staff.staffSub,
    reason,
    expiresAt,
    trial: body.trial === true,
  })

  await audit(staff, 'entitlement.grant', tenantId, {
    moduleId, planTier, expiresAt, reason, trial: body.trial === true,
  })
  return json(201, {
    grant: { sk: grant.sk, moduleId, planTier, expiresAt: grant.expiresAt ?? 'never', reason },
  })
}

async function revoke(staff: StaffContext, tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const body = JSON.parse(event.body ?? '{}')
  const sk = String(body.sk ?? '')
  const reason = String(body.reason ?? '').trim()
  if (!sk.startsWith('GRANT#')) return json(400, { error: 'grant_key_required' })
  if (sk.endsWith('#stripe')) {
    await audit(staff, 'entitlement.revoke', tenantId, { sk }, 'denied')
    return json(400, {
      error: 'cannot_revoke_stripe_grant',
      message: 'A Stripe-backed grant follows the subscription. Cancel it in Stripe instead.',
    })
  }
  if (reason.length < 10) return json(400, { error: 'reason_required' })

  await revokeGrant(tenantId, sk)
  await audit(staff, 'entitlement.revoke', tenantId, { sk, reason })
  return json(200, { revoked: sk })
}

/**
 * Who the product says it is, and what that looks like in a footer (issue 131).
 *
 * Read-only, and the reason is worth stating: the sign-up email is rendered at
 * CDK synth time and stored inside the Cognito user pool resource, so it is a
 * build artifact that no runtime lookup can reach. If this were editable, that
 * one email would sit on the old address until the next deploy while the other
 * 21 moved - which is exactly the kind of quiet disagreement this page exists
 * to make visible.
 *
 * The footers are rendered by calling the real functions rather than by
 * describing them, so this page cannot drift from what actually ships. If it
 * looks right here, it is right in the inbox.
 */
function platformIdentity(): APIGatewayProxyResultV2 {
  return json(200, {
    identity: PLATFORM,
    editable: false,
    note: 'Set in packages/email/src/platform.ts. Changing it is a deploy, which republishes all 22 templates together.',
    footers: {
      owner: ownerFooter('Newtown Plumbing'),
      customer: customerFooter(
        'Newtown Plumbing',
        { phone: '0412 555 908', email: 'sam@newtownplumbing.com.au' },
        'You are getting this because you asked for a quote.',
      ),
    },
  })
}
