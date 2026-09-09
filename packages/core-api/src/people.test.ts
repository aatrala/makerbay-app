import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The rules that decide who may be on a workspace (issue 158). Each is a
 * money or trust rule: the seat wall is what makes Trade worth paying for,
 * the invitation match on the session email is what stops an id in a URL
 * being a capability, and the exit path is what makes "remove" mean it.
 */

type Row = Record<string, unknown>
const users = new Map<string, Row>()
const invitations = new Map<string, Row>()
const tenants = new Map<string, Row>()
const sent: Array<{ to: string; subject: string; html: string; text: string }> = []
const revoked: string[] = []
const audits: Row[] = []
let tier = 'free'
let emptyWorkspace = true

vi.mock('@makerbay/auth/sessions', () => ({
  revokeUserSessions: async (id: string) => { revoked.push(id); return 1 },
  lastSignIn: async () => '2026-09-08T00:00:00.000Z',
}))

vi.mock('@makerbay/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@makerbay/core')>()
  return {
    ...real,
    getUser: async (id: string) => users.get(id),
    getTenant: async (id: string) => tenants.get(id),
    listTenantUsers: async (t: string) => [...users.values()].filter((u) => u.tenantId === t),
    addUser: async (row: Row) => { if (users.has(row.userId as string)) return 'exists'; users.set(row.userId as string, row); return 'added' },
    removeUser: async (id: string) => { users.delete(id) },
    updateUser: async (id: string, patch: Row) => { users.set(id, { ...users.get(id), ...patch }) },
    workspaceTier: async () => tier,
    createInvitation: async (i: Row) => {
      const row = { ...i, invitationId: `01INV${String(invitations.size).padStart(21, '0')}`, status: 'pending',
        createdAt: '2026-09-09T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', ttl: 0 }
      invitations.set(row.invitationId, row)
      return row
    },
    getInvitation: async (_t: string, id: string) => invitations.get(id),
    listTenantInvitations: async (t: string) => [...invitations.values()].filter((i) => i.tenantId === t && i.status === 'pending'),
    listInvitationsForEmail: async (e: string) => [...invitations.values()].filter((i) => i.email === e.toLowerCase() && i.status === 'pending'),
    settleInvitation: async (_t: string, id: string, status: string) => {
      const i = invitations.get(id); if (!i || i.status !== 'pending') return false; i.status = status; return true
    },
    extendInvitation: async (_t: string, id: string) => invitations.get(id),
    isEmptyWorkspace: async () => emptyWorkspace,
    setTenantStatus: async (id: string, status: string) => { tenants.set(id, { ...tenants.get(id), status }) },
    sendEmail: async (m: { to: string; subject: string; html: string; text: string }) => { sent.push(m); return { sent: true } },
    recordAudit: async (a: Row) => { audits.push(a) },
  }
})

const { invite, acceptInvitation, removePerson, leaveWorkspace, listPeople, patchPerson } = await import('./people')

const ctx = (userId: string, email: string) => ({ userId, email, tenantId: '', scopes: '*', entitlements: '{}' })
const ev = (body: unknown = {}) => ({ body: JSON.stringify(body) }) as never
const parse = (r: unknown) => JSON.parse((r as { body: string }).body)
const status = (r: unknown) => (r as { statusCode: number }).statusCode

beforeEach(() => {
  users.clear(); invitations.clear(); tenants.clear(); sent.length = 0; revoked.length = 0; audits.length = 0
  tier = 'free'; emptyWorkspace = true
  tenants.set('T1', { tenantId: 'T1', name: 'Southside Plumbing', slug: 'southside', plan: 'free', status: 'active' })
  users.set('OWNER', { userId: 'OWNER', email: 'joe@example.com', tenantId: 'T1', role: 'owner', createdAt: '2026-08-01T00:00:00.000Z' })
})

