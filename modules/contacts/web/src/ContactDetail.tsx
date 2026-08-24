import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Empty, Notice, Skeleton, api, explain, when } from '@makerbay/web-kit'
import type { Contact } from './ContactsList'

interface TimelineEvent {
  sk: string
  moduleId: string
  title: string
  body?: string
  href?: string
  at: string
}

interface Detail {
  contact: Contact & { note?: string }
  events: TimelineEvent[]
}

const STATUSES = ['new', 'contacted', 'active', 'won', 'lost']

export default function ContactDetail() {
  const { contactId = '' } = useParams()
  const navigate = useNavigate()
  const [data, setData] = useState<Detail | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ name: '', email: '', phone: '', status: 'new', note: '', tags: '' })
  const [entry, setEntry] = useState('')

  const load = useCallback(async () => {
    try {
      const r: Detail = await api('GET', `/v1/contacts/${contactId}`)
      setData(r)
      setForm({
        name: r.contact.name ?? '',
        email: r.contact.email ?? '',
        phone: r.contact.phone ?? '',
        status: r.contact.status,
        note: r.contact.note ?? '',
        tags: (r.contact.tags ?? []).join(', '),
      })
    } catch (e) {
      setError(explain(e))
    }
  }, [contactId])

  useEffect(() => { void load() }, [load])

  const run = async (fn: () => Promise<void>) => {
    setError(''); setNote(''); setBusy(true)
    try { await fn(); await load() } catch (e) { setError(explain(e)) } finally { setBusy(false) }
  }

  const save = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api('PATCH', `/v1/contacts/${contactId}`, {
        ...form,
        tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
      })
      setEditing(false)
      setNote('Saved.')
    })
  }

  // Status is the field people change most, so it gets a one-click path.
  const setStatus = (status: string) =>
    void run(async () => { await api('PATCH', `/v1/contacts/${contactId}`, { status }) })

  const addEntry = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api('POST', `/v1/contacts/${contactId}/events`, { title: entry.trim() })
      setEntry('')
    })
  }

  const remove = () => {
    if (!confirm('Delete this contact and their history? This cannot be undone.')) return
    void (async () => {
      setBusy(true)
      try {
        await api('DELETE', `/v1/contacts/${contactId}`)
        navigate('/contacts')
      } catch (e) {
        setError(explain(e))
        setBusy(false)
      }
    })()
  }

  if (error && !data) return (
    <>
      <p className="meta"><Link to="/contacts">← All contacts</Link></p>
      <h1>Contact</h1>
      <Notice tone="err">{error}</Notice>
    </>
  )

  if (!data) return (
    <>
      <p className="meta"><Link to="/contacts">← All contacts</Link></p>
      <h1>Contact</h1>
      <div className="card"><Skeleton rows={5} /></div>
    </>
  )

  const { contact, events } = data
  const title = contact.name || contact.email || contact.phone || 'Unnamed contact'

  return (
    <>
      <p className="meta"><Link to="/contacts">← All contacts</Link></p>
      <h1>{title}</h1>
      <p>Added {when(contact.createdAt)}{contact.source && contact.source !== 'manual' && ` from ${contact.source}`}.</p>

      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card">
        <div className="row">
          <h2 className="grow">Details</h2>
          {!editing && <button className="ghost" onClick={() => setEditing(true)}>Edit</button>}
        </div>

        {editing ? (
          <form onSubmit={save}>
            <div className="row">
              <div className="grow">
                <label htmlFor="d-name">Name</label>
                <input id="d-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="grow">
                <label htmlFor="d-status">Status</label>
                <select id="d-status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
            <div className="row">
              <div className="grow">
                <label htmlFor="d-email">Email</label>
                <input id="d-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="grow">
                <label htmlFor="d-phone">Phone</label>
                <input id="d-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
            </div>
            <label htmlFor="d-tags">Tags</label>
            <input id="d-tags" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })}
              placeholder="repeat customer, commercial" />
            <label htmlFor="d-note">Note</label>
            <textarea id="d-note" rows={3} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="Prefers a call before 9am. Gate code 4412." />
            <div className="mt row">
              <button disabled={busy}>Save changes</button>
              <button type="button" className="ghost" onClick={() => { setEditing(false); void load() }}>Cancel</button>
            </div>
          </form>
        ) : (
          <>
            <dl className="facts">
              <dt>Email</dt>
              <dd>{contact.email ? <a href={`mailto:${contact.email}`}>{contact.email}</a> : <span className="meta">none</span>}</dd>
              <dt>Phone</dt>
              <dd>{contact.phone ? <a href={`tel:${contact.phone}`}>{contact.phone}</a> : <span className="meta">none</span>}</dd>
              {contact.tags?.length ? <><dt>Tags</dt><dd>{contact.tags.join(' · ')}</dd></> : null}
              {contact.note ? <><dt>Note</dt><dd>{contact.note}</dd></> : null}
            </dl>

            <label>Status</label>
            <div className="row">
              {STATUSES.map((s) => (
                <button key={s} className={s === contact.status ? '' : 'ghost'} disabled={busy}
                  onClick={() => s !== contact.status && setStatus(s)}>
                  {s}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h2>History</h2>
        <p className="hint">
          Everything this person has done with you, newest first. Bookings, quotes and requests
          will appear here as you switch those modules on.
        </p>

        <form onSubmit={addEntry} className="row">
          <input className="grow" value={entry} onChange={(e) => setEntry(e.target.value)}
            placeholder="Add a note — called about the kitchen job" aria-label="Add a history note" />
          <button className="ghost" disabled={busy || entry.trim().length < 2}>Add</button>
        </form>

        {events.length === 0 ? (
          <Empty title="Nothing recorded yet">Add a note above, or wait for a module to log something.</Empty>
        ) : (
          <ol className="timeline mt">
            {events.map((ev) => (
              <li key={ev.sk}>
                <div className="row baseline">
                  <strong className="grow">{ev.href ? <Link to={ev.href}>{ev.title}</Link> : ev.title}</strong>
                  <span className="meta nowrap">{when(ev.at)}</span>
                </div>
                {ev.body && <p className="meta">{ev.body}</p>}
                {ev.moduleId !== 'contacts' && <span className="chip awaiting_upload">{ev.moduleId}</span>}
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="card">
        <h2>Delete contact</h2>
        <p>Removes this person and their whole history. Export first if you might want them back.</p>
        <button className="danger" onClick={remove} disabled={busy}>Delete contact</button>
      </div>
    </>
  )
}
