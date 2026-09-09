import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, explain, Notice, Skeleton, when, type Me } from '@makerbay/web-kit'

/**
 * Who is on the workspace (issue 158). Owners invite, remove and change
 * roles; members see the list. Every wall says what to do in the owner's
 * words, never "seat".
 */
interface Person {
  userId: string
  email: string | null
  role: 'owner' | 'member'
  notify: boolean
  createdAt: string
  lastSignIn: string | null
  you: boolean
}
interface Pending {
  invitationId: string
  email: string
  createdAt: string
  expiresAt: string
}
interface People {
  people: Person[]
  role: 'owner' | 'member'
  invitations?: Pending[]
  seats?: { tier: string; max: number; used: number; wall: string }
}

export default function PeopleCard({ me }: { me: Me }) {
  const [data, setData] = useState<People | null>(null)
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  const load = useCallback(() => api('GET', '/v1/core/people').then(setData).catch((e) => setError(explain(e))), [])
  useEffect(() => { void load() }, [load])

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key); setError(''); setNote('')
    try {
      await fn()
      if (done) setNote(done)
      await load()
    } catch (e) {
      setError(explain(e))
    } finally {
      setBusy('')
    }
  }

  const invite = (e: FormEvent) => {
    e.preventDefault()
    const to = email.trim()
    void run('invite', async () => {
      const r = await api('POST', '/v1/core/people/invitations', { email: to })
      setEmail('')
      setNote(r.sent
        ? `Invitation sent to ${to}. They sign in at app.makerbay.app with that address and it will be waiting. ${r.message ?? ''}`
        : `Invitation created for ${to}, but the email did not go out. Resend it from the list below.`)
    })
  }

  const remove = (p: Person) => {
    const who = p.email ?? 'this person'
    if (!window.confirm(`Remove ${who}? They will lose access within a few minutes. Their quotes and notes stay with the business.`)) return
    void run(p.userId, () => api('DELETE', `/v1/core/people/${p.userId}`), `${who} has been removed.`)
  }

  const setNotify = (p: Person, notify: boolean) =>
    void run(`n-${p.userId}`, () => api('PATCH', `/v1/core/people/${p.userId}`, { notify }))

  if (!data) {
    return (
      <div className="card">
        <h2>People</h2>
        {error ? <Notice tone="err">{error}</Notice> : <Skeleton rows={2} />}
      </div>
    )
  }

  const owner = data.role === 'owner'
  const full = data.seats ? data.seats.used >= data.seats.max : false

  return (
    <div className="card">
      <h2>People</h2>
      <p className="meta">
        Everyone here can see the diary, enquiries, quotes and customers. Only an owner can change
        billing, settings or who is on the workspace.
      </p>
      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="scroll-x">
        <table>
          <thead>
            <tr><th>Who</th><th>Role</th><th>Gets notifications</th><th>Last signed in</th>{owner && <th />}</tr>
          </thead>
          <tbody>
            {data.people.map((p) => (
              <tr key={p.userId}>
                <td>{p.email ?? p.userId}{p.you && <span className="meta"> (you)</span>}</td>
                <td>{p.role === 'owner' ? 'Owner' : 'Member'}</td>
                <td>
                  {(owner || p.you) ? (
                    <label className="row">
                      <input type="checkbox" checked={p.notify} disabled={busy !== ''}
                        onChange={(e) => setNotify(p, e.target.checked)} />
                      <span className="meta">{p.notify ? 'Yes' : 'No'}</span>
                    </label>
                  ) : (p.notify ? 'Yes' : 'No')}
                </td>
                <td className="meta">{p.lastSignIn ? when(p.lastSignIn) : 'Never'}</td>
                {owner && (
                  <td>
                    {!p.you && p.role === 'member' && (
                      <button className="ghost danger" disabled={busy !== ''} onClick={() => remove(p)}>
                        {busy === p.userId ? 'Removing…' : 'Remove'}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {owner && data.invitations && data.invitations.length > 0 && (
        <>
          <h3 className="mt">Waiting to join</h3>
          <div className="scroll-x">
            <table>
              <tbody>
                {data.invitations.map((i) => (
                  <tr key={i.invitationId}>
                    <td>{i.email}</td>
                    <td className="meta">invited {when(i.createdAt)}</td>
                    <td>
                      <button className="ghost" disabled={busy !== ''}
                        onClick={() => void run(i.invitationId, () => api('POST', `/v1/core/people/invitations/${i.invitationId}/resend`, {}), `Sent again to ${i.email}.`)}>
                        Resend
                      </button>{' '}
                      <button className="ghost" disabled={busy !== ''}
                        onClick={() => void run(`c-${i.invitationId}`, () => api('POST', `/v1/core/people/invitations/${i.invitationId}/cancel`, {}), `Invitation for ${i.email} cancelled.`)}>
                        Cancel
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {owner && (
        full ? (
          <Notice tone="warn">
            {data.seats?.wall}{data.seats?.tier === 'free' && <> Upgrade under <a href="/billing">Billing</a>.</>}
          </Notice>
        ) : (
          <form onSubmit={invite} className="mt">
            <label htmlFor="invite-email">Add someone</label>
            <div className="row">
              <input id="invite-email" className="grow" type="email" placeholder="their@email.com" value={email}
                onChange={(e) => setEmail(e.target.value)} required />
              <button disabled={busy !== '' || !email.includes('@')}>{busy === 'invite' ? 'Sending…' : 'Invite'}</button>
            </div>
            <p className="meta">
              They get an email saying you added them, then sign in at app.makerbay.app with that address and
              accept. No password, no link to click.
              {data.seats && <> {data.seats.max - data.seats.used} more can join on your plan.</>}
            </p>
          </form>
        )
      )}
      {!owner && me.user.role === 'member' && (
        <p className="meta mt">Ask {data.people.find((p) => p.role === 'owner')?.email ?? 'the owner'}, the owner, to add or remove people.</p>
      )}
    </div>
  )
}
