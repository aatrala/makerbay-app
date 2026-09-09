import { describe, expect, it } from 'vitest'
import type { CleanedWhere } from 'better-auth/adapters'
import { internalAttrs } from './keys'
import { matches, plan, sortRows } from './where'

/**
 * The planner decides which DynamoDB read happens; getting it wrong is
 * either a full model read on every login (slow, costly) or a key lookup
 * that silently misses rows (wrong). Both are invisible in a mocked test of
 * the adapter itself, so the planner is tested on its own.
 */
const w = (field: string, value: CleanedWhere['value'], rest: Partial<CleanedWhere> = {}): CleanedWhere => ({
  field,
  value,
  operator: 'eq',
  connector: 'AND',
  mode: 'sensitive',
  ...rest,
})

describe('plan', () => {
  it('reads by id with one GetItem and nothing left to filter', () => {
    expect(plan('user', [w('id', 'U1')])).toEqual({ kind: 'get', pk: 'user#U1', residue: [] })
  })

  it('reads a set of ids with BatchGet', () => {
    const p = plan('session', [w('id', ['S1', 'S2'], { operator: 'in' })])
    expect(p).toMatchObject({ kind: 'batchGet', pks: ['session#S1', 'session#S2'] })
  })

  it('finds a user by email on the email index, lowercased', () => {
    const p = plan('user', [w('email', 'Joe@Example.com', { mode: 'insensitive' })])
    expect(p).toMatchObject({ kind: 'query', index: 'gsi1', pk: 'user#email#joe@example.com', residue: [] })
  })

  it('keeps a case-sensitive email clause as a residue so casing is still checked', () => {
    const p = plan('user', [w('email', 'Joe@Example.com')])
    expect(p).toMatchObject({ kind: 'query', index: 'gsi1', pk: 'user#email#joe@example.com' })
    expect((p as { residue: CleanedWhere[] }).residue).toHaveLength(1)
  })

  it('finds a session by token on the first index and by user on the second', () => {
    expect(plan('session', [w('token', 'tok')])).toMatchObject({ kind: 'query', index: 'gsi1', pk: 'session#token#tok' })
    expect(plan('session', [w('userId', 'U1')])).toMatchObject({ kind: 'query', index: 'gsi2', pk: 'session#userId#U1' })
  })

  it('needs both halves of a composite key, and leaves the rest as residue', () => {
    const p = plan('account', [w('providerId', 'cognito'), w('accountId', 'sub-1'), w('scope', 'openid')])
    expect(p).toMatchObject({ kind: 'query', index: 'gsi1', pk: 'account#providerId#cognito#accountId#sub-1' })
    expect((p as { residue: CleanedWhere[] }).residue.map((r) => r.field)).toEqual(['scope'])
  })

  it('falls back to the model partition when only half a composite key is present', () => {
    expect(plan('account', [w('providerId', 'cognito')])).toMatchObject({ kind: 'query', index: 'gsi3', pk: 'account' })
  })

  it('falls back to the model partition for an OR chain, keeping every clause', () => {
    const p = plan('user', [w('id', 'U1'), w('email', 'x@y.z', { connector: 'OR' })])
    expect(p).toMatchObject({ kind: 'query', index: 'gsi3', pk: 'user' })
    expect((p as { residue: CleanedWhere[] }).residue).toHaveLength(2)
  })

  it('reads the whole model when there is no where', () => {
    expect(plan('verification', [])).toEqual({ kind: 'query', index: 'gsi3', pk: 'verification', residue: [] })
    expect(plan('verification', undefined)).toMatchObject({ kind: 'query', index: 'gsi3' })
  })

  it('does not use an index for a non-eq operator on a key field', () => {
    expect(plan('user', [w('email', 'joe', { operator: 'starts_with' })])).toMatchObject({ index: 'gsi3' })
    expect(plan('user', [w('email', null)])).toMatchObject({ index: 'gsi3' })
  })
})

