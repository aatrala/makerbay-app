import { describe, expect, it, vi } from 'vitest'

/**
 * The booking is stored BEFORE anyone is told (tester finding V4,
 * 2026-09-11). Between 2026-08-26 and 2026-09-11 the instant path wrote the
 * row only when the customer's confirmation email FAILED; the day Resend
 * started delivering, every no-deposit booking vanished while the customer
 * read "Booked". This pins the order: put, then mail, whatever the mail
 * does.
 */
vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }))
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: async () => ({ Items: [] }) }) },
  GetCommand: class {}, PutCommand: class {}, QueryCommand: class {},
  DeleteCommand: class {}, UpdateCommand: class {}, ScanCommand: class {},
}))
vi.mock('@aws-sdk/client-eventbridge', () => ({ EventBridgeClient: class {}, PutEventsCommand: class {} }))
vi.mock('@aws-sdk/client-sesv2', () => ({ SESv2Client: class {}, SendEmailCommand: class {} }))
vi.mock('@aws-sdk/client-pinpoint-sms-voice-v2', () => ({
  PinpointSMSVoiceV2Client: class {}, SendTextMessageCommand: class {},
}))
vi.mock('@aws-sdk/client-scheduler', () => ({
  SchedulerClient: class { async send() { return {} } },
  CreateScheduleCommand: class {}, DeleteScheduleCommand: class {},
}))

const calls: string[] = []
const TENANT = { tenantId: 'T1', slug: 'test-page', name: 'Test page', payoutsEnabled: false }

vi.mock('@makerbay/core', async (orig) => ({
  ...(await orig<typeof import('@makerbay/core')>()),
  getTenantBySlugOrAlias: async () => TENANT,
  getTenant: async () => TENANT,
  getTenantBrand: async () => ({ name: 'Test page' }),
  getEffectiveEntitlement: async () => ({ enabled: true, limits: {} }),
  upsertContact: async () => ({ contactId: 'C1', email: 'customer@example.com' }),
  appendContactEvent: async () => { calls.push('contactEvent') },
  sendEmail: async () => { calls.push('sendEmail'); return { sent: true } },
  emitUsage: async () => { calls.push('usage') },
  emitEvent: async () => undefined,
  ddb: { send: async () => ({ Items: [] }) },
}))

vi.mock('./db', async (orig) => {
  const real = await orig<typeof import('./db')>()
  return {
    ...real,
    getService: async () => ({
      tenantId: 'T1', serviceId: 'S1', name: 'E2E Test Service', durationMinutes: 30,
      bufferMinutes: 15, priceCents: 12000, active: true,
    }),
    getBookingConfig: async () => ({ tenantId: 'T1', ...real.DEFAULT_BOOKING_CONFIG }),
    countBookingsThisMonth: async () => 0,
    bookingsBetween: async () => [],
    putBooking: async (row: { status: string; bookingId: string }) => { calls.push(`putBooking:${row.status}`) },
  }
})

const { handler } = await import('./handler')

const event = (body: unknown) => ({
  rawPath: '/v1/public/booking',
  requestContext: { http: { method: 'POST' } },
  body: JSON.stringify(body),
}) as never

describe('a booking without a deposit', () => {
  it('is stored before the confirmation email goes out, and stays stored when the email succeeds', async () => {
    calls.length = 0
    const startsAt = new Date(Date.now() + 3 * 86_400_000)
    startsAt.setUTCHours(1, 0, 0, 0) // 11:00 in Sydney, inside the default Mon-Fri hours on most days
    // Walk forward to a weekday so the slot check passes.
    while ([0, 6].includes(new Date(startsAt.getTime() + 10 * 3600_000).getUTCDay())) {
      startsAt.setUTCDate(startsAt.getUTCDate() + 1)
    }
    const res = await handler(event({
      slug: 'test-page', serviceId: 'S1', startsAt: startsAt.toISOString(),
      name: 'E2E Workflow Customer', email: 'customer@example.com',
    })) as { statusCode: number; body: string }

    expect(res.statusCode, res.body).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ emailed: true })
    const put = calls.indexOf('putBooking:confirmed')
    const mail = calls.indexOf('sendEmail')
    expect(put, `calls were ${calls.join(', ')}`).toBeGreaterThanOrEqual(0)
    expect(mail).toBeGreaterThan(put)
  })
})
