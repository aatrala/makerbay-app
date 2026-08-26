import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, Route } from 'react-router-dom'
import {
  Empty,
  Notice,
  Skeleton,
  api,
  explain,
  type DashboardModule,
  type Me,
} from '@makerbay/web-kit'

interface Service {
  serviceId: string
  name: string
  description?: string
  durationMinutes: number
  bufferMinutes: number
  priceCents?: number
  depositCents?: number
  active: boolean
}

interface Booking {
  bookingId: string
  /** 'block' rows are the owner's own reserved time, not a customer. */
  kind?: 'block'
  contactId: string
  serviceName: string
  startsAt: string
  endsAt: string
  status: 'confirmed' | 'cancelled' | 'completed' | 'noshow' | 'pending_payment'
  name?: string
  email?: string
  phone?: string
  note?: string
  notifyError?: string
  depositCents?: number
  depositPaidAt?: string
}

const WEEKDAYS = [
  ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'],
  ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday'],
] as const

const dt = (iso: string, timezone: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso))

function Diary() {
  const [bookings, setBookings] = useState<Booking[] | null>(null)
  const [timezone, setTimezone] = useState('UTC')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [block, setBlock] = useState({ date: '', from: '', to: '', reason: '' })
  const [blockOpen, setBlockOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await api('GET', '/v1/booking/bookings')
      setBookings(r.bookings)
      setTimezone(r.timezone)
    } catch (e) { setError(explain(e)); setBookings([]) }
  }, [])

  useEffect(() => { void load() }, [load])

  const setStatus = (id: string, status: string, label: string) => {
    if (status === 'cancelled' && !confirm(`Cancel ${label}? The customer is emailed.`)) return
    void (async () => {
      setBusy(true); setError('')
      try { await api('PATCH', `/v1/booking/bookings/${id}`, { status }); await load() }
      catch (e) { setError(explain(e)) } finally { setBusy(false) }
    })()
  }

  const addBlock = (e: FormEvent) => {
    e.preventDefault()
    void (async () => {
      setBusy(true); setError('')
      try {
        await api('POST', '/v1/booking/blocks', block)
        setBlock({ date: '', from: '', to: '', reason: '' }); setBlockOpen(false)
        await load()
      } catch (e) { setError(explain(e)) } finally { setBusy(false) }
    })()
  }

  const removeBlock = (id: string) => {
    void (async () => {
      setBusy(true); setError('')
      try { await api('DELETE', `/v1/booking/blocks/${id}`); await load() }
      catch (e) { setError(explain(e)) } finally { setBusy(false) }
    })()
  }

  // pending_payment rows are sub-35-minute transients (a held slot whose
  // deposit is being paid) - showing them would only invite confusion.
  const upcoming = (bookings ?? []).filter(
    (b) => b.status === 'confirmed' && new Date(b.startsAt).getTime() > Date.now(),
  )
  const past = (bookings ?? []).filter(
    (b) => b.kind !== 'block' && b.status !== 'pending_payment' &&
      (b.status !== 'confirmed' || new Date(b.startsAt).getTime() <= Date.now()),
  )

  const table = (rows: Booking[], showActions: boolean) => (
    <div className="scroll-x">
      <table>
        <thead>
          <tr><th>When</th><th>Who</th><th>What</th><th>Status</th>{showActions && <th><span className="visually-hidden">Actions</span></th>}</tr>
        </thead>
        <tbody>
          {rows.map((b) => b.kind === 'block' ? (
            <tr key={b.bookingId}>
              <td className="nowrap">{dt(b.startsAt, timezone)} – {new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(b.endsAt))}</td>
              <td><span className="meta">your time</span></td>
              <td>{b.serviceName}</td>
              <td><span className="chip awaiting_upload">blocked</span></td>
              {showActions && (
                <td className="nowrap">
                  <button className="ghost" disabled={busy} onClick={() => removeBlock(b.bookingId)}>Remove</button>
                </td>
              )}
            </tr>
          ) : (
            <tr key={b.bookingId}>
              <td className="nowrap">{dt(b.startsAt, timezone)}</td>
              <td>
                <Link to={`/contacts/${b.contactId}`}>{b.name || b.email || b.phone}</Link>
                {b.note && <div className="meta trunc">{b.note}</div>}
                {b.notifyError && <div className="meta warn-text">confirmation email not sent</div>}
              </td>
              <td>{b.serviceName}</td>
              <td>
                <span className={`chip ${b.status === 'confirmed' ? 'ready' : b.status === 'cancelled' ? 'failed' : 'awaiting_upload'}`}>
                  {b.status}
                </span>
                {b.depositPaidAt && b.depositCents != null && (
                  <>{' '}<span className="chip ready" title={`Deposit paid ${new Date(b.depositPaidAt).toLocaleDateString('en-GB')}`}>
                    ${(b.depositCents / 100).toFixed(0)} paid
                  </span></>
                )}
              </td>
              {showActions && (
                <td className="nowrap">
                  <button className="ghost" disabled={busy}
                    onClick={() => setStatus(b.bookingId, 'completed', b.serviceName)}>Done</button>{' '}
                  <button className="danger" disabled={busy}
                    onClick={() => setStatus(b.bookingId, 'cancelled', `${b.serviceName} for ${b.name ?? 'this customer'}`)}>
                    Cancel
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  return (
    <>
      <h1>Diary</h1>
      <p>Everything booked, in {timezone.replace('_', ' ')}.</p>
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card">
        <div className="row">
          <h2 className="grow">Coming up</h2>
          <button className="ghost" onClick={() => setBlockOpen(!blockOpen)}>
            {blockOpen ? 'Close' : 'Block out time'}
          </button>
        </div>
        {blockOpen && (
          <form onSubmit={addBlock} className="mt">
            <div className="row">
              <div>
                <label htmlFor="blk-date">Date</label>
                <input id="blk-date" type="date" required value={block.date}
                  onChange={(e) => setBlock({ ...block, date: e.target.value })} />
              </div>
              <div>
                <label htmlFor="blk-from">From</label>
                <input id="blk-from" type="time" required value={block.from}
                  onChange={(e) => setBlock({ ...block, from: e.target.value })} />
              </div>
              <div>
                <label htmlFor="blk-to">To</label>
                <input id="blk-to" type="time" required value={block.to}
                  onChange={(e) => setBlock({ ...block, to: e.target.value })} />
              </div>
              <div className="grow">
                <label htmlFor="blk-reason">Reason (only you see it)</label>
                <input id="blk-reason" value={block.reason} placeholder="School run"
                  onChange={(e) => setBlock({ ...block, reason: e.target.value })} />
              </div>
              <button disabled={busy}>Block</button>
            </div>
            <p className="meta">Customers cannot book over blocked time. Times are in {timezone.replace('_', ' ')}.</p>
          </form>
        )}
        {!bookings ? <Skeleton rows={4} /> : upcoming.length === 0 ? (
          <Empty title="Nothing booked yet"
            action={<Link className="btn" to="/booking/services">Set up what you offer</Link>}>
            Once you have a service and your hours, share your booking link and customers can book
            themselves in.
          </Empty>
        ) : table(upcoming, true)}
      </div>

      {past.length > 0 && (
        <div className="card">
          <h2>Past and cancelled</h2>
          {table(past.slice(0, 40), false)}
        </div>
      )}
    </>
  )
}

function Services({ me }: { me: Me }) {
  const [services, setServices] = useState<Service[] | null>(null)
  const [form, setForm] = useState({ name: '', durationMinutes: '60', bufferMinutes: '0', priceCents: '', depositDollars: '' })
  const [payoutsEnabled, setPayoutsEnabled] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const bookingUrl = `https://chat.makerbay.app/booking?slug=${me.tenant?.slug ?? ''}`

  const load = useCallback(async () => {
    try { setServices((await api('GET', '/v1/booking/services')).services) }
    catch (e) { setError(explain(e)); setServices([]) }
  }, [])
  useEffect(() => {
    void load()
    void api('GET', '/v1/booking/config')
      .then((r) => setPayoutsEnabled(r.payoutsEnabled === true))
      .catch(() => {})
  }, [load])

  const run = async (fn: () => Promise<void>) => {
    setError(''); setNote(''); setBusy(true)
    try { await fn(); await load() } catch (e) { setError(explain(e)) } finally { setBusy(false) }
  }

  const add = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api('POST', '/v1/booking/services', {
        name: form.name,
        durationMinutes: Number(form.durationMinutes),
        bufferMinutes: Number(form.bufferMinutes),
        priceCents: form.priceCents ? Math.round(Number(form.priceCents) * 100) : undefined,
        depositCents: form.depositDollars ? Math.round(Number(form.depositDollars) * 100) : undefined,
      })
      setForm({ name: '', durationMinutes: '60', bufferMinutes: '0', priceCents: '', depositDollars: '' })
      setNote('Added.')
    })
  }

  const toggle = (s: Service) =>
    void run(async () => { await api('PATCH', `/v1/booking/services/${s.serviceId}`, { active: !s.active }) })

  const remove = (s: Service) => {
    if (!confirm(`Remove "${s.name}"? Bookings already made keep their details.`)) return
    void run(async () => { await api('DELETE', `/v1/booking/services/${s.serviceId}`) })
  }

  return (
    <>
      <h1>Services</h1>
      <p>What customers can book, and how long each one takes.</p>

      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card">
        <h2>Your booking page</h2>
        <p>Share this anywhere. No website needed.</p>
        <div className="row">
          <input className="grow" readOnly value={bookingUrl} onFocus={(e) => e.target.select()} aria-label="Your booking page" />
          <a className="btn" href={bookingUrl} target="_blank" rel="noopener">Open</a>
        </div>
      </div>

      <div className="card">
        <h2>Add a service</h2>
        <form onSubmit={add}>
          <div className="row">
            <div className="grow">
              <label htmlFor="s-name">Name</label>
              <input id="s-name" value={form.name} required
                onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Standard cut" />
            </div>
            <div>
              <label htmlFor="s-dur">Minutes</label>
              <input id="s-dur" type="number" min={5} max={480} value={form.durationMinutes}
                onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })} className="narrow" />
            </div>
            <div>
              <label htmlFor="s-buf">Buffer</label>
              <input id="s-buf" type="number" min={0} max={240} value={form.bufferMinutes}
                onChange={(e) => setForm({ ...form, bufferMinutes: e.target.value })} className="narrow" />
            </div>
            <div>
              <label htmlFor="s-price">Price</label>
              <input id="s-price" type="number" min={0} step="0.01" value={form.priceCents}
                onChange={(e) => setForm({ ...form, priceCents: e.target.value })} className="narrow" placeholder="45.00" />
            </div>
            <div>
              <label htmlFor="s-dep">Deposit</label>
              <input id="s-dep" type="number" min={0} step="0.01" value={form.depositDollars}
                onChange={(e) => setForm({ ...form, depositDollars: e.target.value })}
                className="narrow" placeholder="50.00" disabled={!payoutsEnabled}
                title={payoutsEnabled ? 'Paid up front to secure the booking' : 'Set up payments first'} />
            </div>
          </div>
          <p className="meta">
            Buffer is the gap held after each appointment — travel, clean-down, notes.
            {payoutsEnabled
              ? ' A deposit is paid up front to secure the slot (held up to 35 minutes while a customer pays); it kills no-shows.'
              : <> Deposits need payments — <Link to="/payments">set up Get paid first</Link>.</>}
          </p>
          <div className="mt"><button disabled={busy || !form.name}>Add service</button></div>
        </form>
      </div>

      <div className="card">
        <h2>What you offer</h2>
        {!services ? <Skeleton rows={3} /> : services.length === 0 ? (
          <Empty title="No services yet">Add one above and your booking page comes to life.</Empty>
        ) : (
          <div className="scroll-x">
            <table>
              <thead><tr><th>Service</th><th>Length</th><th>Price</th><th>Deposit</th><th>Bookable</th><th /></tr></thead>
              <tbody>
                {services.map((s) => (
                  <tr key={s.serviceId}>
                    <td>{s.name}</td>
                    <td className="nowrap">{s.durationMinutes} min{s.bufferMinutes ? ` +${s.bufferMinutes}` : ''}</td>
                    <td>{s.priceCents != null ? `$${(s.priceCents / 100).toFixed(2)}` : <span className="meta">—</span>}</td>
                    <td>{s.depositCents ? `$${(s.depositCents / 100).toFixed(2)}` : <span className="meta">—</span>}</td>
                    <td>
                      <button className={s.active ? 'ghost' : 'ghost'} disabled={busy} onClick={() => toggle(s)}>
                        <span className={`chip ${s.active ? 'ready' : 'awaiting_upload'}`}>{s.active ? 'yes' : 'paused'}</span>
                      </button>
                    </td>
                    <td className="nowrap"><button className="danger" disabled={busy} onClick={() => remove(s)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

function Hours() {
  const [config, setConfig] = useState<any>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api('GET', '/v1/booking/config').then((r) => setConfig(r.config)).catch((e) => setError(explain(e)))
  }, [])

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try { setConfig((await api('PUT', '/v1/booking/config', config)).config); setSaved(true) }
    catch (e) { setError(explain(e)) } finally { setBusy(false) }
  }

  const setWindow = (day: string, field: 'from' | 'to', value: string) => {
    const hours = { ...(config.hours ?? {}) }
    const existing = hours[day]?.[0] ?? { from: '09:00', to: '17:00' }
    hours[day] = [{ ...existing, [field]: value }]
    setConfig({ ...config, hours }); setSaved(false)
  }

  const toggleDay = (day: string, on: boolean) => {
    const hours = { ...(config.hours ?? {}) }
    if (on) hours[day] = [{ from: '09:00', to: '17:00' }]
    else delete hours[day]
    setConfig({ ...config, hours }); setSaved(false)
  }

  return (
    <>
      <h1>Hours</h1>
      <p>When you work. Slots are only ever offered inside these windows.</p>

      {saved && <Notice tone="ok" onClose={() => setSaved(false)}>Saved.</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card">
        {!config ? <Skeleton rows={7} /> : (
          <form onSubmit={save}>
            <label htmlFor="tz">Timezone</label>
            <input id="tz" value={config.timezone} className="narrow"
              onChange={(e) => { setConfig({ ...config, timezone: e.target.value }); setSaved(false) }} />
            <p className="meta">
              An IANA name such as <code>Australia/Sydney</code>. Every slot is worked out in your
              timezone, so a customer booking from overseas still sees your hours.
            </p>

            <label>Opening hours</label>
            {WEEKDAYS.map(([key, label]) => {
              const open = Boolean(config.hours?.[key]?.length)
              return (
                <div key={key} className="row day-edit">
                  <label className="pick day-name">
                    <input type="checkbox" checked={open} onChange={(e) => toggleDay(key, e.target.checked)} />
                    <span>{label}</span>
                  </label>
                  {open && (
                    <>
                      <input type="time" className="narrow" value={config.hours[key][0].from}
                        onChange={(e) => setWindow(key, 'from', e.target.value)} aria-label={`${label} opens`} />
                      <span className="meta">to</span>
                      <input type="time" className="narrow" value={config.hours[key][0].to}
                        onChange={(e) => setWindow(key, 'to', e.target.value)} aria-label={`${label} closes`} />
                    </>
                  )}
                </div>
              )
            })}

            <div className="row mt">
              <div className="grow">
                <label htmlFor="lead">Shortest notice (hours)</label>
                <input id="lead" type="number" min={0} max={720} value={config.leadTimeHours}
                  onChange={(e) => { setConfig({ ...config, leadTimeHours: Number(e.target.value) }); setSaved(false) }} />
              </div>
              <div className="grow">
                <label htmlFor="horizon">How far ahead (days)</label>
                <input id="horizon" type="number" min={1} max={365} value={config.horizonDays}
                  onChange={(e) => { setConfig({ ...config, horizonDays: Number(e.target.value) }); setSaved(false) }} />
              </div>
            </div>

            <label htmlFor="b-notify">Send booking notifications to</label>
            <input id="b-notify" type="email" value={config.notifyEmail ?? ''}
              onChange={(e) => { setConfig({ ...config, notifyEmail: e.target.value }); setSaved(false) }} />

            <label htmlFor="b-intro">What customers see above the times</label>
            <input id="b-intro" value={config.intro ?? ''}
              onChange={(e) => { setConfig({ ...config, intro: e.target.value }); setSaved(false) }} />

            <div className="mt"><button disabled={busy}>{busy ? 'Saving…' : 'Save hours'}</button></div>
          </form>
        )}
      </div>
    </>
  )
}

export const bookingDashboard: DashboardModule = {
  id: 'booking',
  label: 'Bookings',
  nav: [
    { to: '/booking/diary', label: 'Diary' },
    { to: '/booking/services', label: 'Services' },
    { to: '/booking/hours', label: 'Hours' },
  ],
  routes: ({ me }) => (
    <>
      <Route path="/booking/diary" element={<Diary />} />
      <Route path="/booking/services" element={<Services me={me} />} />
      <Route path="/booking/hours" element={<Hours />} />
    </>
  ),
}

export default bookingDashboard
