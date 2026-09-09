import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The consumer that decides whether an address gets marked dead. Getting this
 * wrong in either direction is expensive: suppress too eagerly and a customer
 * silently stops receiving their invoices, suppress too late and SES starts
 * counting bounces against the account.
 */

const recorded: unknown[] = []
const statuses: unknown[] = []
const sent: Array<{ to: string; subject: string }> = []

const writes: Array<Record<string, unknown>> = []

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  UpdateCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}))

let complaintCount = 1
const restricted: Array<{ tenantId: string; reason: string }> = []

// The Resend webhook's signing secret, as the Lambda would read it from
// Secrets Manager. The verifier itself is the real one: a mocked "yes" would
// make the signature tests below prove nothing.
const WEBHOOK_SECRET = 'whsec_' + Buffer.from('mail-events-test-key').toString('base64')

vi.mock('@makerbay/core', async () => ({
  verifySvix: (await vi.importActual<typeof import('../../core/src/mail/svix')>('../../core/src/mail/svix')).verifySvix,
  resendWebhookSecret: async () => WEBHOOK_SECRET,
  ddb: { send: async (c: { input: Record<string, unknown> }) => void writes.push(c.input) },
  // The owner notice renders a template now, and renderEmail reaches back into
  // core for the two colour helpers. Real implementations, not stubs, so the
  // rendered output is the one that would actually be sent.
  accentOn: (accent: string) => accent,
  readableOn: () => '#ffffff',
  recordMailEvent: async (row: unknown) => void recorded.push(row),
  // The complaint auto-brake (issue 134). Counting is mocked so a test can
  // choose how many complaints this workspace has had today.
  COMPLAINT_BRAKE: 3,
  countComplaint: async () => complaintCount,
  restrictSending: async (tenantId: string, reason: string) =>
    void restricted.push({ tenantId, reason }),
  setEmailStatus: async (...a: unknown[]) => void statuses.push(a),
  sendEmail: async (i: { to: string; subject: string }) => {
    sent.push(i)
    return { sent: true }
  },
  getTenant: async () => ({ tenantId: 'T1', name: 'Bright Spark Electrical' }),
  listTenantUsers: async () => [{ role: 'owner', email: 'owner@example.com' }],
}))

const { handler } = await import('./mail-events')

const ses = (
  eventType: string,
  extra: Record<string, unknown> = {},
  // `null`, not `undefined`: passing undefined would silently fall back to
  // the default and the untagged test would prove nothing.
  tags: Record<string, string[]> | null = {
    tenantId: ['T1'], refType: ['quote'], refId: ['Q1'], audience: ['customer'],
  },
) => ({
  detail: {
    eventType,
    mail: { messageId: 'M1', destination: ['dead@example.com'], ...(tags ? { tags } : {}) },
    ...extra,
  },
})

const perm = { bounce: { bounceType: 'Permanent', bounceSubType: 'General',
  bouncedRecipients: [{ emailAddress: 'dead@example.com', diagnosticCode: '550 no such user' }] } }
const trans = { bounce: { bounceType: 'Transient', bounceSubType: 'MailboxFull',
  bouncedRecipients: [{ emailAddress: 'full@example.com' }] } }

beforeEach(() => {
  recorded.length = 0
  statuses.length = 0
  sent.length = 0
  writes.length = 0
  restricted.length = 0
  complaintCount = 1
  process.env.TABLE_TENANTS = 'makerbay-tenants'
  process.env.TABLE_QUOTES = 'makerbay-quotes'
  process.env.TABLE_BOOKINGS = 'makerbay-bookings'
  process.env.TABLE_REQUESTS = 'makerbay-requests'
})