describe('invite', () => {
  it('creates the invitation and sends an email with no link in it', async () => {
    const r = await invite(ctx('OWNER', 'joe@example.com'), ev({ email: 'Sam@Example.com' }))
    expect(status(r)).toBe(201)
    expect(parse(r).invitation).toMatchObject({ email: 'sam@example.com', role: 'member' })
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('sam@example.com')
    expect(sent[0].subject).toBe('Southside Plumbing has added you to MakerBay')
    expect(sent[0].html).not.toMatch(/<a\s/i)
    expect(sent[0].text).not.toMatch(/https?:\/\//)
    expect(sent[0].text).toContain('app.makerbay.app')
  })

  it('is owner-only', async () => {
    users.set('SAM', { userId: 'SAM', email: 'sam@example.com', tenantId: 'T1', role: 'member', createdAt: '2026-09-01T00:00:00.000Z' })
    expect(status(await invite(ctx('SAM', 'sam@example.com'), ev({ email: 'x@example.com' })))).toBe(403)
  })

  it('stops at the wall: two people on Free, counting invitations already out', async () => {
    expect(status(await invite(ctx('OWNER', 'joe@example.com'), ev({ email: 'sam@example.com' })))).toBe(201)
    const r = await invite(ctx('OWNER', 'joe@example.com'), ev({ email: 'third@example.com' }))
    expect(status(r)).toBe(403)
    expect(parse(r)).toMatchObject({ error: 'seat_limit', message: 'Free includes two people. Trade lets you add up to three, from $29 a month.' })
    expect(sent).toHaveLength(1)
  })

  it('lets Trade have three', async () => {
    tier = 'trade'
    expect(status(await invite(ctx('OWNER', 'joe@example.com'), ev({ email: 'a@example.com' })))).toBe(201)
    expect(status(await invite(ctx('OWNER', 'joe@example.com'), ev({ email: 'b@example.com' })))).toBe(201)
    expect(status(await invite(ctx('OWNER', 'joe@example.com'), ev({ email: 'c@example.com' })))).toBe(403)
  })

  it('never says "refused" about an address that already has a workspace', async () => {
    const r = await invite(ctx('OWNER', 'joe@example.com'), ev({ email: 'sam@example.com' }))
    expect(parse(r).message).toContain('If that address already has its own workspace')
  })

  it('refuses a second invitation to the same address and an invitation to a current member', async () => {
    await invite(ctx('OWNER', 'joe@example.com'), ev({ email: 'sam@example.com' }))
    expect(parse(await invite(ctx('OWNER', 'joe@example.com'), ev({ email: 'SAM@example.com' }))).error).toBe('already_invited')
    expect(parse(await invite(ctx('OWNER', 'joe@example.com'), ev({ email: 'joe@example.com' }))).error).toBe('already_member')
  })
})

describe('accept', () => {
  it('joins the workspace only for the address that was invited', async () => {
    await invite(ctx('OWNER', 'joe@example.com'), ev({ email: 'sam@example.com' }))
    const id = [...invitations.keys()][0]
    expect(status(await acceptInvitation(ctx('EVE', 'eve@example.com'), id, ev()))).toBe(404)
    const r = await acceptInvitation(ctx('SAM', 'sam@example.com'), id, ev())
    expect(status(r)).toBe(200)
    expect(users.get('SAM')).toMatchObject({ tenantId: 'T1', role: 'member', notify: true, invitedBy: 'OWNER' })
    expect(invitations.get(id)?.status).toBe('accepted')
    expect(audits.some((a) => a.action === 'people.joined')).toBe(true)
  })

  it('explains, rather than joining, when the person already runs a workspace with activity in it', async () => {
    tenants.set('T2', { tenantId: 'T2', name: 'Sam Electrics', slug: 'sam', plan: 'free', status: 'active' })
    users.set('SAM', { userId: 'SAM', email: 'sam@example.com', tenantId: 'T2', role: 'owner', createdAt: '2026-08-01T00:00:00.000Z' })
    emptyWorkspace = false
    await invite(ctx('OWNER', 'joe@example.com'), ev({ email: 'sam@example.com' }))
    const id = [...invitations.keys()][0]
    const r = await acceptInvitation(ctx('SAM', 'sam@example.com'), id, ev())
    expect(status(r)).toBe(409)
    expect(parse(r)).toMatchObject({ error: 'has_workspace', emptyWorkspace: false, workspaceName: 'Sam Electrics' })
    expect(users.get('SAM')?.tenantId).toBe('T2')
  })

  it('closes an empty workspace and joins when asked to', async () => {
    tenants.set('T2', { tenantId: 'T2', name: 'Sam Electrics', slug: 'sam', plan: 'free', status: 'active' })
    users.set('SAM', { userId: 'SAM', email: 'sam@example.com', tenantId: 'T2', role: 'owner', createdAt: '2026-08-01T00:00:00.000Z' })
    await invite(ctx('OWNER', 'joe@example.com'), ev({ email: 'sam@example.com' }))
    const id = [...invitations.keys()][0]
    const first = await acceptInvitation(ctx('SAM', 'sam@example.com'), id, ev())
    expect(parse(first)).toMatchObject({ error: 'has_workspace', emptyWorkspace: true })
    const r = await acceptInvitation(ctx('SAM', 'sam@example.com'), id, ev({ closeExisting: true }))
    expect(status(r)).toBe(200)
    expect(tenants.get('T2')?.status).toBe('suspended')
    expect(users.get('SAM')).toMatchObject({ tenantId: 'T1', role: 'member' })
    expect(revoked).toContain('SAM')
  })
})

describe('leaving and removal', () => {
  beforeEach(() => {
    users.set('SAM', { userId: 'SAM', email: 'sam@example.com', tenantId: 'T1', role: 'member', createdAt: '2026-09-01T00:00:00.000Z' })
  })

  it('removal drops the row, ends every session and tells the person', async () => {
    const r = await removePerson(ctx('OWNER', 'joe@example.com'), 'SAM')
    expect(status(r)).toBe(200)
    expect(users.has('SAM')).toBe(false)
    expect(revoked).toEqual(['SAM'])
    expect(sent[0]).toMatchObject({ to: 'sam@example.com', subject: 'You no longer have access to Southside Plumbing' })
  })

  it('a member cannot remove anyone, and an owner cannot be removed without being demoted first', async () => {
    expect(status(await removePerson(ctx('SAM', 'sam@example.com'), 'OWNER'))).toBe(403)
    users.set('OWNER2', { userId: 'OWNER2', email: 'o2@example.com', tenantId: 'T1', role: 'owner', createdAt: '2026-09-01T00:00:00.000Z' })
    expect(parse(await removePerson(ctx('OWNER', 'joe@example.com'), 'OWNER2')).error).toBe('owner_cannot_be_removed')
  })

  it('the last owner cannot leave or be demoted', async () => {
    expect(parse(await leaveWorkspace(ctx('OWNER', 'joe@example.com'))).error).toBe('last_owner')
    expect(parse(await patchPerson(ctx('OWNER', 'joe@example.com'), 'OWNER', ev({ role: 'member' }))).error).toBe('last_owner')
  })

  it('a member can leave, and can silence their own notifications but nobody else\'s', async () => {
    expect(status(await patchPerson(ctx('SAM', 'sam@example.com'), 'SAM', ev({ notify: false })))).toBe(200)
    expect(users.get('SAM')?.notify).toBe(false)
    expect(status(await patchPerson(ctx('SAM', 'sam@example.com'), 'OWNER', ev({ notify: false })))).toBe(403)
    expect(status(await leaveWorkspace(ctx('SAM', 'sam@example.com')))).toBe(200)
    expect(users.has('SAM')).toBe(false)
    expect(sent[0].subject).toBe('You have left Southside Plumbing')
  })
})

describe('listing', () => {
  it('shows a member the people but not the invitations or the seat count', async () => {
    users.set('SAM', { userId: 'SAM', email: 'sam@example.com', tenantId: 'T1', role: 'member', createdAt: '2026-09-01T00:00:00.000Z' })
    await invite(ctx('OWNER', 'joe@example.com'), ev({ email: 'third@example.com' })).catch(() => undefined)
    const asOwner = parse(await listPeople(ctx('OWNER', 'joe@example.com')))
    const asMember = parse(await listPeople(ctx('SAM', 'sam@example.com')))
    expect(asOwner.people.map((p: { email: string }) => p.email)).toEqual(['joe@example.com', 'sam@example.com'])
    expect(asOwner.seats).toMatchObject({ tier: 'free', max: 2 })
    expect(asMember.people).toHaveLength(2)
    expect(asMember.invitations).toBeUndefined()
    expect(asMember.seats).toBeUndefined()
  })
})
