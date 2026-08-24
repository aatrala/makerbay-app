import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { logout, type DashboardModule, type Me } from '@makerbay/web-kit'

/**
 * The shell: one sidebar link per module (sub-pages render as tabs above the
 * screen, derived from the module's own nav - nothing is described twice),
 * grouped by cadence: the daily Work screens first, then Grow. Workspace
 * items live behind the account popover. Sidebar Variant A, approved
 * 2026-08-24.
 */

const ICONS: Record<string, string> = {
  genie: 'M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5z M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z',
  requests: 'M4 6h16v12H4z M4 10h16',
  booking: 'M8 3v4 M16 3v4 M3 11h18 M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
  quotes: 'M6 2h9l5 5v15H6z M14 2v6h6 M9 13h6 M9 17h6',
  payments: 'M3 7a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z M3 10h18',
  contacts: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21c0-4 4-6 8-6s8 2 8 6',
  voice: 'M5 4h4l2 5-3 2c1 3 3 5 6 6l2-3 5 2v4c0 1-1 2-2 2C9 22 2 15 2 5c0-1 1-2 2-1z',
  assistant: 'M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z',
  presence: 'M3 9l9-6 9 6v11H3z M9 20v-8h6v8',
  visibility: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-3.5-3.5',
  reviews: 'M12 3l2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3.3 9.4l6-.9z',
}

// Work: the daily money screens, in job-lifecycle order. Grow: everything
// that earns the next customer. Unlisted modules land at the end of Grow.
const WORK = ['requests', 'booking', 'quotes', 'payments', 'contacts', 'voice']
const GROW = ['genie', 'assistant', 'presence', 'visibility', 'reviews']

function Icon({ id }: { id: string }) {
  const d = ICONS[id]
  if (!d) return null
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

export default function Shell({ me, modules, stripeMode }: {
  me: Me
  modules: DashboardModule[]
  stripeMode?: 'test' | 'live' | null
}) {
  const [open, setOpen] = useState(false)
  const [acctOpen, setAcctOpen] = useState(false)
  const acctRef = useRef<HTMLDivElement>(null)
  const location = useLocation()

  // Navigating on a phone should close the menu, not leave it covering the page.
  useEffect(() => { setOpen(false); setAcctOpen(false) }, [location.pathname])
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (acctRef.current && !acctRef.current.contains(e.target as Node)) setAcctOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const byId = new Map(modules.map((m) => [m.id, m]))
  const ordered = (ids: string[]) => ids.map((id) => byId.get(id)).filter(Boolean) as DashboardModule[]
  const listed = new Set([...WORK, ...GROW])
  const work = ordered(WORK)
  const grow = [...ordered(GROW), ...modules.filter((m) => !listed.has(m.id))]

  const moduleActive = (m: DashboardModule) =>
    m.nav.some((n) => location.pathname === n.to || location.pathname.startsWith(n.to + '/'))

  // The active module's sub-pages render as tabs above the screen - the nav
  // array stays the single description; the sidebar just stopped repeating it.
  const active = modules.find(moduleActive)
  const tabs = active && active.nav.length > 1 ? active.nav : null

  const moduleLink = (m: DashboardModule) => (
    <NavLink key={m.id} to={m.nav[0].to} className={moduleActive(m) ? 'modlink on' : 'modlink'}>
      <Icon id={m.id} />{m.label}
    </NavLink>
  )

  return (
    <div className="shell">
      <aside className={`side${open ? ' open' : ''}`}>
        <div className="side-head">
          <div className="logo">Maker<span>Bay</span></div>
          <button className="ghost menu-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Close' : 'Menu'}
          </button>
        </div>

        <div className="side-body">
          <nav>
            <div className="navlabel">Work</div>
            {work.map(moduleLink)}
            <div className="navlabel">Grow</div>
            {grow.map(moduleLink)}
          </nav>

          <div className="spacer" />

          {/* Test mode is a warning worth pixels; live mode is just reality. */}
          {stripeMode === 'test' && <div className="modebadge test">TEST BILLING</div>}

          <div className="account" ref={acctRef}>
            {acctOpen && (
              <div className="acct-pop">
                <NavLink to="/workspace">Settings</NavLink>
                <NavLink to="/activity">Activity</NavLink>
                <NavLink to="/usage">Usage</NavLink>
                <NavLink to="/billing">Billing</NavLink>
                <div className="sep" />
                <button className="linkish" onClick={logout}>Sign out</button>
                <a className="ver" href="https://makerbay.app/changelog" target="_blank" rel="noopener">
                  v{__MB_RELEASE__} · Changelog
                </a>
              </div>
            )}
            <button className="acct-btn" aria-expanded={acctOpen} onClick={() => setAcctOpen(!acctOpen)}>
              <span className="av">{(me.tenant?.name ?? '?').trim().charAt(0).toUpperCase()}</span>
              <span className="who">
                <strong>{me.tenant?.name}</strong>
                <small>{me.user.email}</small>
              </span>
              <span className="chev">{acctOpen ? '▾' : '▴'}</span>
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        {tabs && (
          <div className="tabs modtabs">
            {tabs.map((t) => {
              // A tab whose path prefixes a sibling must match exactly.
              const needsEnd = tabs.some((o) => o !== t && o.to.startsWith(t.to + '/'))
              return <NavLink key={t.to} to={t.to} end={needsEnd}>{t.label}</NavLink>
            })}
          </div>
        )}
        <Outlet />
      </main>
    </div>
  )
}
