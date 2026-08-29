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

vi.mock('@makerbay/core', () => ({
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
