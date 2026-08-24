import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { API_BASE, Empty, Notice, Skeleton, api, explain, when } from '@makerbay/web-kit'

export interface Contact {
  contactId: string
  name?: string
  email?: string
  phone?: string
  status: string
  tags?: string[]
  source?: string
  createdAt: string
  lastActivityAt?: string
}

const STATUS_CHIP: Record<string, string> = {
  new: 'processing',
  contacted: 'awaiting_upload',
  active: 'processing',
  won: 'ready',
  lost: 'failed',
}

export default function ContactsList() {
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [statuses, setStatuses] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', email: '', phone: '' })
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async (append = false, from?: string) => {
    const params = new URLSearchParams()
    if (status) params.set('status', status)
    if (search.trim()) params.set('search', search.trim())
    if (from) params.set('cursor', from)
    try {
      const r = await api('GET', `/v1/contacts${params.toString() ? `?${params}` : ''}`)
      setContacts((prev) => (append && prev ? [...prev, ...r.contacts] : r.contacts))
      setCursor(r.cursor)
      if (r.statuses) setStatuses(r.statuses)
    } catch (e) {
      setError(explain(e))
      setContacts([])
    }
  }, [status, search])

  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => { void load() }, search ? 300 : 0)
    return () => clearTimeout(t)
  }, [load, search])

  const run = async (fn: () => Promise<void>) => {
    setError(''); setNote(''); setBusy(true)
    try { await fn(); await load() } catch (e) { setError(explain(e)) } finally { setBusy(false) }
  }

  const add = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api('POST', '/v1/contacts', form)
      setForm({ name: '', email: '', phone: '' })
      setAdding(false)
      setNote('Contact added.')
    })
  }

  const importFile = (file: File) =>
    void run(async () => {
      const csv = await file.text()
      const r = await api('POST', '/v1/contacts/import', { csv })
      const parts = [
        `${r.created} added`,
        r.merged ? `${r.merged} matched an existing contact` : '',
        r.skipped ? `${r.skipped} skipped` : '',
      ].filter(Boolean)
      setNote(`${parts.join(', ')}.${r.problems?.length ? ` ${r.problems.join(' ')}` : ''}`)
      if (fileRef.current) fileRef.current.value = ''
    })

  // The export route returns a file, so it needs the token on a raw fetch.
  const exportCsv = () =>
    void run(async () => {
      const token = localStorage.getItem('mb.idToken')
      const r = await fetch(`${API_BASE}/v1/contacts/export`, {
        headers: { authorization: `Bearer ${token}` },
      })
      if (!r.ok) throw new Error('export_failed')
      const url = URL.createObjectURL(await r.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = `contacts-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
      setNote('Exported. Check your downloads.')
    })

  const filtering = Boolean(status || search.trim())

  return (
    <>
      <h1>Contacts</h1>
      <p>
        Everyone your business has dealt with, in one list. Your other modules add to it as
        customers arrive, so it stays current without data entry.
      </p>

      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      {adding && (
        <div className="card">
          <h2>New contact</h2>
          <form onSubmit={add}>
            <div className="row">
              <div className="grow">
                <label htmlFor="c-name">Name</label>
                <input id="c-name" value={form.name} autoFocus
                  onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Jane Cooper" />
              </div>
              <div className="grow">
                <label htmlFor="c-email">Email</label>
                <input id="c-email" type="email" value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="jane@example.com" />
              </div>
              <div className="grow">
                <label htmlFor="c-phone">Phone</label>
                <input id="c-phone" value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+61 400 000 000" />
              </div>
            </div>
            <p className="meta">Any one of the three is enough. Email or phone lets us match them to future bookings and quotes.</p>
            <div className="mt row">
              <button disabled={busy || !(form.name || form.email || form.phone)}>Add contact</button>
              <button type="button" className="ghost" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        <div className="row">
          <input className="grow" placeholder="Search name, email, phone or notes" value={search}
            onChange={(e) => setSearch(e.target.value)} aria-label="Search contacts" />
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status" className="narrow">
            <option value="">All statuses</option>
            {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {!adding && <button onClick={() => setAdding(true)}>New contact</button>}
        </div>

        <div className="row mt">
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="grow"
            onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])}
            disabled={busy} aria-label="Import contacts from CSV" />
          <button className="ghost" onClick={exportCsv} disabled={busy || !contacts?.length}>Export CSV</button>
        </div>
        <p className="meta">
          Import a list from anywhere with name, email or phone columns. Anyone already here is
          matched rather than duplicated. Export whenever you like — a customer list you cannot
          take with you is not really yours.
        </p>

        {!contacts ? <div className="mt"><Skeleton rows={5} /></div> : contacts.length === 0 ? (
          filtering ? (
            <Empty title="Nothing matches that"
              action={<button className="ghost" onClick={() => { setSearch(''); setStatus('') }}>Clear filters</button>}>
              Try a shorter search, or a different status.
            </Empty>
          ) : (
            <Empty title="No contacts yet"
              action={<button onClick={() => setAdding(true)}>Add your first contact</button>}>
              Add one by hand, or import the list you already keep in a spreadsheet. As you switch
              on Requests, Bookings and Quotes, they will fill this in for you.
            </Empty>
          )
        ) : (
          <>
            <div className="scroll-x mt">
              <table>
                <thead>
                  <tr><th>Name</th><th>Contact</th><th>Status</th><th>Last activity</th></tr>
                </thead>
                <tbody>
                  {contacts.map((c) => (
                    <tr key={c.contactId}>
                      <td>
                        <Link to={`/contacts/${c.contactId}`}>{c.name || c.email || c.phone}</Link>
                        {c.tags?.length ? <div className="meta trunc">{c.tags.join(' · ')}</div> : null}
                      </td>
                      <td>
                        {c.email && <div className="trunc">{c.email}</div>}
                        {c.phone && <div className="meta">{c.phone}</div>}
                        {!c.email && !c.phone && <span className="meta">no contact details</span>}
                      </td>
                      <td><span className={`chip ${STATUS_CHIP[c.status] ?? 'awaiting_upload'}`}>{c.status}</span></td>
                      <td className="nowrap">{when(c.lastActivityAt ?? c.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {cursor && (
              <div className="mt">
                <button className="ghost" disabled={busy} onClick={() => void load(true, cursor)}>
                  Load more
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
