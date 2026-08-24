import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, Route, useNavigate, useParams } from 'react-router-dom'
import {
  Empty,
  Notice,
  Skeleton,
  api,
  explain,
  when,
  type DashboardModule,
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
  contactId: string
  customerName?: string
  customerEmail?: string
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
  createdAt: string
}

interface Invoice {
  invoiceId: string
  number: number
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

const invoiceLabel = (i: Pick<Invoice, 'number'>) => `INV-${String(i.number).padStart(4, '0')}`

const cash = (cents: number, currency = 'AUD') =>
  new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(cents / 100)

const STATUS_CHIP: Record<string, string> = {
  draft: 'awaiting_upload', sent: 'processing', accepted: 'ready',
  declined: 'failed', expired: 'failed', superseded: 'failed',
  paid: 'ready', void: 'failed',
}

function QuotesList() {
  const [quotes, setQuotes] = useState<Quote[] | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try { setQuotes((await api('GET', `/v1/quotes${status ? `?status=${status}` : ''}`)).quotes) }
    catch (e) { setError(explain(e)); setQuotes([]) }
  }, [status])
  useEffect(() => { void load() }, [load])

  return (
    <>
      <h1>Quotes</h1>
      <p>Price a job, send a link, get an answer. No PDFs, no accounting software.</p>
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="tabs">
        {['', 'draft', 'sent', 'accepted', 'declined'].map((s) => (
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
                    <td><Link to={`/quotes/${q.quoteId}`}>#{q.number}</Link></td>
                    <td>{q.customerName || q.customerEmail || <span className="meta">no name</span>}</td>
                    <td className="num">{cash(q.totalCents, q.currency)}</td>
                    <td><span className={`chip ${STATUS_CHIP[q.status]}`}>{q.status}</span></td>
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
  const [items, setItems] = useState<PriceItem[]>([])
  const [lines, setLines] = useState<Array<{ description: string; unit: string; quantity: string; unitDollars: string }>>([
    { description: '', unit: 'item', quantity: '1', unitDollars: '' },
  ])
  const [customerName, setCustomerName] = useState('')
  const [customerEmail, setCustomerEmail] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api('GET', '/v1/quotes/items').then((r) => setItems(r.items ?? [])).catch(() => setItems([]))
  }, [])

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
          customerName, customerEmail, notes,
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
          <div className="row">
            <div className="grow">
              <label htmlFor="q-name">Name</label>
              <input id="q-name" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
            </div>
            <div className="grow">
              <label htmlFor="q-email">Email</label>
              <input id="q-email" type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} />
            </div>
          </div>
          <p className="meta">They are matched to an existing contact by email, or added as a new one.</p>
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

  const load = useCallback(async () => {
    try {
      const r = await api('GET', `/v1/quotes/${quoteId}`)
      setQuote(r.quote); setPublicUrl(r.publicUrl); setTaxLabel(r.config?.taxLabel ?? 'Tax')
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
      <h1>Quote #{quote.number}</h1>
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
        <h2>Send it</h2>
        {!settled ? (
          <>
            <p>Emails the customer a link they can open on their phone and accept.</p>
            <div className="row">
              <button onClick={send} disabled={busy || !quote.customerEmail}>
                {busy ? 'Sending…' : quote.status === 'draft' ? 'Send quote' : 'Send again'}
              </button>
              {!quote.customerEmail && <span className="meta">Add an email address first.</span>}
            </div>
          </>
        ) : (
          <p className="meta">This quote has been {quote.status} and cannot be resent.</p>
        )}
        {publicUrl && quote.status !== 'draft' && (
          <>
            <label className="mt">Customer link</label>
            <div className="row">
              <input className="grow" readOnly value={publicUrl} onFocus={(e) => e.target.select()} aria-label="Customer link" />
              <a className="btn ghost" href={publicUrl} target="_blank" rel="noopener">Preview</a>
            </div>
            <p className="meta">Anyone with this link can view and accept. Share it only with your customer.</p>
          </>
        )}
      </div>

      {quote.status !== 'draft' && (
        <div className="card">
          <h2>Next steps</h2>
          <div className="row">
            {quote.status === 'accepted' && (
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
  const [error, setError] = useState('')

  useEffect(() => {
    void api('GET', '/v1/quotes/invoices')
      .then((r) => setInvoices(r.invoices ?? []))
      .catch((e) => { setError(explain(e)); setInvoices([]) })
  }, [])

  return (
    <>
      <h1>Invoices</h1>
      <p>Simple invoices from accepted quotes. Bookkeeping and tax stay in your accounting software.</p>
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card">
        {!invoices ? <Skeleton rows={4} /> : invoices.length === 0 ? (
          <Empty title="No invoices yet">
            Open an accepted quote and press Create invoice — the agreed price carries over exactly.
          </Empty>
        ) : (
          <div className="scroll-x">
            <table>
              <thead><tr><th>#</th><th>Customer</th><th className="num">Total</th><th>Status</th><th>Due</th></tr></thead>
              <tbody>
                {invoices.map((i) => (
                  <tr key={i.invoiceId}>
                    <td><Link to={`/quotes/invoices/${i.invoiceId}`}>{invoiceLabel(i)}</Link></td>
                    <td>{i.customerName || i.customerEmail || <span className="meta">no name</span>}</td>
                    <td className="num">{cash(i.totalCents, i.currency)}</td>
                    <td><span className={`chip ${STATUS_CHIP[i.status]}`}>{i.status}</span></td>
                    <td className="nowrap">{when(i.dueAt)}</td>
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

  const load = useCallback(async () => {
    try {
      const r = await api('GET', `/v1/quotes/invoices/${invoiceId}`)
      setInvoice(r.invoice); setLabel(r.label); setPublicUrl(r.publicUrl)
    } catch (e) { setError(explain(e)) }
  }, [invoiceId])
  useEffect(() => { void load() }, [load])

  const run = (fn: () => Promise<void>) =>
    void (async () => {
      setBusy(true); setError(''); setNote('')
      try { await fn(); await load() } catch (e) { setError(explain(e)) } finally { setBusy(false) }
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
        {!invoice.customerEmail && invoice.status === 'draft' && (
          <p className="meta">This customer has no email — share the link below instead.</p>
        )}
        {publicUrl && (
          <>
            <label className="mt">Customer link</label>
            <div className="row">
              <input className="grow" readOnly value={publicUrl} onFocus={(e) => e.target.select()} aria-label="Customer link" />
              <a className="btn ghost" href={publicUrl} target="_blank" rel="noopener">Preview</a>
            </div>
            <p className="meta">The page is printable — the customer can save it as a PDF. The look comes from your invoice theme under Price list.</p>
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
function ThemePreview({ theme, currency, taxLabel }: { theme: string; currency: string; taxLabel: string }) {
  const money = (cents: number) => cash(cents, currency)
  const serif = theme === 'classic'
  const dense = theme === 'compact'
  const band = theme === 'bold'
  return (
    <div style={{
      border: '1px solid #e7e5e4', borderRadius: 10, padding: dense ? 14 : 20, maxWidth: 460,
      fontSize: dense ? 12.5 : 14, background: '#fff', color: '#1c1917',
    }}>
      {band ? (
        <div style={{ background: '#111', color: '#fff', padding: '10px 14px', borderRadius: 8, marginBottom: 12 }}>
          <strong style={{ fontSize: 16 }}>INV-0042</strong>
          <div style={{ opacity: 0.8, fontSize: 12 }}>Your Business Name</div>
        </div>
      ) : (
        <h3 style={{
          margin: '0 0 10px', fontFamily: serif ? 'Georgia, serif' : 'inherit',
          fontWeight: serif ? 400 : 700, letterSpacing: dense ? '.08em' : undefined,
          textTransform: dense ? 'uppercase' : undefined, fontSize: dense ? 13 : 17,
        }}>INV-0042</h3>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          <tr style={{ borderBottom: serif ? '1px solid #e7e5e4' : undefined }}>
            <td style={{ padding: '4px 0' }}>Labour — qualified trade</td>
            <td style={{ textAlign: 'right' }}>{money(28000)}</td>
          </tr>
          <tr>
            <td style={{ padding: '4px 0' }}>Materials</td>
            <td style={{ textAlign: 'right' }}>{money(9250)}</td>
          </tr>
          <tr>
            <td style={{ padding: '4px 0', color: '#57534e' }}>{taxLabel}</td>
            <td style={{ textAlign: 'right', color: '#57534e' }}>{money(3725)}</td>
          </tr>
          <tr style={{ borderTop: '2px solid #1c1917', fontWeight: 700, fontSize: band ? '1.2em' : undefined }}>
            <td style={{ padding: '6px 0' }}>Total due</td>
            <td style={{ textAlign: 'right' }}>{money(40975)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function PriceList() {
  const [items, setItems] = useState<PriceItem[] | null>(null)
  const [form, setForm] = useState({ description: '', unit: 'hour', dollars: '' })
  const [config, setConfig] = useState<any>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setItems((await api('GET', '/v1/quotes/items')).items)
      setConfig((await api('GET', '/v1/quotes/config')).config)
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
                <label htmlFor="q-notify">Send quote notifications to</label>
                <input id="q-notify" type="email" value={config.notifyEmail ?? ''}
                  onChange={(e) => setConfig({ ...config, notifyEmail: e.target.value })} />
              </div>
            </div>
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
              taxLabel={config.taxLabel ?? 'Tax'} />
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
  routes: () => (
    <>
      <Route path="/quotes" element={<QuotesList />} />
      <Route path="/quotes/new" element={<NewQuote />} />
      <Route path="/quotes/prices" element={<PriceList />} />
      <Route path="/quotes/invoices" element={<InvoicesList />} />
      <Route path="/quotes/invoices/:invoiceId" element={<InvoiceDetail />} />
      <Route path="/quotes/:quoteId" element={<QuoteDetail />} />
    </>
  ),
}

export default quotesDashboard