describe('mail events', () => {
  it('records a delivery without touching the address status', async () => {
    await handler(ses('Delivery') as never)
    expect(recorded).toHaveLength(1)
    expect((recorded[0] as { state: string }).state).toBe('delivered')
    expect(statuses).toHaveLength(0)
  })

  it('suppresses on a permanent bounce', async () => {
    await handler(ses('Bounce', perm) as never)
    expect((recorded[0] as { state: string }).state).toBe('bounced')
    expect(statuses[0]).toEqual(['T1', 'dead@example.com', 'bounced', 'General'])
  })

  // A full mailbox is emptied on Monday. Suppressing on one would cost a
  // customer every message thereafter for a problem that fixed itself.
  it('records a transient bounce but does NOT suppress', async () => {
    await handler(ses('Bounce', trans) as never)
    expect(recorded).toHaveLength(1)
    expect(statuses).toHaveLength(0)
  })

  it('suppresses on a complaint', async () => {
    await handler(ses('Complaint', {
      complaint: { complainedRecipients: [{ emailAddress: 'cross@example.com' }],
        complaintFeedbackType: 'abuse' },
    }) as never)
    expect(statuses[0]).toEqual(['T1', 'cross@example.com', 'complained', 'abuse'])
  })

  /*
   * The auto-brake (issue 134). One complaint is a misclick; several in a day
   * from one workspace is the thing that costs every OTHER workspace their
   * deliverability, which is why it acts without waiting for a human.
   */
  it('does not restrict a workspace over a single complaint', async () => {
    complaintCount = 1
    await handler(ses('Complaint', {
      complaint: { complainedRecipients: [{ emailAddress: 'cross@example.com' }] },
    }) as never)
    expect(restricted).toEqual([])
  })

  it('restricts sending once complaints pass the brake', async () => {
    complaintCount = 3
    await handler(ses('Complaint', {
      complaint: { complainedRecipients: [{ emailAddress: 'cross@example.com' }] },
    }) as never)
    expect(restricted).toHaveLength(1)
    expect(restricted[0].tenantId).toBe('T1')
    expect(restricted[0].reason).toContain('3')
  })

  /**
   * Restricting must never become suspending. The authorizer refuses a
   * suspended tenant outright, so suspension would lock the owner out of the
   * dashboard - including the screen that would tell them what happened.
   */
  it('restricts sending rather than suspending the account', async () => {
    complaintCount = 5
    await handler(ses('Complaint', {
      complaint: { complainedRecipients: [{ emailAddress: 'cross@example.com' }] },
    }) as never)
    const statusWrites = writes.filter((w) =>
      JSON.stringify(w).includes('suspended'))
    expect(statusWrites).toEqual([])
    expect(restricted).toHaveLength(1)
  })

  // Telling an owner their customer reported them as spam is a support
  // conversation and a grudge over what is usually a misclick.
  it('never emails anyone about a complaint', async () => {
    await handler(ses('Complaint', {
      complaint: { complainedRecipients: [{ emailAddress: 'cross@example.com' }] },
    }) as never)
    expect(sent).toHaveLength(0)
  })

  it('tells the owner when their OWN address bounces, because otherwise they just see no work', async () => {
    await handler(ses('Bounce', perm, {
      tenantId: ['T1'], refType: ['booking'], refId: ['B1'], audience: ['owner'],
    }) as never)
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('owner@example.com')
  })

  it('stays quiet when it was the customer who bounced', async () => {
    await handler(ses('Bounce', perm) as never)
    expect(sent).toHaveLength(0)
  })

  // The loop that would otherwise bounce a bounce notice forever.
  it('does not write to the address that just bounced', async () => {
    await handler(ses('Bounce', {
      bounce: { bounceType: 'Permanent',
        bouncedRecipients: [{ emailAddress: 'OWNER@example.com' }] },
    }, { tenantId: ['T1'], audience: ['owner'] }) as never)
    expect(sent).toHaveLength(0)
  })

  it('ignores untagged mail, which is Cognito and belongs to no tenant', async () => {
    await handler(ses('Bounce', perm, null) as never)
    expect(recorded).toHaveLength(0)
    expect(statuses).toHaveLength(0)
  })

  it('ignores an event type it does not model, rather than inventing a state', async () => {
    await handler(ses('Open') as never)
    await handler({ detail: {} } as never)
    await handler({} as never)
    expect(recorded).toHaveLength(0)
  })

  it('keys the log row so one query answers "did she get the quote?"', async () => {
    await handler(ses('Delivery') as never)
    expect(recorded[0]).toMatchObject({ tenantId: 'T1', messageId: 'M1', refKey: 'quote#Q1' })
  })

  it('survives the owner notice failing, so the suppression still lands', async () => {
    const core = await import('@makerbay/core')
    const spy = vi.spyOn(core, 'sendEmail').mockRejectedValueOnce(new Error('SES down'))
    await expect(handler(ses('Bounce', perm, {
      tenantId: ['T1'], audience: ['owner'],
    }) as never)).resolves.toBeUndefined()
    expect(statuses).toHaveLength(1)
    spy.mockRestore()
  })
})

/**
 * The write-back. Recording a bounce in a log nobody reads changes nothing:
 * the dashboard's "email failed" chip reads `notifyError` on the module row,
 * so unless the outcome lands there, a hard bounce still shows as sent -
 * which is the exact complaint issue 107 was filed about.
 */
