import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, Skeleton, type Me } from '@makerbay/web-kit'

/**
 * The first-run front door (issue 74). Every new workspace now starts with
 * assistant + booking + reviews on, which is a lot of product to land in
 * cold - this one screen shows the whole shape in six lines and points at
 * the highest-leverage next action. It stops being the landing page once
 * everything is done (or dismissed), but stays reachable from the account
 * menu forever.
 *
 * Six parallel reads of existing endpoints; no API of its own.
 */

interface Waiting {
  openRequests: number
  todayBookings: Array<{ time: string; who: string }>
  quotesWaiting: number
  quotesStale: number
  invoicesUnpaid: number
}

interface Step {
  key: string
  label: string
  copy: string
  to: string
  done: boolean
}

const dismissKey = (tenantId: string) => `mb.setupDone.${tenantId}`

export const isSetupDismissed = (tenantId: string): boolean =>
  localStorage.getItem(dismissKey(tenantId)) === '1'

export default function Home({ me, onDismiss }: { me: Me; onDismiss?: () => void }) {
  const tenantId = me.tenant?.tenantId ?? ''
  const [steps, setSteps] = useState<Step[] | null>(null)
  const [waiting, setWaiting] = useState<Waiting | null>(null)

  /*
   * What needs you today (issue 136).
   *
   * The checklist below answers "how do I set this up", which stops being the
   * question after the first week. This answers "what needs me now", which is
   * the question every morning after that - and it is why an owner would open
   * the dashboard at all rather than only when something breaks.
   *
   * Four reads of endpoints that already exist, filtered here rather than
   * server-side: adding an aggregate route would cost a CloudFormation
   * resource against a hard 500 limit, and at one workspace's volume the
   * client can do this arithmetic itself.
   */
  useEffect(() => {
    void (async () => {
      const [reqs, books, quotes, invoices] = await Promise.all([
        api('GET', '/v1/requests').catch(() => ({})),
        api('GET', '/v1/booking/bookings').catch(() => ({})),
        api('GET', '/v1/quotes').catch(() => ({})),
        api('GET', '/v1/quotes/invoices').catch(() => ({})),
      ])
      const today = new Date().toISOString().slice(0, 10)
      const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString()

      const sent = (quotes.quotes ?? []).filter((q: { status?: string }) => q.status === 'sent')
      setWaiting({
        openRequests: (reqs.requests ?? []).filter(
          (r: { status?: string }) => r.status !== 'closed' && r.status !== 'archived',
        ).length,
        todayBookings: (books.bookings ?? [])
          .filter((b: { startsAt?: string; status?: string }) =>
            (b.startsAt ?? '').slice(0, 10) === today
            && b.status !== 'cancelled' && b.status !== 'pending_payment')
          .sort((a: { startsAt?: string }, b: { startsAt?: string }) =>
            String(a.startsAt).localeCompare(String(b.startsAt)))
          .map((b: { startsAt?: string; name?: string; serviceName?: string }) => ({
            time: new Date(String(b.startsAt)).toLocaleTimeString(undefined, {
              hour: 'numeric', minute: '2-digit',
            }),
            who: b.name || b.serviceName || 'Booking',
          })),
        quotesWaiting: sent.length,
        // Sent, unanswered, and going cold. The nudge the review asked for.
        quotesStale: sent.filter((q: { sentAt?: string }) => (q.sentAt ?? '') < threeDaysAgo).length,
        invoicesUnpaid: (invoices.invoices ?? []).filter(
          (i: { status?: string }) => i.status === 'sent' || i.status === 'overdue',
        ).length,
      })
    })()
  }, [])

  useEffect(() => {
    void (async () => {
      const [services, booking, sources, presence, items, visibility] = await Promise.all([
        api('GET', '/v1/booking/services').catch(() => ({})),
        api('GET', '/v1/booking/config').catch(() => ({})),
        api('GET', '/v1/assistant/sources').catch(() => ({})),
        api('GET', '/v1/presence/config').catch(() => ({})),
        api('GET', '/v1/quotes/items').catch(() => ({})),
        api('GET', '/v1/visibility/config').catch(() => ({})),
      ])
      const hours = (booking.config?.hours ?? {}) as Record<string, unknown[]>
      setSteps([
        {
          key: 'service', label: 'Add a service with a price',
          copy: 'One service and its price - it powers your diary, your page and your quotes.',
          to: '/booking/services', done: (services.services ?? []).length > 0,
        },
        {
          key: 'hours', label: 'Set your working hours',
          copy: 'Tell customers when they can book you.',
          to: '/booking/hours', done: Object.values(hours).some((day) => Array.isArray(day) && day.length > 0),
        },
        {
          key: 'knowledge', label: 'Show your assistant what you know',
          copy: 'Paste your website address - the assistant reads it and answers like you would.',
          to: '/assistant/knowledge', done: (sources.sources ?? []).length > 0,
        },
        {
          key: 'page', label: 'Publish your page',
          copy: 'An intro in your own words and one photo is what makes the page real.',
          to: '/page', done: presence.config?.published === true,
        },
        {
          key: 'prices', label: 'Build your price list',
          copy: 'Price your common jobs once; every quote after takes a minute.',
          to: '/quotes/prices', done: (items.items ?? []).length > 0,
        },
        {
          key: 'reviews', label: 'Add your Google review link',
          copy: 'Paste your Google review link so happy customers end up in the right place.',
          to: '/get-found', done: Boolean(visibility.config?.reviewLink),
        },
      ])
    })()
  }, [])

  const dismiss = () => {
    localStorage.setItem(dismissKey(tenantId), '1')
    onDismiss?.()
  }

  const done = steps?.filter((s) => s.done).length ?? 0
  const next = steps?.find((s) => !s.done)
  const pct = steps ? Math.round((done / steps.length) * 100) : 0

  // Everything done: remember it so the landing page reverts for good.
  useEffect(() => {
    if (steps && steps.every((s) => s.done)) localStorage.setItem(dismissKey(tenantId), '1')
  }, [steps, tenantId])

  return (
    <>
      <h1>Welcome{me.tenant?.name ? `, ${me.tenant.name}` : ''}</h1>
      {steps && !steps.every((s) => s.done) && (
        <p>
          Your assistant, booking diary and review requests are already switched on.
          Six small steps make them yours.
        </p>
      )}

      {waiting && (
        (waiting.openRequests + waiting.todayBookings.length
          + waiting.quotesWaiting + waiting.invoicesUnpaid) === 0 ? (
          <div className="card">
            <h2>Nothing needs you right now</h2>
            <p className="meta">
              No one waiting, nothing booked today, no quote or invoice outstanding.
              This is the screen doing its job.
            </p>
          </div>
        ) : (
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
              {waiting.todayBookings.length > 0 && (
                <li>
                  <Link to="/booking">
                    <strong>Today:</strong>{' '}
                    {waiting.todayBookings.map((b) => `${b.time} ${b.who}`).join(' · ')}
                  </Link>
                </li>
              )}
              {waiting.quotesWaiting > 0 && (
                <li>
                  <Link to="/quotes">
                    <strong>{waiting.quotesWaiting}</strong>{' '}
                    {waiting.quotesWaiting === 1 ? 'quote is' : 'quotes are'} out and unanswered
                    {waiting.quotesStale > 0 && ` — ${waiting.quotesStale} sent over three days ago`}
                  </Link>
                </li>
              )}
              {waiting.invoicesUnpaid > 0 && (
                <li>
                  <Link to="/quotes/invoices">
                    <strong>{waiting.invoicesUnpaid}</strong>{' '}
                    {waiting.invoicesUnpaid === 1 ? 'invoice is' : 'invoices are'} unpaid
                  </Link>
                </li>
              )}
            </ul>
          </div>
        )
      )}

      {!steps ? (
        <div className="card"><Skeleton rows={6} /></div>
      ) : steps.every((s) => s.done) ? null : (
        <div className="card">
          <div className="row baseline">
            <h2 className="grow">Getting started</h2>
            <span className="meta">{done} of {steps.length} done</span>
          </div>
          <div className="bar"><div style={{ width: `${pct}%` }} /></div>
          {next ? (
            <div className="row mt" style={{ alignItems: 'center' }}>
              <span className="grow"><strong>Next:</strong> {next.copy}</span>
              <Link className="btn" to={next.to}>Do it</Link>
            </div>
          ) : (
            <p className="mt">✓ All set - your workspace is doing everything it can. Requests, bookings and quotes all land here from now on.</p>
          )}
          <ul className="checklist mt">
            {steps.map((s) => (
              <li key={s.key} className={s.done ? 'done' : ''}>
                <span aria-hidden="true">{s.done ? '✓' : '○'}</span>{' '}
                {s.done ? s.label : <Link to={s.to} title={s.copy}>{s.label}</Link>}
              </li>
            ))}
          </ul>
          <p className="meta mt">
            Want to see a finished setup? <a href="https://demo.makerbay.app" target="_blank" rel="noopener">Open the demo →</a>
            {' · '}
            <a href="#" onClick={(e) => { e.preventDefault(); dismiss() }}>Hide setup</a>
          </p>
        </div>
      )}
    </>
  )
}
