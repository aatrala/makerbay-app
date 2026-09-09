import { describe, expect, it } from 'vitest'
import { OFFER_AFTER, offerDue } from './passkeys'

describe('the fingerprint offer', () => {
  it('shows straight away to someone who has never said no', () => {
    expect(offerDue({ declined: false, codeSignIns: 1 })).toBe(true)
  })
  it('stays away after a no until the third code sign-in since', () => {
    expect(offerDue({ declined: true, codeSignIns: 1 })).toBe(false)
    expect(offerDue({ declined: true, codeSignIns: OFFER_AFTER - 1 })).toBe(false)
    expect(offerDue({ declined: true, codeSignIns: OFFER_AFTER })).toBe(true)
  })
})
