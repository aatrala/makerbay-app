import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, Route, useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  Empty,
  Notice,
  QrBlock,
  Skeleton,
  api,
  explain,
  when,
  type DashboardModule,
  type Me,
} from '@makerbay/web-kit'

interface PriceItem {
  itemId: string
  description: string
  unit: string
  unitCents: number
  active: boolean
}

interface Line {
  description: string
  unit: string
  quantity: number
  unitCents: number
  totalCents: number
}

interface Quote {
  quoteId: string
  number: number
  /** Server-composed document label (SP-Q-001); the client never builds it. */
  label?: string
  contactId: string
  customerName?: string
  customerEmail?: string
  customerPhone?: string
  lines: Line[]
  subtotalCents: number
  taxCents: number
  totalCents: number
  currency: string
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'expired' | 'superseded'
  validUntil: string
  notes?: string
  terms?: string
  notifyError?: string
  /** Set once an invoice exists for this quote - one invoice per quote. */
  invoiceId?: string
  createdAt: string
  /**
   * Whether the customer has actually opened it (issue 118). Counted by the
   * API when the page asks for the document, never at the CDN - a link
   * preview bot fetches the shell the instant the message is sent, and a
   * dashboard that says "opened" before the customer touched it is worse
   * than one that says nothing.
   */
  viewCount?: number
  firstViewedAt?: string
  lastViewedAt?: string
}

interface Invoice {
  invoiceId: string
  number: number
  label?: string
  quoteId?: string
  contactId?: string
  customerName?: string
  customerEmail?: string
  lines: Line[]
  subtotalCents: number
  taxCents: number
  totalCents: number
  currency: string
  notes?: string
  paymentInstructions?: string
  status: 'draft' | 'sent' | 'paid' | 'void'
  dueAt: string
  createdAt: string
  sentAt?: string
  paidAt?: string
}

const invoiceLabel = (i: Pick<Invoice, 'number' | 'label'>) =>
  i.label ?? `INV-${String(i.number).padStart(3, '0')}`

/** "due in 3d" / "12d overdue": cash flow at a glance (issue 61). */
const aging = (i: Pick<Invoice, 'status' | 'dueAt'>) => {
  if (i.status !== 'sent') return null
  const days = Math.floor((Date.now() - new Date(i.dueAt).getTime()) / 86_400_000)
  if (days > 0) return <span className="chip failed">{days}d overdue</span>
  if (days > -4) return <span className="chip warn">due in {-days || 0}d</span>
  return <span className="meta">due {when(i.dueAt)}</span>
}

/**
 * Rendered in the locale that treats this currency as local, so a London
 * electrician sees "£99.00" rather than "GBP 99.00" on their own quote
 * (issue 114). Duplicated from packages/core/money rather than imported
 * because this bundle must not pull in the AWS SDK that the core barrel
 * carries; the table below is the same one.
 */
const CASH_LOCALE: Record<string, string> = {
  AUD: 'en-AU', NZD: 'en-NZ', GBP: 'en-GB', USD: 'en-US', CAD: 'en-CA',
  EUR: 'en-IE', INR: 'en-IN', SGD: 'en-SG', ZAR: 'en-ZA', AED: 'en-AE',
}
const cash = (cents: number, currency = 'AUD') => {
  const code = String(currency ?? 'AUD').toUpperCase()
  try {
    return new Intl.NumberFormat(CASH_LOCALE[code] ?? 'en', {
      style: 'currency', currency: code,
    }).format(cents / 100)
  } catch {
    return `${code} ${(cents / 100).toFixed(2)}`
  }
}

/** The server expires lazily on read; lists apply the same rule client-side. */
const quoteStatus = (q: Pick<Quote, 'status' | 'validUntil'>): Quote['status'] =>
  q.status === 'sent' && new Date(q.validUntil).getTime() < Date.now() ? 'expired' : q.status

/** "expires in 2d": chase the customer before the price lapses (issue 72). */
const quoteAging = (q: Pick<Quote, 'status' | 'validUntil'>) => {
  if (quoteStatus(q) !== 'sent') return null
  const days = Math.ceil((new Date(q.validUntil).getTime() - Date.now()) / 86_400_000)
  if (days <= 3) return <span className="chip warn">expires in {days}d</span>
  return null
}

const emailFailedChip = (row: { notifyError?: string }) =>
  row.notifyError ? <span className="chip failed" title={row.notifyError}>email failed</span> : null

const STATUS_CHIP: Record<string, string> = {
  draft: 'awaiting_upload', sent: 'processing', accepted: 'ready',
  declined: 'failed', expired: 'failed', superseded: 'failed',
  paid: 'ready', void: 'failed',
}

