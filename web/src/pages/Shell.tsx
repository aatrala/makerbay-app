import { Fragment, useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { logout, type DashboardModule, type Me } from '@makerbay/web-kit'

export default function Shell({ me, modules, stripeMode }: {
  me: Me
  modules: DashboardModule[]
  stripeMode?: 'test' | 'live' | null
}) {
  const [open, setOpen] = useState(false)
  const location = useLocation()

  // Navigating on a phone should close the menu, not leave it covering the page.
  useEffect(() => { setOpen(false) }, [location.pathname])

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
            {modules.map((m) => (
              <Fragment key={m.id}>
                <div className="navlabel">{m.label}</div>
                {m.nav.map((item) => (
                  <NavLink key={item.to} to={item.to}>{item.label}</NavLink>
                ))}
              </Fragment>
            ))}
            <div className="navlabel">Workspace</div>
            <NavLink to="/workspace">Settings</NavLink>
            <NavLink to="/activity">Activity</NavLink>
            <NavLink to="/usage">Usage</NavLink>
            <NavLink to="/billing">Billing</NavLink>
          </nav>

          <div className="spacer" />

          {stripeMode && (
            <div className={`modebadge ${stripeMode}`}>
              {stripeMode === 'live' ? 'LIVE BILLING' : 'TEST BILLING'}
            </div>
          )}

          <div className="whoami">
            <strong>{me.tenant?.name}</strong>
            <span>{me.user.email}</span>
            <button className="linkish" onClick={logout}>Sign out</button>
          </div>
        </div>
      </aside>

      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}