describe('matches', () => {
  const row = { id: 'U1', name: 'Joe Bloggs', age: 41, email: 'Joe@Example.com', deleted: null }

  it('chains connectors left to right like the memory adapter', () => {
    // (name = 'x' AND age = 41) OR id = 'U1'  →  true via the OR
    expect(matches(row, [w('name', 'x'), w('age', 41), w('id', 'U1', { connector: 'OR' })])).toBe(true)
    // (name = 'x' OR id = 'U1') AND age = 40  →  false
    expect(matches(row, [w('name', 'x'), w('id', 'U1', { connector: 'OR' }), w('age', 40)])).toBe(false)
  })

  it('treats eq null as "missing or null" and ne null as "present"', () => {
    expect(matches(row, [w('deleted', null)])).toBe(true)
    expect(matches(row, [w('missing', null)])).toBe(true)
    expect(matches(row, [w('deleted', null, { operator: 'ne' })])).toBe(false)
    expect(matches(row, [w('name', null, { operator: 'ne' })])).toBe(true)
  })

  it('does not read a pattern as a regex', () => {
    expect(matches({ name: 'a.*b' }, [w('name', '.*', { operator: 'contains' })])).toBe(true)
    expect(matches({ name: 'axxb' }, [w('name', '.*', { operator: 'contains' })])).toBe(false)
  })

  it('honours insensitive mode on strings only', () => {
    expect(matches(row, [w('email', 'JOE@example.COM', { mode: 'insensitive' })])).toBe(true)
    expect(matches(row, [w('email', 'JOE@example.COM')])).toBe(false)
    expect(matches(row, [w('age', 41, { mode: 'insensitive' })])).toBe(true)
  })

  it('compares ISO date strings lexicographically, which is chronologically', () => {
    const r = { at: '2026-09-09T10:00:00.000Z' }
    expect(matches(r, [w('at', '2026-09-09T09:00:00.000Z', { operator: 'gt' })])).toBe(true)
    expect(matches(r, [w('at', '2026-09-09T11:00:00.000Z', { operator: 'lt' })])).toBe(true)
  })
})

describe('sortRows', () => {
  it('sorts strings, numbers and nulls stably in both directions', () => {
    const rows = [{ n: 2 }, { n: null }, { n: 1 }]
    expect(sortRows(rows, { field: 'n', direction: 'asc' }).map((r) => r.n)).toEqual([null, 1, 2])
    expect(sortRows(rows, { field: 'n', direction: 'desc' }).map((r) => r.n)).toEqual([2, 1, null])
  })
})

describe('internalAttrs', () => {
  it('writes the key, the model partition, and every index the row can fill', () => {
    const attrs = internalAttrs('account', {
      id: 'A1', providerId: 'cognito', accountId: 'sub-1', userId: 'U1', createdAt: '2026-09-09T00:00:00.000Z',
    })
    expect(attrs).toMatchObject({
      pk: 'account#A1',
      _model: 'account',
      gsi1pk: 'account#providerId#cognito#accountId#sub-1',
      gsi2pk: 'account#userId#U1',
      gsi3pk: 'account',
      gsi3sk: '2026-09-09T00:00:00.000Z',
    })
  })

  it('clears an index the row no longer fills, so an update cannot leave a stale pointer', () => {
    const attrs = internalAttrs('session', { id: 'S1', token: 'tok' })
    expect(attrs.gsi1pk).toBe('session#token#tok')
    expect(attrs.gsi2pk).toBeUndefined()
  })

  it('derives a TTL an hour after expiry for expiring models only', () => {
    const at = '2026-09-09T00:00:00.000Z'
    expect(internalAttrs('session', { id: 'S1', expiresAt: at }).ttl).toBe(Math.floor(Date.parse(at) / 1000) + 3600)
    expect(internalAttrs('user', { id: 'U1', expiresAt: at }).ttl).toBeUndefined()
  })
})