function QuotesList() {
  const [quotes, setQuotes] = useState<Quote[] | null>(null)
  const [all, setAll] = useState<Quote[]>([])
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      // "expired" is derived, not stored, so the server filter can never
      // match it - that tab filters the full list client-side instead.
      const serverStatus = status && status !== 'expired' ? status : ''
      const r = await api('GET', `/v1/quotes${serverStatus ? `?status=${serverStatus}` : ''}`)
      const rows: Quote[] = r.quotes ?? []
      setQuotes(status === 'expired' ? rows.filter((q) => quoteStatus(q) === 'expired') : rows)
      if (!serverStatus) setAll(rows)
      else void api('GET', '/v1/quotes').then((x) => setAll(x.quotes ?? [])).catch(() => {})
    }
    catch (e) { setError(explain(e)); setQuotes([]) }
  }, [status])
  useEffect(() => { void load() }, [load])

  // The pipeline in one line: how much is waiting on an answer, how much
  // is won but not yet invoiced (issue 61). Invoiced quotes leave the
  // second number - otherwise it counts money already billed (issue 72).
  const strip = (['sent', 'accepted'] as const).map((st) => {
    const rows = all.filter((q) => quoteStatus(q) === st && !(st === 'accepted' && q.invoiceId))
    return { st, n: rows.length, cents: rows.reduce((sum, q) => sum + q.totalCents, 0), currency: rows[0]?.currency }
  }).filter((x) => x.n > 0)

  return (
    <>
      <h1>Quotes</h1>
      <p>Price a job, send a link, get an answer. No PDFs, no accounting software.</p>
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      {strip.length > 0 && (
        <div className="statrow" style={{ marginBottom: 10 }}>
          {strip.map((x) => (
            <div className="stat" key={x.st}>
              <b>{cash(x.cents, x.currency)}</b>
              <span>{x.st === 'sent' ? `awaiting answer (${x.n})` : `accepted, to invoice (${x.n})`}</span>
            </div>
          ))}
        </div>
      )}

      <div className="tabs">
        {['', 'draft', 'sent', 'accepted', 'declined', 'expired'].map((s) => (
          <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>
            {s === '' ? 'All' : s}
          </button>
        ))}
      </div>

      <div className="card">
        <div className="row">
          <span className="grow" />
          <Link className="btn" to="/quotes/new">New quote</Link>
        </div>

        {!quotes ? <div className="mt"><Skeleton rows={4} /></div> : quotes.length === 0 ? (
          <Empty title={status ? 'Nothing with that status' : 'No quotes yet'}
            action={<Link className="btn" to="/quotes/new">Write your first quote</Link>}>
            Build a price list once under Price list, and the second quote for the same kind of job
            takes under a minute.
          </Empty>
        ) : (
          <div className="scroll-x mt">
            <table>
              <thead><tr><th>#</th><th>Customer</th><th className="num">Total</th><th>Status</th><th>Sent</th></tr></thead>
              <tbody>
                {quotes.map((q) => (
                  <tr key={q.quoteId}>
                    <td><Link to={`/quotes/${q.quoteId}`}>{q.label ?? `#${q.number}`}</Link></td>
                    <td>{q.customerName || q.customerEmail || <span className="meta">no name</span>}</td>
                    <td className="num">{cash(q.totalCents, q.currency)}</td>
                    <td>
                      <span className={`chip ${STATUS_CHIP[quoteStatus(q)]}`}>{quoteStatus(q)}</span>
                      {' '}{quoteAging(q)}{' '}{emailFailedChip(q)}
                    </td>
                    <td className="nowrap">{when(q.createdAt)}</td>
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

function NewQuote() {
  const navigate = useNavigate()
  const location = useLocation()
  // Duplicated quotes arrive via router state; "Quote this job" arrives via
  // query params from the request page (issue 72).
  const dup = (location.state ?? {}) as { lines?: Line[]; notes?: string }
  const params = new URLSearchParams(location.search)
  const requestId = params.get('requestId') ?? undefined
  const [items, setItems] = useState<PriceItem[]>([])
  const [contacts, setContacts] = useState<Array<{ contactId: string; name?: string; email?: string }>>([])
  const [contactId, setContactId] = useState('')
  const [lines, setLines] = useState<Array<{ description: string; unit: string; quantity: string; unitDollars: string }>>(
    dup.lines?.length
      ? dup.lines.map((l) => ({
          description: l.description, unit: l.unit, quantity: String(l.quantity), unitDollars: (l.unitCents / 100).toFixed(2),
        }))
      : [{ description: '', unit: 'item', quantity: '1', unitDollars: '' }],
  )
  const [customerName, setCustomerName] = useState(params.get('name') ?? '')
  const [customerEmail, setCustomerEmail] = useState(params.get('email') ?? '')
  const [customerPhone, setCustomerPhone] = useState(params.get('phone') ?? '')
  const [notes, setNotes] = useState(dup.notes ?? '')
  const [validDays, setValidDays] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Validity lives in ONE place - the quote's own expiry. A note that also
  // talks validity puts two contradicting statements on a money document
  // (issue 82), so warn at compose time.
  const notesMentionValidity = /valid|expir/i.test(notes)

  useEffect(() => {
    void api('GET', '/v1/quotes/items').then((r) => setItems(r.items ?? [])).catch(() => setItems([]))
    void api('GET', '/v1/contacts').then((r) => setContacts(r.contacts ?? [])).catch(() => setContacts([]))
  }, [])

  const pickContact = (id: string) => {
    setContactId(id)
    const c = contacts.find((x) => x.contactId === id)
    if (c) { setCustomerName(c.name ?? ''); setCustomerEmail(c.email ?? '') }
  }

  const setLine = (i: number, patch: Partial<(typeof lines)[number]>) =>
    setLines((ls) => ls.map((l, n) => (n === i ? { ...l, ...patch } : l)))

  const fromPriceList = (i: number, itemId: string) => {
    const item = items.find((x) => x.itemId === itemId)
    if (item) setLine(i, { description: item.description, unit: item.unit, unitDollars: (item.unitCents / 100).toFixed(2) })
  }

  const subtotal = lines.reduce(
    (sum, l) => sum + Math.round((Number(l.quantity) || 0) * Math.round((Number(l.unitDollars) || 0) * 100)),
    0,
  )

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    void (async () => {
      try {
        const r = await api('POST', '/v1/quotes', {
          customerName, customerEmail, customerPhone, notes, requestId,
          contactId: contactId || undefined,
          validDays: validDays ? Number(validDays) : undefined,
          lines: lines
            .filter((l) => l.description.trim())
            .map((l) => ({
              description: l.description,
              unit: l.unit,
              quantity: Number(l.quantity) || 0,
              unitCents: Math.round((Number(l.unitDollars) || 0) * 100),
            })),
        })
        navigate(`/quotes/${r.quote.quoteId}`)
      } catch (e) { setError(explain(e)); setBusy(false) }
    })()
  }

  return (
    <>
      <p className="meta"><Link to="/quotes">← All quotes</Link></p>
      <h1>New quote</h1>
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <form onSubmit={submit}>
        <div className="card">
          <h2>Customer</h2>
          {contacts.length > 0 && (
            <>
              <label htmlFor="q-contact">Existing customer</label>
              <select id="q-contact" value={contactId} onChange={(e) => pickContact(e.target.value)}>
                <option value="">Start fresh…</option>
                {contacts.map((c) => (
                  <option key={c.contactId} value={c.contactId}>
                    {c.name || c.email || c.contactId}{c.name && c.email ? ` (${c.email})` : ''}
                  </option>
                ))}
              </select>
            </>
          )}
          <div className="row mt">
            <div className="grow">
              <label htmlFor="q-name">Name</label>
              <input id="q-name" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
            </div>
            <div className="grow">
              <label htmlFor="q-email">Email</label>
              <input id="q-email" type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} />
            </div>
            <div className="grow">
              <label htmlFor="q-phone">Phone</label>
              <input id="q-phone" type="tel" value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)} />
            </div>
          </div>
          <p className="meta">
            Either one is enough. With a phone number you can text them the link instead of emailing it.
          </p>
        </div>

        <div className="card">
          <h2>Lines</h2>
          {lines.map((l, i) => (
            <div key={i} className="quote-line">
              <div className="row">
                {items.length > 0 && (
                  <select className="narrow" value="" onChange={(e) => fromPriceList(i, e.target.value)}
                    aria-label="Pick from your price list">
                    <option value="">From price list…</option>
                    {items.filter((x) => x.active).map((x) => (
                      <option key={x.itemId} value={x.itemId}>{x.description}</option>
                    ))}
                  </select>
                )}
                <input className="grow" value={l.description} placeholder="What is being done"
                  onChange={(e) => setLine(i, { description: e.target.value })} aria-label="Description" />
                <input type="number" step="0.25" min={0} className="narrow" value={l.quantity}
                  onChange={(e) => setLine(i, { quantity: e.target.value })} aria-label="Quantity" />
                <input className="narrow" value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })}
                  aria-label="Unit" />
                <input type="number" step="0.01" min={0} className="narrow" value={l.unitDollars}
                  placeholder="0.00" onChange={(e) => setLine(i, { unitDollars: e.target.value })} aria-label="Unit price" />
                {lines.length > 1 && (
                  <button type="button" className="ghost"
                    onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))}>Remove</button>
                )}
              </div>
            </div>
          ))}
          <div className="row mt">
            <button type="button" className="ghost"
              onClick={() => setLines((ls) => [...ls, { description: '', unit: 'item', quantity: '1', unitDollars: '' }])}>
              Add line
            </button>
            <span className="grow" />
            <span className="stat">{cash(subtotal)}</span>
          </div>
        </div>

        <div className="card">
          <label htmlFor="q-notes">Notes for the customer</label>
          <textarea id="q-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="Access needed through the side gate. Price excludes waste removal." />
          {notesMentionValidity && (
            <Notice tone="warn">
              The quote already carries its own "valid until" date — set it below instead of writing
              validity into the notes, or the customer sees two different answers.
            </Notice>
          )}
          <div className="row mt" style={{ alignItems: 'center' }}>
            <label htmlFor="q-valid" style={{ margin: 0 }}>Valid for</label>
            <input id="q-valid" type="number" min={1} max={365} className="narrow" value={validDays}
              onChange={(e) => setValidDays(e.target.value)} placeholder="30" />
            <span className="meta">days — blank uses your quote settings; shown on the quote as one clear date.</span>
          </div>
          <div className="mt">
            <button disabled={busy || !lines.some((l) => l.description.trim())}>
              {busy ? 'Creating…' : 'Create draft'}
            </button>
          </div>
        </div>
      </form>
    </>
  )
}

