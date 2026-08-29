import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { QrBlock, Skeleton, api, tradeExamples, type Me } from '@makerbay/web-kit'

/**
 * The front door (issues 74, 136, 148).
 *
 * Two jobs, in priority order: what needs you now, and - only while it is
 * still true - what is left to set up. Anything waiting on the owner outranks
 * anything they could configure.
 *
 * **The setup list is three steps, not six.** Those three are a real
 * dependency chain - a priced service, the hours you will work, then the page
 * goes live - and the chain ends in a URL the owner can send somebody. That
 * is the only step that produces something visible, and three steps finish on
 * a first evening where six do not: the sixth used to be a Google review
 * link, which needs a verified Google Business Profile, which takes days and
 * happens on somebody else's website. A progress bar that cannot reach the end
 * is worse than no progress bar.
 *
 * The other three are still here, unnumbered and without a bar, because none
 * of them is urgent and saying so is more honest than implying otherwise.
 *
 * Every read is an endpoint that already exists. No API of its own, and no
 * CloudFormation resource, which matters at 493 of a hard 500.
 */

interface Chase {
  label: string
  detail: string
  to: string
}

interface Waiting {
  openRequests: number
  /** Tomorrow's diary, not today's. See the comment on the fetch. */
  tomorrow: Array<{ time: string; who: string; missing?: string }>
  tomorrowLabel: string
  chases: Chase[]
  invoicesUnpaid: number
  /** True when a read failed, so the screen must not claim all is quiet. */
  incomplete: boolean
}

interface Step {
  key: string
  label: string
  copy: string
  to: string
  /** undefined means the check could not run - never the same as "not done". */
  done: boolean | undefined
}

const dismissKey = (tenantId: string) => `mb.setupDone.${tenantId}`

export const isSetupDismissed = (tenantId: string): boolean => {
  try {
    return localStorage.getItem(dismissKey(tenantId)) === '1'
  } catch {
    // Storage blocked. Showing the setup nav is the harmless side of this.
    return false
  }
}

const remember = (tenantId: string) => {
  try {
    localStorage.setItem(dismissKey(tenantId), '1')
  } catch { /* storage blocked: the list simply shows again next time */ }
}

/** The local calendar date in a given zone, as YYYY-MM-DD. */
const dayIn = (zone: string, offsetDays = 0): string => {
  const d = new Date(Date.now() + offsetDays * 86_400_000)
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(d)
  } catch {
    return d.toISOString().slice(0, 10)
  }
}