describe('row write-back', () => {
  it('marks the quote so the dashboard chip can finally fire', async () => {
    await handler(ses('Bounce', perm) as never)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      TableName: 'makerbay-quotes',
      Key: { tenantId: 'T1', quoteId: 'Q1' },
      ExpressionAttributeValues: { ':e': 'bounced' },
    })
  })

  // The owner still wants to know it has not arrived, even though the
  // address survives and nothing is suppressed.
  it('marks a transient bounce differently, because it may still arrive', async () => {
    await handler(ses('Bounce', trans) as never)
    expect(writes[0]).toMatchObject({ ExpressionAttributeValues: { ':e': 'bounce_transient' } })
    expect(statuses).toHaveLength(0)
  })

  it('marks a complaint on the row too', async () => {
    await handler(ses('Complaint', {
      complaint: { complainedRecipients: [{ emailAddress: 'x@example.com' }] },
    }) as never)
    expect(writes[0]).toMatchObject({ ExpressionAttributeValues: { ':e': 'complained' } })
  })

  // Clearing an error nobody has seen yet hides the problem.
  it('never touches the row on a delivery', async () => {
    await handler(ses('Delivery') as never)
    expect(writes).toHaveLength(0)
  })

  it('routes each refType to its own table and key', async () => {
    await handler(ses('Bounce', perm, {
      tenantId: ['T1'], refType: ['booking'], refId: ['B1'], audience: ['customer'],
    }) as never)
    expect(writes[0]).toMatchObject({
      TableName: 'makerbay-bookings', Key: { tenantId: 'T1', bookingId: 'B1' },
    })
  })

  // A bounce for a deleted quote must not resurrect it as a stub containing
  // nothing but an error.
  it('refuses to create a row that is not there', async () => {
    await handler(ses('Bounce', perm) as never)
    expect(writes[0].ConditionExpression).toBe('attribute_exists(tenantId)')
  })

  it('skips a refType with no table wired rather than guessing', async () => {
    await handler(ses('Bounce', perm, {
      tenantId: ['T1'], refType: ['review'], refId: ['C1'], audience: ['customer'],
    }) as never)
    expect(writes).toHaveLength(0)
    // The suppression still happens; only the write-back is skipped.
    expect(statuses).toHaveLength(1)
  })

  it('skips the digest, whose refId matches no row', async () => {
    await handler(ses('Bounce', perm, {
      tenantId: ['T1'], refType: ['request'], refId: ['digest-R1'], audience: ['owner'],
    }) as never)
    expect(writes).toHaveLength(0)
  })
})

/**
 * The second door (issue 156). Resend posts a signed webhook; it must be
 * verified over the raw body, then become exactly the event the SES path
 * produces, so the rules above are tested once and hold for both.
 */
const { fromResend } = await import('./mail-events')

const signed = (payload: unknown, opts: { secret?: string; ts?: number; base64?: boolean } = {}) => {
  const body = JSON.stringify(payload)
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000))
  const key = Buffer.from((opts.secret ?? WEBHOOK_SECRET).slice(6), 'base64')
  const sig = createHmac('sha256', key).update(`msg_1.${ts}.${body}`).digest('base64')
  return {
    requestContext: { http: { method: 'POST', path: '/v1/mail/webhook' } },
    // Mixed header casing on purpose: API Gateway does not normalise it.
    headers: { 'Svix-Id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` },
    body: opts.base64 ? Buffer.from(body).toString('base64') : body,
    isBase64Encoded: opts.base64 === true,
  }
}

const resendBounce = {
  type: 'email.bounced',
  created_at: '2026-09-08T00:00:00.000Z',
  data: {
    email_id: 'em_9',
    from: 'Southside Plumbing <hello@send.makerbay.app>',
    to: ['dead@example.com'],
    subject: 'Your quote',
    bounce: { message: '550 no such user', subType: 'General', type: 'Permanent' },
    tags: { tenantId: 'T1', refType: 'quote', refId: 'Q1', audience: 'customer' },
  },
}

