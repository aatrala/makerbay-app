import { describe, expect, it } from 'vitest'
import { passkeyChanged } from './passkeys'

describe('passkey emails', () => {
  const added = passkeyChanged({ action: 'added', deviceName: 'iPhone', when: 'on Tuesday at 2:15pm' })
  const removed = passkeyChanged({ action: 'removed', deviceName: 'Windows PC', when: 'just now' })

  it('carry no link, like every other security email', () => {
    for (const m of [added, removed]) {
      expect(m.html).not.toMatch(/href="https?:/)
      expect(m.text).not.toMatch(/https?:\/\//)
    }
  })

  it('name the device and say where the list is', () => {
    expect(added.text).toContain('"iPhone" was added')
    expect(removed.text).toContain('"Windows PC" was removed')
    for (const m of [added, removed]) {
      expect(m.text).toContain('app.makerbay.app')
      expect(m.text).toContain('Your account')
      expect(m.text).toContain('support@makerbay.app')
    }
  })

  it('never say passkey in the subject or heading', () => {
    for (const m of [added, removed]) {
      expect(m.subject.toLowerCase()).not.toContain('passkey')
    }
  })
})
