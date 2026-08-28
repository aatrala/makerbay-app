import { describe, expect, it } from 'vitest'
import { handler } from './cognito-message'

/**
 * The failure mode worth testing for is total: if the code placeholder does
 * not survive into the response exactly as Cognito handed it over, every
 * person who asks for a reset gets an email with no usable code in it and
 * cannot get into their own account.
 */

const ev = (triggerSource: string, codeParameter = '{####}') => ({
  triggerSource,
  request: { codeParameter, userAttributes: { email: 'sam@example.com' } },
  response: {} as { emailMessage?: string; emailSubject?: string; smsMessage?: string },
})

const SOURCES = [
  'CustomMessage_SignUp',
  'CustomMessage_ResendCode',
  'CustomMessage_ForgotPassword',
  'CustomMessage_VerifyUserAttribute',
  'CustomMessage_UpdateUserAttribute',
  'CustomMessage_Authentication',
]

describe('cognito custom message', () => {
  it('answers every code-bearing trigger, not just sign-up', async () => {
    for (const src of SOURCES) {
      const r = await handler(ev(src) as never)
      expect(r.response.emailMessage, src).toBeTruthy()
      expect(r.response.emailSubject, src).toBeTruthy()
    }
  })

  it('puts the code placeholder in both the subject and the body', async () => {
    for (const src of SOURCES) {
      const r = await handler(ev(src) as never)
      expect(r.response.emailSubject, src).toContain('{####}')
      expect(r.response.emailMessage, src).toContain('{####}')
      expect(r.response.smsMessage, src).toContain('{####}')
    }
  })

  // Documented as the value to substitute. Hardcoding '{####}' would work
  // until the day it did not, and then it would lock people out silently.
  it('uses whatever placeholder Cognito supplied, not a hardcoded one', async () => {
    const r = await handler(ev('CustomMessage_ForgotPassword', '%%CODE%%') as never)
    expect(r.response.emailSubject).toContain('%%CODE%%')
    expect(r.response.emailMessage).toContain('%%CODE%%')
    expect(r.response.emailMessage).not.toContain('{####}')
  })

  it('sends the reset wording for a reset and the sign-up wording for a sign-up', async () => {
    const reset = await handler(ev('CustomMessage_ForgotPassword') as never)
    const signup = await handler(ev('CustomMessage_SignUp') as never)
    expect(reset.response.emailSubject).toContain('reset')
    expect(signup.response.emailSubject).not.toContain('reset')
    expect(reset.response.emailMessage).toContain('password')
  })

  // The realistic attack on a sole trader is a phone call, not a spoofed
  // email, so this line has to survive into every code email we send.
  it('carries the warning into every message', async () => {
    for (const src of SOURCES) {
      expect(r_(await handler(ev(src) as never)), src).toContain('phone, text or email')
    }
  })

  it('never puts a link in a code email', async () => {
    for (const src of SOURCES) {
      const html = (await handler(ev(src) as never)).response.emailMessage ?? ''
      // The footer's own postal/support text is plain; an <a href> is not.
      expect(html.match(/<a\s[^>]*href="https?:/i), src).toBeNull()
    }
  })

  it('leaves admin-created users alone rather than sending an invite with no username', async () => {
    const r = await handler(ev('CustomMessage_AdminCreateUser') as never)
    expect(r.response.emailMessage).toBeUndefined()
    expect(r.response.emailSubject).toBeUndefined()
  })

  it('ignores a trigger source it does not know', async () => {
    const r = await handler({ triggerSource: 'PreSignUp_SignUp', request: {}, response: {} } as never)
    expect(r.response.emailMessage).toBeUndefined()
  })

  it('keeps the SMS inside the 140 character limit once the code is substituted', async () => {
    for (const src of SOURCES) {
      const sms = ((await handler(ev(src, '123456') as never)).response.smsMessage ?? '')
      expect(sms.length, `${src}: ${sms}`).toBeLessThanOrEqual(140)
    }
  })

  // Cognito rejects an email message over 20,000 UTF-8 characters.
  it('stays well inside the message size limit', async () => {
    for (const src of SOURCES) {
      const html = (await handler(ev(src) as never)).response.emailMessage ?? ''
      expect(Buffer.byteLength(html, 'utf8'), src).toBeLessThan(20_000)
    }
  })
})

const r_ = (r: { response: { emailMessage?: string } }) =>
  (r.response.emailMessage ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