describe('resend webhook', () => {
  it('accepts a signed bounce and suppresses the address exactly like SES', async () => {
    const res = await handler(signed(resendBounce) as never)
    expect(res).toMatchObject({ statusCode: 200 })
    expect(recorded[0]).toMatchObject({
      tenantId: 'T1', messageId: 'em_9', state: 'bounced', to: 'dead@example.com',
      refKey: 'quote#Q1', bounceType: 'Permanent', bounceSubType: 'General', diagnostic: '550 no such user',
    })
    expect(statuses[0]).toEqual(['T1', 'dead@example.com', 'bounced', 'General'])
    expect(writes[0]).toMatchObject({ TableName: 'makerbay-quotes', Key: { tenantId: 'T1', quoteId: 'Q1' } })
  })

  it('rejects a bad signature before touching anything', async () => {
    const other = 'whsec_' + Buffer.from('somebody-else').toString('base64')
    const res = await handler(signed(resendBounce, { secret: other }) as never)
    expect(res).toMatchObject({ statusCode: 400 })
    expect(recorded).toHaveLength(0)
    expect(statuses).toHaveLength(0)
  })

  it('rejects a replay from outside the window', async () => {
    const res = await handler(signed(resendBounce, { ts: Math.floor(Date.now() / 1000) - 3600 }) as never)
    expect(res).toMatchObject({ statusCode: 400 })
    expect(recorded).toHaveLength(0)
  })

  // API Gateway hands a JSON body over base64-encoded when the content type
  // is not one it recognises as text. The signature is over the decoded
  // bytes, so decoding has to happen before verification, not after.
  it('verifies the decoded body when API Gateway base64-encodes it', async () => {
    const res = await handler(signed(resendBounce, { base64: true }) as never)
    expect(res).toMatchObject({ statusCode: 200 })
    expect(recorded).toHaveLength(1)
  })

  it('treats a complaint the same way, including the brake', async () => {
    complaintCount = 3
    await handler(signed({
      type: 'email.complained',
      data: {
        email_id: 'em_c', to: ['cross@example.com'],
        tags: { tenantId: 'T1', refType: 'review', refId: 'C1', audience: 'customer' },
      },
    }) as never)
    expect(statuses[0]).toEqual(['T1', 'cross@example.com', 'complained', undefined])
    expect(restricted).toHaveLength(1)
    expect(sent).toHaveLength(0)
  })

  it('reads a provider-side suppression as a permanent bounce, because the message did not go', async () => {
    await handler(signed({
      type: 'email.suppressed',
      data: {
        email_id: 'em_s', to: ['dead@example.com'],
        tags: { tenantId: 'T1', refType: 'quote', refId: 'Q3', audience: 'customer' },
      },
    }) as never)
    expect(statuses[0]).toEqual(['T1', 'dead@example.com', 'bounced', 'Suppressed'])
    expect(writes[0]).toMatchObject({ Key: { tenantId: 'T1', quoteId: 'Q3' }, ExpressionAttributeValues: { ':e': 'bounced' } })
  })

  it('records a send failure without suppressing an address it knows nothing about', async () => {
    await handler(signed({
      type: 'email.failed',
      data: {
        email_id: 'em_f', to: ['fine@example.com'], failed: { reason: 'reached_daily_quota' },
        tags: { tenantId: 'T1', refType: 'quote', refId: 'Q2', audience: 'customer' },
      },
    }) as never)
    expect(recorded[0]).toMatchObject({ state: 'rejected', diagnostic: 'reached_daily_quota' })
    expect(statuses).toHaveLength(0)
  })

  it('answers 200 to an event it does not model, so the provider stops retrying it', async () => {
    const res = await handler(signed({ type: 'email.opened', data: { email_id: 'em_o', to: ['x@example.com'] } }) as never)
    expect(res).toMatchObject({ statusCode: 200 })
    expect(recorded).toHaveLength(0)
  })

  it('still ignores untagged mail', async () => {
    await handler(signed({
      type: 'email.bounced',
      data: { email_id: 'em_u', to: ['x@example.com'], bounce: { type: 'Permanent' } },
    }) as never)
    expect(recorded).toHaveLength(0)
  })
})

describe('fromResend', () => {
  it('accepts tags as either an object or a name/value list', () => {
    const asObject = fromResend({ type: 'email.delivered', data: { email_id: 'a', to: ['x@y.z'], tags: { tenantId: 'T1' } } })
    const asList = fromResend({ type: 'email.delivered', data: { email_id: 'a', to: ['x@y.z'], tags: [{ name: 'tenantId', value: 'T1' }] } })
    expect(asObject?.mail?.tags).toEqual({ tenantId: ['T1'] })
    expect(asList?.mail?.tags).toEqual({ tenantId: ['T1'] })
  })

  it('maps every event it models onto an SES event type', () => {
    const cases: Array<[string, string]> = [
      ['email.sent', 'Send'], ['email.delivered', 'Delivery'], ['email.delivery_delayed', 'DeliveryDelay'],
      ['email.bounced', 'Bounce'], ['email.complained', 'Complaint'], ['email.failed', 'Reject'],
      ['email.suppressed', 'Bounce'],
    ]
    for (const [type, expected] of cases) {
      expect(fromResend({ type, data: { email_id: 'a', to: ['x@y.z'] } })?.eventType).toBe(expected)
    }
    expect(fromResend({ type: 'domain.created' })).toBeUndefined()
    expect(fromResend(undefined)).toBeUndefined()
  })
})