function QuoteDetail() {
  const { quoteId = '' } = useParams()
  const navigate = useNavigate()
  const [quote, setQuote] = useState<Quote | null>(null)
  const [publicUrl, setPublicUrl] = useState('')
  const [taxLabel, setTaxLabel] = useState('Tax')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await api('GET', `/v1/quotes/${quoteId}`)
      setQuote(r.label ? { ...r.quote, label: r.label } : r.quote)
      setPublicUrl(r.publicUrl); setTaxLabel(r.config?.taxLabel ?? 'Tax')
    } catch (e) { setError(explain(e)) }
  }, [quoteId])
  useEffect(() => { void load() }, [load])

  const send = () =>
    void (async () => {
      setBusy(true); setError(''); setNote('')
      try {
        const r = await api('POST', `/v1/quotes/${quoteId}/send`, {})
        setNote(r.emailed
          ? `Sent to ${quote?.customerEmail}.`
          : 'Email is not switched on for this account yet, so nothing was sent. Copy the link below and send it yourself.')
        await load()
      } catch (e) { setError(explain(e)) } finally { setBusy(false) }
    })()

  /**
   * Put the link on the clipboard, marking the quote sent on the way.
   *
   * A draft has no working link - the public page 404s on one - so the first
   * press has to go to the server before there is anything worth copying.
   * After that it is a straight copy.
   */
  const share = () =>
    void (async () => {
      setBusy(true); setError(''); setNote(''); setCopied(false)
      try {
        const url = publicUrl || (await api('POST', `/v1/quotes/${quoteId}/share`, {})).publicUrl as string
        setPublicUrl(url)
        // If the clipboard is refused - an insecure context, or a browser that
        // wants a fresher gesture - the link is still shown in the field
        // below, so the tradesperson is never left with nothing.
        try {
          await navigator.clipboard.writeText(url)
          setCopied(true)
        } catch {
          setNote('Copy the link below and send it to your customer.')
        }
        await load()
      } catch (e) { setError(explain(e)) } finally { setBusy(false) }
    })()

  const revoke = () =>
    void (async () => {
      if (!window.confirm(
        'Stop this link working?\n\nAnyone you already sent it to will not be able to open it. '
        + 'You get a new link to send instead.',
      )) return
      setBusy(true); setError(''); setNote(''); setCopied(false)
      try {
        const r = await api('POST', `/v1/quotes/${quoteId}/revoke`, {})
        setPublicUrl(r.publicUrl)
        setNote('The old link no longer works. Send the new one below.')
        await load()
      } catch (e) { setError(explain(e)) } finally { setBusy(false) }
    })()

  if (error && !quote) return (
    <><p className="meta"><Link to="/quotes">← All quotes</Link></p><h1>Quote</h1>
      <Notice tone="err">{error}</Notice></>
  )
  if (!quote) return (
    <><p className="meta"><Link to="/quotes">← All quotes</Link></p><h1>Quote</h1>
      <div className="card"><Skeleton rows={5} /></div></>
  )

  const settled = quote.status === 'accepted' || quote.status === 'declined'

  return (
    <>
      <p className="meta"><Link to="/quotes">← All quotes</Link></p>
      <div className="row baseline">
        <h1 className="grow">Quote {quote.label ?? `#${quote.number}`}</h1>
        {quote.invoiceId ? (
          <Link className="btn" to={`/quotes/invoices/${quote.invoiceId}`}>View invoice</Link>
        ) : quote.status === 'accepted' && (
          <button disabled={busy} onClick={() => void (async () => {
            setBusy(true); setError('')
            try {
              const r = await api('POST', `/v1/quotes/${quoteId}/invoice`, {})
              navigate(`/quotes/invoices/${r.invoice.invoiceId}`)
            } catch (e) { setError(explain(e)); setBusy(false) }
          })()}>
            Create invoice
          </button>
        )}
      </div>
      <p>
        {quote.customerName || quote.customerEmail} ·{' '}
        <Link to={`/contacts/${quote.contactId}`}>see their history</Link> ·{' '}
        <span className={`chip ${STATUS_CHIP[quote.status]}`}>{quote.status}</span>
      </p>

      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}
      {quote.status === 'accepted' && (
        <Notice tone="ok">
          Accepted. This quote is now fixed — to change anything, create a new one.
        </Notice>
      )}
      {quote.status === 'expired' && (
        <Notice tone="warn">This quote passed its date and can no longer be accepted.</Notice>
      )}
      {quote.status === 'superseded' && (
        <Notice tone="warn">This quote was replaced by a newer revision.</Notice>
      )}

      <div className="card">
        <div className="scroll-x">
          <table>
            <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Unit</th><th className="num">Total</th></tr></thead>
            <tbody>
              {quote.lines.map((l, i) => (
                <tr key={i}>
                  <td>{l.description}</td>
                  <td className="num">{l.quantity} {l.unit}</td>
                  <td className="num">{cash(l.unitCents, quote.currency)}</td>
                  <td className="num">{cash(l.totalCents, quote.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="facts mt">
          <dt>Subtotal</dt><dd>{cash(quote.subtotalCents, quote.currency)}</dd>
          {quote.taxCents > 0 && <><dt>{taxLabel}</dt><dd>{cash(quote.taxCents, quote.currency)}</dd></>}
          <dt>Total</dt><dd><strong>{cash(quote.totalCents, quote.currency)}</strong></dd>
          <dt>Valid until</dt><dd>{new Date(quote.validUntil).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</dd>
        </dl>
        {quote.notes && <><label>Notes</label><p>{quote.notes}</p></>}
      </div>

      <div className="card">
        <h2>Get it to your customer</h2>
        {!settled ? (
          <>
            {/*
              Sharing first, emailing second. Before issue 118 the only way out
              of draft was an email, and the link stayed hidden until then - so
              a tradesperson holding nothing but a phone number could build a
              quote and never get its link at all.
            */}
            <p>Send the link however you like - a text, WhatsApp, or just hand them your phone.</p>
            <div className="row">
              <button onClick={share} disabled={busy}>
                {busy ? 'Working…' : publicUrl ? 'Copy the link' : 'Get the link'}
              </button>
              <button className="ghost" onClick={send} disabled={busy || !quote.customerEmail}
                title={quote.customerEmail ? `Email it to ${quote.customerEmail}` : 'This customer has no email address'}>
                {quote.status === 'draft' ? 'Email it instead' : 'Email it again'}
              </button>
            </div>
            {copied && <p className="meta">Copied. Paste it into a message to your customer.</p>}
          </>
        ) : (
          <p className="meta">This quote has been {quote.status}, so it cannot be sent again.</p>
        )}
        {publicUrl && quote.status !== 'draft' && (
          <>
            <label className="mt">Customer link</label>
            <div className="row">
              <input className="grow" readOnly value={publicUrl} onFocus={(e) => e.target.select()} aria-label="Customer link" />
              <a className="btn ghost" href={publicUrl} target="_blank" rel="noopener noreferrer">Preview</a>
            </div>
            <p className="meta">
              Anyone with this link can see the quote. Accepting it asks them to type their name.
            </p>
            {publicUrl && (
              <details className="mt">
                <summary>Show a code they can scan</summary>
                <div className="mt">
                  <QrBlock url={publicUrl} label={`quote ${quote.label ?? quote.number}`} size={180}
                    hint="Hold your phone up and let your customer point their camera at it. If they would rather have it in a message, use Copy the link." />
                </div>
              </details>
            )}
            {!settled && (
              <div className="row mt">
                {/*
                  The honest answer to "I sent it to the wrong Dave", and the
                  reason this product has no view password: a password pasted
                  into the same message would not have stopped that either.
                */}
                <button className="ghost danger" disabled={busy} onClick={revoke}
                  title="The old link stops working and you get a new one">
                  Stop this link working
                </button>
              </div>
            )}
          </>
        )}
        {quote.status !== 'draft' && (
          <p className="meta mt">
            {quote.viewCount
              ? `Opened ${quote.viewCount === 1 ? 'once' : `${quote.viewCount} times`}, last on ${
                new Date(quote.lastViewedAt!).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}.`
              : 'Not opened yet.'}
          </p>
        )}
      </div>

      {quote.status !== 'draft' && (
        <div className="card">
          <h2>Next steps</h2>
          <div className="row">
            {quote.invoiceId ? (
              <Link className="btn" to={`/quotes/invoices/${quote.invoiceId}`}>View invoice</Link>
            ) : quote.status === 'accepted' && (
              <button disabled={busy} onClick={() => void (async () => {
                setBusy(true); setError('')
                try {
                  const r = await api('POST', `/v1/quotes/${quoteId}/invoice`, {})
                  navigate(`/quotes/invoices/${r.invoice.invoiceId}`)
                } catch (e) { setError(explain(e)); setBusy(false) }
              })()}>
                Create invoice
              </button>
            )}
            <button className="ghost" disabled={busy}
              title="Starts a fresh draft with these lines for a different customer"
              onClick={() => navigate('/quotes/new', {
                state: { lines: quote.lines, notes: quote.notes },
              })}>
              Duplicate
            </button>
            <button className="ghost" disabled={busy} onClick={() => void (async () => {
              setBusy(true); setError('')
              try {
                const r = await api('POST', `/v1/quotes/${quoteId}/revise`, {})
                navigate(`/quotes/${r.quote.quoteId}`)
              } catch (e) { setError(explain(e)); setBusy(false) }
            })()}>
              Revise quote
            </button>
          </div>
          <p className="meta">
            {quote.status === 'accepted'
              ? 'An invoice copies the agreed lines exactly. A revision starts a fresh draft with a new number.'
              : 'A revision starts a fresh draft with a new number; this quote stays as it is.'}
          </p>
        </div>
      )}
    </>
  )
}

function InvoicesList() {
  const [invoices, setInvoices] = useState<Invoice[] | null>(null)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void api('GET', '/v1/quotes/invoices')
      .then((r) => setInvoices(r.invoices ?? []))
      .catch((e) => { setError(explain(e)); setInvoices([]) })
  }, [])

  const shown = (invoices ?? []).filter((i) => !filter || i.status === filter)
  const outstanding = (invoices ?? []).filter((i) => i.status === 'sent')
  const outstandingTotal = outstanding.reduce((s, i) => s + i.totalCents, 0)

  return (
    <>
      <h1>Invoices</h1>
      <p>Simple invoices from accepted quotes. Bookkeeping and tax stay in your accounting software.</p>
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card">
        <div className="row baseline">
          <div className="tabs grow">
            {['', 'sent', 'paid', 'draft', 'void'].map((f) => (
              <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                {f === '' ? 'All' : f === 'sent' ? 'unpaid' : f}
              </button>
            ))}
          </div>
          {outstanding.length > 0 && (
            <span className="meta nowrap">
              outstanding: <strong>{cash(outstandingTotal, outstanding[0].currency)}</strong>
            </span>
          )}
        </div>
        {!invoices ? <div className="mt"><Skeleton rows={4} /></div> : shown.length === 0 ? (
          <Empty title={filter ? 'Nothing with that status' : 'No invoices yet'}>
            Open an <Link to="/quotes?status=accepted">accepted quote</Link> and press Create
            invoice — the agreed price carries over exactly.
          </Empty>
        ) : (
          <div className="scroll-x mt">
            <table>
              <thead><tr><th>#</th><th>Customer</th><th className="num">Total</th><th>Status</th><th>Due</th></tr></thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i.invoiceId}>
                    <td><Link to={`/quotes/invoices/${i.invoiceId}`}>{invoiceLabel(i)}</Link></td>
                    <td>{i.customerName || i.customerEmail || <span className="meta">no name</span>}</td>
                    <td className="num">{cash(i.totalCents, i.currency)}</td>
                    <td><span className={`chip ${STATUS_CHIP[i.status]}`}>{i.status}</span></td>
                    <td className="nowrap">{aging(i) ?? when(i.dueAt)}</td>
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

function InvoiceDetail() {
  const { invoiceId = '' } = useParams()
  const [invoice, setInvoice] = useState<Invoice | null>(null)
  const [label, setLabel] = useState('')
  const [publicUrl, setPublicUrl] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await api('GET', `/v1/quotes/invoices/${invoiceId}`)
      setInvoice(r.invoice); setLabel(r.label); setPublicUrl(r.publicUrl ?? '')
    } catch (e) { setError(explain(e)) }
  }, [invoiceId])
  useEffect(() => { void load() }, [load])

  const run = (fn: () => Promise<void>) =>
    void (async () => {
      setBusy(true); setError(''); setNote('')
      try { await fn(); await load() } catch (e) { setError(explain(e)) } finally { setBusy(false) }
    })()

  /**
   * Hand back the invoice link without sending anything.
   *
   * shareInvoice and revokeInvoiceLink shipped with issue 118 phase 1 and were
   * never wired to a button, so an invoice for a customer with only a phone
   * number could be built and never reached: the send button is disabled
   * without an email, and the screen told the owner to "share the link below"
   * while there was no link below. Invoices did not work without email, only
   * quotes did.
   */
  const share = () =>
    void (async () => {
      setBusy(true); setError(''); setNote(''); setCopied(false)
      try {
        const url = publicUrl || (await api('POST', `/v1/quotes/invoices/${invoiceId}/share`, {})).publicUrl as string
        setPublicUrl(url)
        try {
          await navigator.clipboard.writeText(url)
          setCopied(true)
        } catch {
          setNote('Copy the link below and send it to your customer.')
        }
        await load()
      } catch (e) { setError(explain(e)) } finally { setBusy(false) }
    })()

  const revoke = () =>
    void (async () => {
      if (!window.confirm(
        'Stop this link working?\n\nAnyone you already sent it to will not be able to open it. '
        + 'You get a new link to send instead.',
      )) return
      setBusy(true); setError(''); setNote(''); setCopied(false)
      try {
        const r = await api('POST', `/v1/quotes/invoices/${invoiceId}/revoke`, {})
        setPublicUrl(r.publicUrl)
        setNote('The old link no longer works. Send the new one below.')
        await load()
      } catch (e) { setError(explain(e)) } finally { setBusy(false) }
    })()

  if (error && !invoice) return (
    <><p className="meta"><Link to="/quotes/invoices">← All invoices</Link></p><h1>Invoice</h1>
      <Notice tone="err">{error}</Notice></>
  )
  if (!invoice) return (
    <><p className="meta"><Link to="/quotes/invoices">← All invoices</Link></p><h1>Invoice</h1>
      <div className="card"><Skeleton rows={5} /></div></>
  )

  return (
    <>
      <p className="meta"><Link to="/quotes/invoices">← All invoices</Link></p>
      <h1>{label}</h1>
      <p>
        {invoice.customerName || invoice.customerEmail}
        {invoice.contactId && <> · <Link to={`/contacts/${invoice.contactId}`}>see their history</Link></>}
        {' '}· <span className={`chip ${STATUS_CHIP[invoice.status]}`}>{invoice.status}</span>
        {invoice.quoteId && <> · <Link to={`/quotes/${invoice.quoteId}`}>from quote</Link></>}
      </p>

      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}
      {invoice.status === 'paid' && (
        <Notice tone="ok">Paid{invoice.paidAt ? ` on ${when(invoice.paidAt)}` : ''}. A paid invoice never changes.</Notice>
      )}

      <div className="card">
        <div className="scroll-x">
          <table>
            <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Unit</th><th className="num">Total</th></tr></thead>
            <tbody>
              {invoice.lines.map((l, i) => (
                <tr key={i}>
                  <td>{l.description}</td>
                  <td className="num">{l.quantity} {l.unit}</td>
                  <td className="num">{cash(l.unitCents, invoice.currency)}</td>
                  <td className="num">{cash(l.totalCents, invoice.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="facts mt">
          <dt>Subtotal</dt><dd>{cash(invoice.subtotalCents, invoice.currency)}</dd>
          {invoice.taxCents > 0 && <><dt>Tax</dt><dd>{cash(invoice.taxCents, invoice.currency)}</dd></>}
          <dt>Total</dt><dd><strong>{cash(invoice.totalCents, invoice.currency)}</strong></dd>
          <dt>Due</dt><dd>{new Date(invoice.dueAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</dd>
        </dl>
        {invoice.paymentInstructions && <><label>How to pay</label><p className="meta">{invoice.paymentInstructions}</p></>}
      </div>

      <div className="card">
        <h2>Send and settle</h2>
        {invoice.status !== 'void' && invoice.status !== 'paid' && (
          <div className="row">
            <button disabled={busy || !invoice.customerEmail}
              onClick={() => run(async () => {
                const r = await api('POST', `/v1/quotes/invoices/${invoiceId}/send`, {})
                setNote(r.emailed
                  ? `Sent to ${invoice.customerEmail}.`
                  : 'Email is not switched on yet, so nothing was sent. Copy the link below instead.')
              })}>
              {busy ? 'Working…' : invoice.status === 'draft' ? 'Send invoice' : 'Send again'}
            </button>
            <button className="ghost" disabled={busy}
              onClick={() => run(async () => { await api('PATCH', `/v1/quotes/invoices/${invoiceId}`, { status: 'paid' }) })}>
              Mark paid
            </button>
            <button className="danger" disabled={busy}
              onClick={() => { if (window.confirm('Void this invoice?')) run(async () => { await api('PATCH', `/v1/quotes/invoices/${invoiceId}`, { status: 'void' }) }) }}>
              Void
            </button>
          </div>
        )}
        {invoice.status !== 'void' && (
          <>
            {/*
              The button the invoice screen never had. Sharing marks the
              invoice sent, which is what makes the link work at all - the
              public view 404s on a draft.
            */}
            <p className="mt">Send the link however you like - a text, WhatsApp, or hand them your phone.</p>
            <div className="row">
              <button onClick={share} disabled={busy}>
                {busy ? 'Working…' : publicUrl ? 'Copy the link' : 'Get the link'}
              </button>
            </div>
            {copied && <p className="meta">Copied. Paste it into a message to your customer.</p>}
          </>
        )}
        {publicUrl && (
          <>
            <label className="mt">Customer link</label>
            <div className="row">
              <input className="grow" readOnly value={publicUrl} onFocus={(e) => e.target.select()} aria-label="Customer link" />
              <a className="btn ghost" href={publicUrl} target="_blank" rel="noopener noreferrer">Preview</a>
            </div>
            <p className="meta">The page is printable — the customer can save it as a PDF. The look comes from your invoice theme under Price list.</p>
            <details className="mt">
              <summary>Show a code they can scan</summary>
              <div className="mt">
                <QrBlock url={publicUrl} label={`invoice ${label}`} size={180}
                  hint="Hold your phone up and let your customer point their camera at it. If they would rather have it in a message, use Copy the link." />
              </div>
            </details>
            {invoice.status !== 'paid' && (
              <div className="row mt">
                {/* A paid invoice is the customer's receipt, so its link stays. */}
                <button className="ghost danger" disabled={busy} onClick={revoke}
                  title="The old link stops working and you get a new one">
                  Stop this link working
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}

/**
 * A small honest mock of the public invoice page in the chosen theme - same
 * layout rules as pages.js, so what the owner previews is what the customer
 * gets, minus their real numbers.
 */
function ThemePreview({ theme, currency, taxLabel, docPrefix = '', accent = '#c2410c', bizName = 'Your Business Name', items = [] }: {
  theme: string; currency: string; taxLabel: string; docPrefix?: string
  accent?: string; bizName?: string; items?: Array<{ description: string; unitCents: number }>
}) {
  const money = (cents: number) => cash(cents, currency)
  const sample = `${docPrefix ? `${docPrefix}-` : ''}INV-042`
  const serif = theme === 'classic'
  const dense = theme === 'compact'
  const band = theme === 'bold'
  // The preview wears the owner's own accent and lines - a mock in someone
  // else's colours sells nothing (issue 61).
  const line1 = items[0] ?? { description: 'Labour — qualified trade', unitCents: 28000 }
  const line2 = items[1] ?? { description: 'Materials', unitCents: 9250 }
  const lum = (h: string) => { const n = parseInt(h.slice(1), 16); return 0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255) }
  const accentFg = lum(accent) > 186 ? '#1c1917' : '#fff'
  return (
    <div style={{
      border: '1px solid #e7e5e4', borderRadius: 10, padding: dense ? 14 : 20, maxWidth: 460,
      fontSize: dense ? 12.5 : 14, background: '#fff', color: '#1c1917',
    }}>
      {band ? (
        <div style={{ background: accent, color: accentFg, padding: '10px 14px', borderRadius: 8, marginBottom: 12 }}>
          <strong style={{ fontSize: 16 }}>{sample}</strong>
          <div style={{ opacity: 0.8, fontSize: 12 }}>{bizName}</div>
        </div>
      ) : (
        <h3 style={{
          margin: '0 0 10px', fontFamily: serif ? 'Georgia, serif' : 'inherit',
          fontWeight: serif ? 400 : 700, letterSpacing: dense ? '.08em' : undefined,
          textTransform: dense ? 'uppercase' : undefined, fontSize: dense ? 13 : 17,
        }}>{sample}</h3>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          <tr style={{ borderBottom: serif ? '1px solid #e7e5e4' : undefined }}>
            <td style={{ padding: '4px 0' }}>{line1.description}</td>
            <td style={{ textAlign: 'right' }}>{money(line1.unitCents)}</td>
          </tr>
          <tr>
            <td style={{ padding: '4px 0' }}>{line2.description}</td>
            <td style={{ textAlign: 'right' }}>{money(line2.unitCents)}</td>
          </tr>
          <tr>
            <td style={{ padding: '4px 0', color: '#57534e' }}>{taxLabel}</td>
            <td style={{ textAlign: 'right', color: '#57534e' }}>{money(Math.round((line1.unitCents + line2.unitCents) * 0.1))}</td>
          </tr>
          <tr style={{ borderTop: `2px solid ${band ? accent : '#1c1917'}`, fontWeight: 700, fontSize: band ? '1.2em' : undefined }}>
            <td style={{ padding: '6px 0' }}>Total due</td>
            <td style={{ textAlign: 'right' }}>{money(Math.round((line1.unitCents + line2.unitCents) * 1.1))}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function PriceList({ me }: { me?: Me }) {
  const [items, setItems] = useState<PriceItem[] | null>(null)
  const [form, setForm] = useState({ description: '', unit: 'hour', dollars: '' })
  const [config, setConfig] = useState<any>(null)
  const [accent, setAccent] = useState('#c2410c')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setItems((await api('GET', '/v1/quotes/items')).items)
      setConfig((await api('GET', '/v1/quotes/config')).config)
      void api('GET', '/v1/presence/config')
        .then((r) => setAccent(r.config?.accentColor ?? '#c2410c'))
        .catch(() => {})
    } catch (e) { setError(explain(e)); setItems([]) }
  }, [])
  useEffect(() => { void load() }, [load])

  const run = async (fn: () => Promise<void>) => {
    setError(''); setNote(''); setBusy(true)
    try { await fn(); await load() } catch (e) { setError(explain(e)) } finally { setBusy(false) }
  }

  const add = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api('POST', '/v1/quotes/items', {
        description: form.description, unit: form.unit,
        unitCents: Math.round((Number(form.dollars) || 0) * 100),
      })
      setForm({ description: '', unit: 'hour', dollars: '' })
    })
  }

  const saveConfig = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => { await api('PUT', '/v1/quotes/config', config); setNote('Saved.') })
  }

  return (
    <>
      <h1>Price list</h1>
      <p>Saved lines you reuse, so the second quote for the same kind of job takes under a minute.</p>

      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card">
        <h2>Add an item</h2>
        <form onSubmit={add}>
          <div className="row">
            <input className="grow" value={form.description} required placeholder="Labour, qualified electrician"
              onChange={(e) => setForm({ ...form, description: e.target.value })} aria-label="Description" />
            <input className="narrow" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}
              aria-label="Unit" placeholder="hour" />
            <input className="narrow" type="number" step="0.01" min={0} value={form.dollars}
              onChange={(e) => setForm({ ...form, dollars: e.target.value })} aria-label="Price" placeholder="95.00" />
            <button disabled={busy || !form.description}>Add</button>
          </div>
        </form>

        {!items ? <div className="mt"><Skeleton rows={3} /></div> : items.length === 0 ? (
          <Empty title="Nothing saved yet">Add the things you charge for most often.</Empty>
        ) : (
          <div className="scroll-x mt">
            <table>
              <thead><tr><th>Description</th><th>Unit</th><th className="num">Price</th><th /></tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.itemId}>
                    <td>{i.description}</td>
                    <td>{i.unit}</td>
                    <td className="num">{cash(i.unitCents, config?.currency ?? 'AUD')}</td>
                    <td className="nowrap">
                      <button className="danger" disabled={busy}
                        onClick={() => void run(async () => { await api('DELETE', `/v1/quotes/items/${i.itemId}`) })}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {config && (
        <div className="card">
          <h2>Quote settings</h2>
          <form onSubmit={saveConfig}>
            <div className="row">
              <div className="grow">
                <label htmlFor="tax">Tax rate (%)</label>
                <input id="tax" type="number" step="0.1" min={0} max={100}
                  value={Math.round(config.taxRate * 1000) / 10}
                  onChange={(e) => setConfig({ ...config, taxRate: Number(e.target.value) / 100 })} />
              </div>
              <div className="grow">
                <label htmlFor="taxlabel">Called</label>
                <input id="taxlabel" value={config.taxLabel}
                  onChange={(e) => setConfig({ ...config, taxLabel: e.target.value })} />
              </div>
              <div className="grow">
                <label htmlFor="valid">Valid for (days)</label>
                <input id="valid" type="number" min={1} max={365} value={config.validDays}
                  onChange={(e) => setConfig({ ...config, validDays: Number(e.target.value) })} />
              </div>
            </div>
            <div className="row">
              <div className="grow">
                <label htmlFor="q-currency">Currency</label>
                <select id="q-currency" value={config.currency ?? 'AUD'}
                  onChange={(e) => setConfig({ ...config, currency: e.target.value })}>
                  {['AUD', 'INR', 'USD', 'NZD', 'GBP', 'EUR', 'CAD', 'SGD', 'ZAR', 'AED'].map((c) => (
                    <option key={c} value={c}>{c} — {new Intl.NumberFormat('en', { style: 'currency', currency: c }).format(1234.5)}</option>
                  ))}
                </select>
                <p className="meta">Used on every new quote and invoice. Existing documents keep the currency they were made in.</p>
              </div>
              <div className="grow">
                <label htmlFor="q-accept">Before a customer can accept</label>
                <select id="q-accept" value={config.acceptCheck ?? 'name'}
                  onChange={(e) => setConfig({ ...config, acceptCheck: e.target.value })}>
                  <option value="name">Type their name</option>
                  <option value="phone4">Type their name and the last 4 digits of their phone</option>
                  <option value="none">Just tap the button</option>
                </select>
                <p className="meta">
                  Anyone with the link can always read the quote - this is only about agreeing to it.
                  A typed name is what makes an acceptance stand up if it is ever questioned.
                </p>
              </div>
              <div className="grow">
                <label htmlFor="q-notify">Send quote notifications to</label>
                <input id="q-notify" type="email" value={config.notifyEmail ?? ''}
                  placeholder="you@yourbusiness.com.au"
                  onChange={(e) => setConfig({ ...config, notifyEmail: e.target.value })} />
                <p className="meta">Accepted, declined and deposit-paid emails land here.</p>
              </div>
              <div className="grow">
                <label htmlFor="q-prefix">Document prefix</label>
                <input id="q-prefix" maxLength={6} placeholder="SP" value={config.docPrefix ?? ''}
                  onChange={(e) => setConfig({
                    ...config,
                    docPrefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6),
                  })} />
                <p className="meta">
                  Your tag on every document number:{' '}
                  {(config.docPrefix ? `${config.docPrefix}-` : '') + 'Q-001'} and{' '}
                  {(config.docPrefix ? `${config.docPrefix}-` : '') + 'INV-001'}.
                </p>
              </div>
            </div>
            <label htmlFor="q-footer">Identity line on every document</label>
            <input id="q-footer" maxLength={200} value={config.docFooter ?? ''}
              placeholder="ABN 12 345 678 901 · Plumbing licence PL12345"
              onChange={(e) => setConfig({ ...config, docFooter: e.target.value })} />
            <p className="meta">ABN, licence number - whatever compliance asks for. Shown at the foot of quotes and invoices.</p>
            <label className="pick">
              <input type="checkbox" checked={config.showLogoOnDocs !== false}
                onChange={(e) => setConfig({ ...config, showLogoOnDocs: e.target.checked })} />
              <span>Show your page photo as the logo on quotes and invoices</span>
            </label>
            <label htmlFor="terms">Terms shown on every quote</label>
            <textarea id="terms" rows={2} value={config.terms}
              onChange={(e) => setConfig({ ...config, terms: e.target.value })} />

            <h2 className="mt">Invoices</h2>
            <div className="row">
              <div className="grow">
                <label htmlFor="inv-theme">Theme</label>
                <select id="inv-theme" value={config.invoiceTheme ?? 'classic'}
                  onChange={(e) => setConfig({ ...config, invoiceTheme: e.target.value })}>
                  <option value="classic">Classic — serif, quiet, traditional</option>
                  <option value="compact">Compact — small and dense</option>
                  <option value="bold">Bold — heavy header, big total</option>
                </select>
              </div>
              <div className="grow">
                <label htmlFor="inv-due">Due after (days)</label>
                <input id="inv-due" type="number" min={1} max={90} value={config.dueDays ?? 14}
                  onChange={(e) => setConfig({ ...config, dueDays: Number(e.target.value) })} />
              </div>
              <div className="grow">
                <label htmlFor="q-deposit">Deposit on acceptance (%)</label>
                <input id="q-deposit" type="number" min={0} max={100} value={config.depositPercent ?? 0}
                  onChange={(e) => setConfig({ ...config, depositPercent: Number(e.target.value) })} />
              </div>
            </div>
            <p className="meta">
              With a deposit set and Get paid connected, an accepted quote asks for the deposit by
              card on the spot. 0 switches it off.
            </p>
            <label htmlFor="inv-pay">How customers pay you</label>
            <textarea id="inv-pay" rows={2} value={config.paymentInstructions ?? ''}
              placeholder={'Bank transfer to BSB 000-000, account 12345678.\nOr PayID: 0400 000 000.'}
              onChange={(e) => setConfig({ ...config, paymentInstructions: e.target.value })} />
            <p className="meta">Shown on every invoice that is not yet paid.</p>

            <label className="mt">Theme preview</label>
            <ThemePreview theme={config.invoiceTheme ?? 'classic'} currency={config.currency ?? 'AUD'}
              taxLabel={config.taxLabel ?? 'Tax'} docPrefix={config.docPrefix ?? ''}
              accent={accent} bizName={me?.tenant?.name ?? 'Your Business Name'}
              items={(items ?? []).filter((i: PriceItem) => i.active).slice(0, 2)} />
            <p className="meta">How the invoice page reads to your customer. The quote page uses the same accent and currency.</p>

            <div className="mt"><button disabled={busy}>Save settings</button></div>
          </form>
        </div>
      )}
    </>
  )
}

export const quotesDashboard: DashboardModule = {
  id: 'quotes',
  label: 'Quotes',
  nav: [
    { to: '/quotes', label: 'All quotes' },
    { to: '/quotes/invoices', label: 'Invoices' },
    { to: '/quotes/prices', label: 'Price list' },
  ],
  routes: ({ me }) => (
    <>
      <Route path="/quotes" element={<QuotesList />} />
      <Route path="/quotes/new" element={<NewQuote />} />
      <Route path="/quotes/prices" element={<PriceList me={me} />} />
      <Route path="/quotes/invoices" element={<InvoicesList />} />
      <Route path="/quotes/invoices/:invoiceId" element={<InvoiceDetail />} />
      <Route path="/quotes/:quoteId" element={<QuoteDetail />} />
    </>
  ),
}

export default quotesDashboard
