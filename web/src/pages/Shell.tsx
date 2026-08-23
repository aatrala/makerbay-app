import { NavLink, Outlet } from 'react-router-dom'
import { logout, type Me } from '../api'

export default function Shell({ me }: { me: Me }) {
  const modules = me.entitlements?.modules ?? {}
  return (
    <div className="shell">
      <aside className="side">
        <div className="logo">Maker<span style={{ color: '#6ea8ff' }}>Bay</span></div>
        <nav>
          {modules.assistant?.enabled && (
            <>
              <div className="navlabel">Assistant</div>
              <NavLink to="/assistant/playground">Playground</NavLink>
              <NavLink to="/assistant/knowledge">Knowledge</NavLink>
              <NavLink to="/assistant/behavior">Behavior</NavLink>
              <NavLink to="/assistant/deploy">Deploy</NavLink>
              <NavLink to="/assistant/conversations">Conversations</NavLink>
              <NavLink to="/assistant/insights">Insights</NavLink>
            </>
          )}
          <div className="navlabel">Workspace</div>
          <NavLink to="/usage">Usage</NavLink>
          <NavLink to="/billing">Billing</NavLink>
        </nav>
        <div className="spacer" />
        <div className="whoami">
          {me.tenant?.name}<br />{me.user.email}<br />
          <a href="#" onClick={(e) => { e.preventDefault(); logout() }}>Sign out</a>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}