export default function Home({ me }: { me: Me }) {
  const tenantId = me.tenant?.tenantId ?? ''
  const eg = tradeExamples(me.tenant?.trade)
  const [steps, setSteps] = useState<Step[] | null>(null)
  const [waiting, setWaiting] = useState<Waiting | null>(null)
  const [pageUrl, setPageUrl] = useState('')
  const [hidden, setHidden] = useState(() => isSetupDismissed(tenantId))
  const [copied, setCopied] = useState(false)
  const [later, setLater] = useState<Step[] | null>(null)

  /*
   * What needs you (issues 136, 148).
   *
   * **Tomorrow, not today.** By the time an owner reads "today at 9:00" they
   * are already in the van or already late - today's diary is a record.
   * Tomorrow's is a decision, and the evening is when a solo trader actually
   * does admin. It also lets the screen flag a missing phone number or
   * address while there is still time to chase it.
   *
   * The date is computed in the BUSINESS's timezone, not the browser's or
   * UTC. startsAt is a UTC instant and the default workspace timezone is
   * Australia/Sydney, so a UTC date comparison showed yesterday's diary until
   * 10am local every single morning - which is exactly when this screen gets
   * opened. The correct zone arrives in the same payload and used to be
   * thrown away.
   */
  useEffect(() => {
    void (async () => {
      const failed: string[] = []
      const get = async (path: string) => {
        try {
          return await api('GET', path)
        } catch {
          failed.push(path)
          return {} as Record<string, never>
        }
      }
      const [reqs, books, insights] = await Promise.all([
        get('/v1/requests'),
        get('/v1/booking/bookings'),
        // One call instead of two, and it already knows WHY a quote is stuck:
        // never opened, opened but no answer, overdue. "Quote 14, Jane Smith,
        // 6 days, never opened" is a phone call to make; "1 quote is
        // unanswered" is a number.
        get('/v1/quotes/insights'),
      ])

      const zone = String(books.timezone ?? 'UTC')
      const tomorrow = dayIn(zone, 1)

      setWaiting({
        // The server already counted these; Shell reads the same numbers from
        // the same endpoint. Deriving them again here meant two definitions of
        // one number that agreed only by luck.
        openRequests: reqs.counts
          ? Number(reqs.counts.new ?? 0) + Number(reqs.counts.open ?? 0)
          : 0,
        tomorrowLabel: new Date(`${tomorrow}T12:00:00Z`).toLocaleDateString(undefined, {
          weekday: 'long',
        }),
        tomorrow: (books.bookings ?? [])
          .filter((b: { startsAt?: string; status?: string; kind?: string }) =>
            // A 'block' is the owner's own reserved time - a school run, a
            // supplier visit. It is stored as a booking so slot logic treats
            // it as taken, but it is not a customer and must not be listed
            // as one.
            b.kind !== 'block'
            && b.status !== 'cancelled' && b.status !== 'pending_payment'
            && String(b.startsAt ?? '').length > 0
            && new Intl.DateTimeFormat('en-CA', { timeZone: zone })
              .format(new Date(String(b.startsAt))) === tomorrow)
          .sort((a: { startsAt?: string }, b: { startsAt?: string }) =>
            String(a.startsAt).localeCompare(String(b.startsAt)))
          .map((b: {
            startsAt?: string; name?: string; serviceName?: string
            phone?: string; address?: string
          }) => ({
            time: new Date(String(b.startsAt)).toLocaleTimeString(undefined, {
              hour: 'numeric', minute: '2-digit', timeZone: zone,
            }),
            who: b.name || b.serviceName || 'Booking',
            // Flagged while it can still be fixed, which is the point of
            // showing tomorrow rather than today.
            missing: !b.phone ? 'no phone number' : !b.address ? 'no address' : undefined,
          })),
        // Field names taken from the endpoint, not guessed: rows carry
        // `who` and `age`, and the document type is only knowable from the
        // label, which reads "Quote 14" or "Invoice 7".
        chases: (insights.chase ?? []).slice(0, 4).map((c: {
          label?: string; who?: string; age?: number; reason?: string
        }) => ({
          label: `${c.label ?? 'Document'} · ${c.who ?? 'someone'}`,
          detail: `${c.age ?? 0} days · ${c.reason ?? 'waiting'}`,
          to: String(c.label ?? '').startsWith('Invoice') ? '/quotes/invoices' : '/quotes',
        })),
        // The funnel already counts these; no separate field to invent.
        invoicesUnpaid: Number(insights.invoices?.sent ?? 0),
        incomplete: failed.length > 0,
      })
    })()
  }, [])

  useEffect(() => {
    void (async () => {
      // undefined rather than false on failure: a check that could not run is
      // not a step the owner has skipped, and rendering it as one sends them
      // to redo work they have already done.
      const get = async (path: string) => {
        try {
          return await api('GET', path)
        } catch {
          return undefined
        }
      }
      const [services, booking, sources, presence, items, visibility] = await Promise.all([
        get('/v1/booking/services'),
        get('/v1/booking/config'),
        get('/v1/assistant/sources'),
        get('/v1/presence/config'),
        get('/v1/quotes/items'),
        get('/v1/visibility/config'),
      ])
      if (presence?.pageUrl) setPageUrl(String(presence.pageUrl))

      setSteps([
        {
          key: 'service',
          label: 'Say what you do and what it costs',
          copy: `One service and its price — ${eg.service.toLowerCase()} at $${eg.servicePrice}. `
            + 'It is what your diary offers, what your page shows, and where a quote starts.',
          to: '/booking/services',
          // Priced AND active. An unpriced or switched-off service does none
          // of the three things the copy above promises, and the presence
          // module has always checked it this way.
          done: services && Array.isArray(services.services)
            ? services.services.some((s: { priceCents?: number; active?: boolean }) =>
              s.active !== false && typeof s.priceCents === 'number' && s.priceCents > 0)
            : undefined,
        },
        {
          key: 'hours',
          label: 'Say when you are free',
          copy: 'The hours you will take work. Customers can only book inside them, '
            + 'so nobody rings you at nine on a Sunday.',
          to: '/booking/hours',
          // Not "are there any hours" - every workspace starts with Mon-Fri
          // 9-5 from DEFAULT_BOOKING_CONFIG, so that test ticked before the
          // owner had done anything. What matters is whether they SAVED them.
          done: booking ? Boolean(booking.config?.updatedAt) : undefined,
        },
        {
          key: 'page',
          label: 'Put your page online',
          copy: 'An intro in your own words and one photo. Then you have a link — '
            + 'text it to the next person who asks what you do.',
          to: '/page',
          // The presence module's own readiness signal, not the published
          // flag. Every workspace used to start published, so this step
          // ticked on a page with nothing on it.
          done: presence
            ? Boolean(presence.config?.published) && Boolean(presence.indexing?.complete)
            : undefined,
        },
      ])

      setLater([
        {
          key: 'knowledge',
          label: 'Let it answer while you are under a sink',
          copy: 'Paste your website address. It reads it and answers customers the way you would.',
          to: '/assistant/knowledge',
          // A crawl that FAILED is not knowledge, and neither is one still
          // running. Both used to tick this.
          done: sources && Array.isArray(sources.sources)
            ? sources.sources.some((s: { status?: string }) => s.status === 'ready')
            : undefined,
        },
        {
          key: 'prices',
          label: 'Quote in a minute instead of an evening',
          copy: `Price the jobs you do most, once — ${eg.quoteLine.toLowerCase()}, and so on. `
            + 'Every quote after that is picking from a list.',
          to: '/quotes/prices',
          done: items && Array.isArray(items.items) ? items.items.length > 0 : undefined,
        },
        {
          key: 'reviews',
          label: 'Send people somewhere to leave a review',
          copy: 'Paste your Google review link. Needs a Google Business Profile — '
            + 'if you have not set one up, leave this for now.',
          to: '/get-found',
          done: visibility ? Boolean(visibility.config?.reviewLink) : undefined,
        },
      ])
    })()
  }, [eg.service, eg.servicePrice, eg.quoteLine])

  const known = steps?.filter((s) => s.done !== undefined) ?? []
  const done = known.filter((s) => s.done).length
  const allDone = Boolean(steps && steps.length > 0 && steps.every((s) => s.done === true))
  const next = steps?.find((s) => s.done === false)
  const pct = steps && steps.length ? Math.round((done / steps.length) * 100) : 0

  // Remember completion so the sidebar stops treating this as a new
  // workspace. Deliberately NOT used to hide this screen - Home stays the
  // landing page, and the setup card retires on its own.
  useEffect(() => {
    if (allDone) remember(tenantId)
  }, [allDone, tenantId])

  const copy = () => {
    void navigator.clipboard?.writeText(pageUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => { /* the URL is on screen either way */ })
  }

  const nothingWaiting = waiting
    && waiting.openRequests === 0 && waiting.tomorrow.length === 0
    && waiting.chases.length === 0 && waiting.invoicesUnpaid === 0

  const showSetup = !hidden && !allDone

  return (
    <>
      <h1>Welcome{me.tenant?.name ? `, ${me.tenant.name}` : ''}</h1>
      {showSetup && steps && (
        <p>
          Your assistant, diary and review requests are already on. Three things
          turn them into yours — and at the end you have a link to send people.
        </p>
      )}

      {/* Anything waiting outranks anything that could be set up. */}
      {waiting && !nothingWaiting && (
        <div className="card">
          <h2>What needs you</h2>
          <ul className="checklist mt">
            {waiting.openRequests > 0 && (
              <li>
                <Link to="/requests">
                  <strong>{waiting.openRequests}</strong>{' '}
                  {waiting.openRequests === 1 ? 'person is' : 'people are'} waiting to hear back
                </Link>
              </li>
            )}
            {waiting.tomorrow.length > 0 && (
              <li>
                <Link to="/booking/diary">
                  <strong>{waiting.tomorrowLabel}:</strong>{' '}
                  {waiting.tomorrow.map((b) => `${b.time} ${b.who}`).join(' · ')}
                  {waiting.tomorrow.some((b) => b.missing) && (
                    <span className="meta block">
                      {waiting.tomorrow.filter((b) => b.missing)
                        .map((b) => `${b.time} has ${b.missing}`)
                        .join(' · ')}
                    </span>
                  )}
                </Link>
              </li>
            )}
            {waiting.chases.map((c) => (
              <li key={c.label}>
                <Link to={c.to}>
                  <strong>{c.label}</strong>
                  <span className="meta block">{c.detail}</span>
                </Link>
              </li>
            ))}
          </ul>
          {waiting.incomplete && (
            <p className="meta mt">Some of this could not be checked just now.</p>
          )}
        </div>
      )}

      {/* Only ever claimed when every read actually succeeded. */}
      {waiting && nothingWaiting && !waiting.incomplete && allDone && (
        <div className="card">
          <h2>Nothing needs you right now</h2>
          <p className="meta">
            No one waiting, nothing in tomorrow's diary, no quote or invoice
            outstanding. This is the screen doing its job.
          </p>
        </div>
      )}
      {waiting && nothingWaiting && waiting.incomplete && (
        <div className="card">
          <h2>Could not check everything</h2>
          <p className="meta">
            Something did not load, so this screen cannot tell you whether
            anything is waiting. Try again in a moment.
          </p>
        </div>
      )}

      {/* The moment the page goes live: hand over the artefact, not praise. */}
      {allDone && pageUrl && !hidden && (
        <div className="card">
          <h2>Your page is live</h2>
          <div className="row mt" style={{ alignItems: 'center' }}>
            <a className="grow" href={pageUrl} target="_blank" rel="noopener">{pageUrl}</a>
            <button className="ghost" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
          </div>
          <p className="mt">
            Send it to the next person who asks what you do. Anything that comes
            back — a question, a booking, a quote — lands on this screen.
          </p>
          <QrBlock url={pageUrl} label="Scan to open your page"
            hint="Print it for the van, or show it on your phone." />
          <p className="meta mt">
            Nothing will arrive until somebody has the link. That part is not
            software. <a href="#" onClick={(e) => { e.preventDefault(); setHidden(true); remember(tenantId) }}>Hide this</a>
          </p>
        </div>
      )}

      {!steps ? (
        <div className="card"><Skeleton rows={4} /></div>
      ) : showSetup ? (
        <div className="card">
          <div className="row baseline">
            <h2 className="grow">Getting started</h2>
            <span className="meta">{done} of {steps.length} done</span>
          </div>
          <div className="bar" role="progressbar" aria-valuenow={done}
            aria-valuemin={0} aria-valuemax={steps.length}
            aria-label="Setup progress">
            <div style={{ width: `${pct}%` }} />
          </div>

          {/* The work already built, offered before the manual route. The
              setup module fills four of these six from one pasted URL, and
              until now the only way to it was a sidebar entry that sits
              behind "More" on a phone. */}
          <div className="row mt" style={{ alignItems: 'center' }}>
            <span className="grow">
              <strong>Rather not do this bit?</strong> Paste your website address
              and we fill in your page, your services, your prices and what your
              assistant knows. Nothing goes live until you have looked at it.
            </span>
            <Link className="btn" to="/setup">Set it up for me</Link>
          </div>

          {next && (
            <div className="row mt" style={{ alignItems: 'center' }}>
              <span className="grow"><strong>Next:</strong> {next.copy}</span>
              <Link className="btn ghost" to={next.to}>Do it</Link>
            </div>
          )}

          <ul className="checklist mt">
            {steps.map((s) => (
              <li key={s.key} className={s.done ? 'done' : ''}>
                <span aria-hidden="true">{s.done ? '✓' : s.done === undefined ? '?' : '○'}</span>{' '}
                <span className="visually-hidden">{s.done ? 'Done: ' : 'To do: '}</span>
                {s.done ? s.label : <Link to={s.to}>{s.label}</Link>}
                {/* The explanation as real text, not a title attribute -
                    a hover tooltip is unreachable on the phone these owners
                    actually use. */}
                {!s.done && <span className="meta block">{s.copy}</span>}
                {s.done === undefined && (
                  <span className="meta block">We could not check this one just now.</span>
                )}
              </li>
            ))}
          </ul>

          {later && later.some((s) => !s.done) && (
            <>
              <h3 className="mt">When you have a minute</h3>
              <p className="meta">None of these are urgent. Each one saves you an evening later.</p>
              <ul className="checklist mt">
                {later.filter((s) => !s.done).map((s) => (
                  <li key={s.key}>
                    <span aria-hidden="true">○</span>{' '}
                    <span className="visually-hidden">To do: </span>
                    <Link to={s.to}>{s.label}</Link>
                    <span className="meta block">{s.copy}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <p className="meta mt">
            Want to see a finished setup?{' '}
            <a href="https://demo.makerbay.app" target="_blank" rel="noopener">Open the demo →</a>
            {' · '}
            <a href="#" onClick={(e) => { e.preventDefault(); setHidden(true); remember(tenantId) }}>
              Hide setup
            </a>
          </p>
        </div>
      ) : null}
    </>
  )
}
