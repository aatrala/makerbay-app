import { useEffect, useState, type FormEvent } from 'react'
import { api, explain, isOwner, logout, Notice, type Me } from '@makerbay/web-kit'
import PeopleCard from './PeopleCard'

/**
 * Workspace settings: the business name and the public address (slug). The
 * slug is in every link a customer sees - the page, the chat, the help
 * centre - so changing it is allowed but the consequences are said plainly.
 */
export default function WorkspacePage({ me, onSaved }: { me: Me; onSaved?: () => void }) {
  const [name, setName] = useState(me.tenant?.name ?? '')
  const [slug, setSlug] = useState(me.tenant?.slug ?? '')
  const [check, setCheck] = useState<{ slug: string; available: boolean; message?: string } | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const currentSlug = me.tenant?.slug ?? ''
  const changed = slug.trim().toLowerCase() !== currentSlug

  // Availability check as they type, debounced - a taken name should show
  // before they press save, not after.
  useEffect(() => {
    const wanted = slug.trim().toLowerCase()
    if (!wanted || wanted === currentSlug) { setCheck(null); return }
    const t = setTimeout(() => {
      void api('GET', `/v1/core/workspace/slug?check=${encodeURIComponent(wanted)}`)
        .then(setCheck)
        .catch(() => setCheck(null))
    }, 400)
    return () => clearTimeout(t)
  }, [slug, currentSlug])

  const save = (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError(''); setNote('')
    void api('PATCH', '/v1/core/workspace', { name: name.trim(), slug: slug.trim().toLowerCase() })
      .then(() => {
        setNote(changed
          ? 'Saved. Links using the old address stop working now - update anything you have shared.'
          : 'Saved.')
        onSaved?.()
      })
      .catch((err) => setError(explain(err)))
      .finally(() => setBusy(false))
  }

  const urls = [
    { label: 'Your page', href: `https://makerbay.app/p/${slug.trim().toLowerCase() || currentSlug}` },
    { label: 'Chat page', href: `https://chat.makerbay.app/${slug.trim().toLowerCase() || currentSlug}` },
    { label: 'Help centre', href: `https://help.makerbay.app/${slug.trim().toLowerCase() || currentSlug}` },
  ]

  return (
    <>
      <h1>Workspace</h1>
      <p>Your business name and the address your public pages live at.</p>
      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      <div className="card">
        <form onSubmit={save}>
          <label htmlFor="ws-name">Business name</label>
          <input id="ws-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />

          <label htmlFor="ws-slug">Public address</label>
          <div className="row">
            <span className="meta nowrap">makerbay.app/p/</span>
            <input id="ws-slug" className="grow" value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
              maxLength={40} aria-describedby="ws-slug-state" />
          </div>
          <p id="ws-slug-state" className="meta" aria-live="polite">
            {!changed
              ? 'Lowercase letters, numbers and hyphens. This is your address everywhere below.'
              : check == null
                ? 'Checking availability…'
                : check.available
                  ? '✓ Available.'
                  : check.message ?? 'That address is already in use.'}
          </p>

          {changed && (
            <Notice tone="warn">
              Changing the address breaks every link you have already shared - the old
              one is released immediately. Your Google listing, printed material and
              messages will need the new link.
            </Notice>
          )}

          <div className="mt">
            <button disabled={busy || (changed && check != null && !check.available)}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <h2>Where this address appears</h2>
        <div className="scroll-x">
          <table>
            <tbody>
              {urls.map((u) => (
                <tr key={u.label}>
                  <td>{u.label}</td>
                  <td><a href={u.href} target="_blank" rel="noopener">{u.href}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="meta mt">A custom domain for your page is available with Presence Pro, under Your page.</p>
      </div>

      <PeopleCard me={me} />

      <ModulesCard me={me} onSaved={onSaved} />

      {isOwner(me) && <CloseWorkspaceCard me={me} />}
    </>
  )
}

/**
 * Closing the workspace (issue 158). Suspends it - every public page and
 * every sign-in stops - and ends everyone's membership. Data is not erased
 * here; that is a request to support, which is deliberate: an owner who
 * closes in anger on a Friday should be able to ask for it back on Monday.
 */
function CloseWorkspaceCard({ me }: { me: Me }) {
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const slug = me.tenant?.slug ?? ''

  const close = async () => {
    setBusy(true); setError('')
    try {
      await api('DELETE', `/v1/core/tenants/${me.tenant?.tenantId}`, { confirm: confirm.trim().toLowerCase() })
      logout()
    } catch (err) {
      setError(explain(err))
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <h2>Close this workspace</h2>
      <p className="meta">
        Your page, chat and booking links stop working and everyone on the workspace loses access.
        Nothing is erased: write to support@makerbay.app to have it erased, or to have it back.
      </p>
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}
      <label htmlFor="close-confirm">Type your address, <strong>{slug}</strong>, to confirm</label>
      <div className="row">
        <input id="close-confirm" className="grow" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={slug} />
        <button className="danger" disabled={busy || confirm.trim().toLowerCase() !== slug} onClick={() => void close()}>
          {busy ? 'Closing…' : 'Close workspace'}
        </button>
      </div>
    </div>
  )
}

/**
 * Switchable modules, finally switchable from the dashboard (issue 68).
 * Onboarding turns on the assistant and nothing else, and until this card
 * existed there was no way to add Booking or Reviews afterwards - the nav
 * simply never showed them.
 */
const SWITCHABLE: { id: string; name: string; blurb: string }[] = [
  { id: 'assistant', name: 'Assistant', blurb: 'The chat widget, knowledge base and help centre.' },
  { id: 'booking', name: 'Booking', blurb: 'Services, working hours and a diary customers book into. 20 bookings a month free.' },
  { id: 'reviews', name: 'Reviews', blurb: 'Ask happy customers for a Google review at the right moment. 20 asks a month free.' },
]

function ModulesCard({ me, onSaved }: { me: Me; onSaved?: () => void }) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

  const flip = async (id: string, name: string, on: boolean) => {
    setBusy(id); setError(''); setDone('')
    try {
      await api('POST', `/v1/core/modules/${id}/${on ? 'disable' : 'enable'}`, {})
      setDone(on
        ? `${name} is off - hidden from the menu. Nothing was deleted; switch it back on any time.`
        : `${name} is on - it appears in the menu now.`)
      onSaved?.()
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="card">
      <h2>Modules</h2>
      <p className="meta">
        Contacts, Requests, Quotes and Your page are part of every workspace. These can be switched
        on and off - switching off only hides a module from the menu, nothing is deleted. Genie
        lives under Billing.
      </p>
      {done && <Notice tone="ok" onClose={() => setDone('')}>{done}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}
      {SWITCHABLE.map((m) => {
        const on = me.entitlements?.modules[m.id]?.enabled === true
        return (
          <div key={m.id} className="row" style={{ borderTop: '1px solid var(--line)', padding: '10px 0' }}>
            <span className="grow">
              <strong>{m.name}</strong>
              <span className="meta"> — {m.blurb}</span>
            </span>
            <button className={on ? 'ghost' : ''} disabled={busy !== ''} onClick={() => void flip(m.id, m.name, on)}>
              {busy === m.id ? 'Switching…' : on ? 'Switch off' : 'Turn on'}
            </button>
          </div>
        )
      })}
    </div>
  )
}
