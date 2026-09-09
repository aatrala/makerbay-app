import { describe, expect, it } from 'vitest'
import { internalAttrs } from './adapter/keys'
// @ts-expect-error - a plain script, imported for its pure item builder.
import { itemsFor } from '../../../scripts/migrate-cognito-users.mjs'

/**
 * The migration script duplicates the adapter's item shape because it is a
 * plain .mjs file. This is the test that keeps the copy honest: whatever
 * the script writes must be exactly what the adapter would have written.
 */
describe('migrate-cognito-users', () => {
  const user = { userId: 'sub-123', email: 'Joe@Example.com', tenantId: 'T1', role: 'owner', createdAt: '2026-01-02T03:04:05.000Z' }
  const [u, marker, a] = itemsFor(user) as Array<Record<string, unknown>>

  it('writes the user with the Cognito sub as its id and the adapter\'s exact attributes', () => {
    const expected = { id: 'sub-123', email: 'Joe@Example.com', emailVerified: true, name: 'Joe', createdAt: user.createdAt, updatedAt: user.createdAt }
    expect(u).toEqual({ ...expected, ...internalAttrs('user', expected) })
  })

  it('writes the email uniqueness marker the adapter checks on create', () => {
    expect(marker).toEqual({ pk: 'unique#user#email#joe@example.com', _model: 'unique', userId: 'sub-123' })
  })

  it('links the Cognito account by provider and sub, keyed exactly as the adapter queries it', () => {
    const expected = { id: 'sub-123', accountId: 'sub-123', providerId: 'cognito', userId: 'sub-123', createdAt: user.createdAt, updatedAt: user.createdAt }
    expect(a).toEqual({ ...expected, ...internalAttrs('account', expected) })
    expect(a.gsi1pk).toBe('account#providerId#cognito#accountId#sub-123')
  })
})
