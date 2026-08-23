import type { DashboardModule, Me } from '@makerbay/web-kit'
import { assistantDashboard, assistantFirstRun } from '@makerbay/assistant-web'

/**
 * The only file that knows which module dashboards exist. Adding a module is
 * one import and one array entry; nothing else in the shell changes.
 */
const ALL: DashboardModule[] = [assistantDashboard]

/** Only modules this workspace has switched on, in registration order. */
export const enabledModules = (me: Me): DashboardModule[] =>
  ALL.filter((m) => me.entitlements?.modules[m.id]?.enabled)

/** Where to send someone after they land, preferring their first module. */
export const landingPath = (me: Me, firstRun: boolean): string => {
  const first = enabledModules(me)[0]
  if (!first) return '/usage'
  if (firstRun && first.id === 'assistant') return assistantFirstRun
  return first.nav[0].to
}
