import { describe, expect, it } from 'vitest'
import { mayConfirm, newAction, type PendingAction } from './actions'

const ctx = (over: Record<string, unknown> = {}) =>
  ({ tenantId: 'T1', scopes: '*', entitlements: '', ...over }) as never

const action = (over: Partial<PendingAction> = {}): PendingAction => ({
  ...newAction({
    tenantId: 'T1',
    sessionId: 'S1',
    actionId: '01J000000000000000000000AA',
    tool: 'presence.write_page',
    proposed: { summary: 'Publish the page', params: {} },
    by: { id: 'agent-key', kind: 'apikey' },
    ttlSeconds: 600,
  }),
  ...over,
})

describe('mayConfirm', () => {
  it('lets the signed-in owner confirm an agent proposal', () => {
    const r = mayConfirm(action(), ctx({ userId: 'U1' }))
    expect(r.ok).toBe(true)
  })

  // The whole point of the card. Without this a setup delegation inside a
  // workspace could approve its own writes.
  it('refuses a key, even one that holds every scope', () => {
    const r = mayConfirm(action(), ctx({ keyId: 'K1' }))
    expect(r).toEqual({ ok: false, reason: 'requires_a_person' })
  })

  it('refuses a machine confirming its own proposal', () => {
    const r = mayConfirm(action({ proposedBy: 'K1', proposedByKind: 'apikey' }), ctx({ keyId: 'K1' }))
    expect(r).toEqual({ ok: false, reason: 'requires_a_person' })
  })

  it('refuses an expired card rather than executing a stale plan', () => {
    const stale = action({ expiresAt: Math.floor(Date.now() / 1000) - 1 })
    expect(mayConfirm(stale, ctx({ userId: 'U1' }))).toEqual({ ok: false, reason: 'expired' })
  })

  it('refuses an action already executed or declined, so a card is single use', () => {
    for (const status of ['executed', 'declined'] as const) {
      expect(mayConfirm(action({ status }), ctx({ userId: 'U1' })))
        .toEqual({ ok: false, reason: 'not_found' })
    }
  })

  it('refuses a missing action', () => {
    expect(mayConfirm(undefined, ctx({ userId: 'U1' }))).toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('newAction', () => {
  it('records who proposed it, which issue 97 existed because it did not', () => {
    const a = newAction({
      tenantId: 'T1', sessionId: 'S1', actionId: '01J000000000000000000000AA',
      tool: 't', proposed: { summary: 's', params: {} },
      by: { id: 'U1', kind: 'user' }, ttlSeconds: 600,
    })
    expect(a.proposedBy).toBe('U1')
    expect(a.proposedByKind).toBe('user')
    expect(a.status).toBe('proposed')
  })

  it('gives a job card a lifetime that survives the owner sleeping on it', () => {
    const chat = newAction({ tenantId: 'T1', sessionId: 'S', actionId: 'A', tool: 't',
      proposed: { summary: 's', params: {} }, by: { id: 'U1', kind: 'user' }, ttlSeconds: 600 })
    const job = newAction({ tenantId: 'T1', sessionId: 'S', actionId: 'A', tool: 't',
      proposed: { summary: 's', params: {} }, by: { id: 'U1', kind: 'user' }, ttlSeconds: 48 * 3600 })
    expect(job.expiresAt - chat.expiresAt).toBeGreaterThan(47 * 3600)
  })
})
