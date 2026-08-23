// Shared presentation pieces every module screen reuses.
// See docs/design-guidelines.md — these are the canonical implementations of
// the empty state, the loading skeleton and the inline notice.

import type { ReactNode } from 'react'

/**
 * An empty state always names the next action. A screen that says only
 * "nothing here" leaves the user to guess what to do.
 */
export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

/** Placeholder rows sized like the content that will replace them. */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel line" style={{ width: `${[92, 78, 85, 70, 88][i % 5]}%` }} />
      ))}
      <span className="visually-hidden">Loading…</span>
    </div>
  )
}

/** Inline feedback banner. `tone` picks the tint; the text carries the meaning. */
export function Notice({ tone = 'ok', children, onClose }: {
  tone?: 'ok' | 'warn' | 'err'
  children: ReactNode
  onClose?: () => void
}) {
  return (
    <div className={`card tint-${tone} notice`} role={tone === 'err' ? 'alert' : 'status'}>
      <span className="grow">{children}</span>
      {onClose && <button className="ghost" onClick={onClose}>Dismiss</button>}
    </div>
  )
}

/** Dates people can read. Absolute for anything older than a day. */
export function when(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) +
    ', ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export const bytes = (n?: number | null): string =>
  n == null ? '—'
    : n < 1024 ? `${n} B`
      : n < 1048576 ? `${(n / 1024).toFixed(0)} KB`
        : `${(n / 1048576).toFixed(1)} MB`

// ── Module registration ──────────────────────────────────────────────────
// A module hands the shell a nav group and its routes. The shell knows
// nothing about what a module does, and a module never edits the shell.

import type { Me } from './api'

export interface ModuleNavItem {
  to: string
  label: string
}

export interface DashboardModule {
  /** Must match the manifest id, so entitlements line up. */
  id: string
  /** Heading above this module's nav group. */
  label: string
  nav: ModuleNavItem[]
  /** Rendered inside the shell's <Routes>. Given the signed-in context. */
  routes: (ctx: { me: Me }) => ReactNode
}
