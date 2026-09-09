import { describe, expect, it, vi } from 'vitest'

// The template renderer reaches into core for its colour helpers, so those
// stay real; only the send is stubbed.
vi.mock('@makerbay/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@makerbay/core')>()),
  sendEmail: vi.fn(async () => ({ sent: true })),
}))

const { otpMessage } = await import('./otp-mail')

/**
 * The code has to land in the subject line and in both bodies, and the
 * placeholder Cognito used to fill must never survive into a real message.
 */
describe('otpMessage', () => {
  it('puts the code in the subject and both bodies with no placeholder left', () => {
    const m = otpMessage('sign-in', '482913')
    expect(m.subject).toBe('482913 is your MakerBay sign-in code')
    expect(m.text).toContain('482913')
    expect(m.html).toContain('482913')
    for (const part of [m.subject, m.text, m.html]) expect(part).not.toContain('{####}')
  })

  it('uses the verification wording for sign-up verification and the reset wording for resets', () => {
    expect(otpMessage('email-verification', '111111').subject).toBe('111111 is your MakerBay code')
    expect(otpMessage('forget-password', '222222').subject).toBe('222222 is your MakerBay reset code')
  })

  it('never includes a link, because a code email with a button is the phishing template', () => {
    const m = otpMessage('sign-in', '482913')
    expect(m.html).not.toMatch(/<a\s/i)
    expect(m.text).not.toMatch(/https?:\/\//)
  })
})
