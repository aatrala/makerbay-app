import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Owner mail about a workspace event reaches everyone on the workspace who
 * wants it (issue 158) - and nothing else does. A sign-in code fanning out
 * to the partner would be a security bug; a booking notice not fanning out
 * would be the "seat that does nothing" the product review warned about.
 */
const delivered: Array<{ to: string; subject: string }> = []
let recipients: string[] = []

vi.mock('./mail', () => ({
  activeMailProvider: () => 'resend',
  deliver: async (m: { to: string; subject: string }) => { delivered.push(m); return { ok: true } },
}))
vi.mock('./maillog', () => ({ emailBlocked: async () => false }))
vi.mock('./unsubscribe', () => ({ unsubTokenFor: async () => undefined, unsubUrl: () => '' }))
vi.mock('./people', () => ({
  notificationRecipients: async (_t: string, preferred?: string) =>
    [...new Set([preferred ?? '', ...recipients].filter((e) => e.includes('@')))],
}))

const { sendEmail } = await import('./notify')

beforeEach(() => {
  delivered.length = 0
  recipients = ['joe@example.com', 'partner@example.com']
})

const ref = { tenantId: 'T1', moduleId: 'booking', refType: 'booking' as const, refId: 'B1' }

describe('sendEmail fan-out', () => {
  it('sends a workspace event to the configured address and every person who wants it', async () => {
    const r = await sendEmail({ to: 'diary@example.com', audience: 'owner', subject: 'New booking', text: 'x', ref })
    expect(r.sent).toBe(true)
    expect(delivered.map((d) => d.to).sort()).toEqual(['diary@example.com', 'joe@example.com', 'partner@example.com'])
  })

  it('reaches the people even when the module has no address configured', async () => {
    const r = await sendEmail({ to: '', audience: 'owner', subject: 'New enquiry', text: 'x', ref })
    expect(r.sent).toBe(true)
    expect(delivered.map((d) => d.to).sort()).toEqual(['joe@example.com', 'partner@example.com'])
  })

  it('never fans out a message with no workspace event behind it', async () => {
    await sendEmail({ to: 'someone@example.com', audience: 'owner', subject: '123456 is your code', text: 'x' })
    expect(delivered.map((d) => d.to)).toEqual(['someone@example.com'])
  })

  it('never fans out customer or staff mail', async () => {
    await sendEmail({
      to: 'homeowner@example.com', audience: 'customer', fromName: 'Southside', replyTo: 'joe@example.com',
      subject: 'Your quote', text: 'x', ref: { ...ref, refType: 'quote', refId: 'Q1' },
    }).catch(() => undefined)
    expect(delivered.filter((d) => d.to !== 'homeowner@example.com')).toHaveLength(0)
  })

  it('falls back to the configured address if the people lookup fails', async () => {
    const people = await import('./people')
    const spy = vi.spyOn(people, 'notificationRecipients').mockRejectedValueOnce(new Error('ddb down'))
    await sendEmail({ to: 'diary@example.com', audience: 'owner', subject: 'New booking', text: 'x', ref })
    expect(delivered.map((d) => d.to)).toEqual(['diary@example.com'])
    spy.mockRestore()
  })
})
