import type { DashboardModule, Me } from '@makerbay/web-kit'
import { assistantDashboard } from '@makerbay/assistant-web'
import { contactsDashboard } from '@makerbay/contacts-web'
import { requestsDashboard } from '@makerbay/requests-web'
import { bookingDashboard } from '@makerbay/booking-web'
import { quotesDashboard } from '@makerbay/quotes-web'
import { presenceDashboard } from '@makerbay/presence-web'
import { visibilityDashboard } from '@makerbay/visibility-web'
import { voiceDashboard } from '@makerbay/voice-web'
import { reviewsDashboard } from '@makerbay/reviews-web'
import { paymentsDashboard } from '@makerbay/payments-web'
import { genieDashboard } from '@makerbay/genie-web'

/**
 * The only file that knows which module dashboards exist. Adding a module is
 * one import and one array entry; nothing else in the shell changes.
 */
const ALL: DashboardModule[] = [
  genieDashboard,
  presenceDashboard,
  assistantDashboard,
  requestsDashboard,
  bookingDashboard,
  quotesDashboard,
  reviewsDashboard,
  paymentsDashboard,
  visibilityDashboard,
  voiceDashboard,
  contactsDashboard,
]

/**
 * Core modules ship with every workspace and are never entitlement-gated, so
 * they are not in `me.entitlements` at all. Anything else has to be switched on.
 */
const CORE = new Set(['contacts'])

/** Only modules this workspace can use, in registration order. */
export const enabledModules = (me: Me): DashboardModule[] =>
  ALL.filter((m) => CORE.has(m.id) || me.entitlements?.modules[m.id]?.enabled)

/**
 * Where to send someone after they land, preferring their first module.
 * First-run routing moved to /home (issue 74), so this is only ever the
 * settled-workspace landing now.
 */
export const landingPath = (me: Me, _firstRun: boolean): string => {
  const modules = enabledModules(me)
  // Core modules are always present, so they must never win the landing slot
  // over the module the customer actually signed up for.
  const first = modules.find((m) => !CORE.has(m.id)) ?? modules[0]
  if (!first) return '/usage'
  return first.nav[0].to
}
