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
import { setupDashboard } from '@makerbay/setup-web'

/**
 * The only file that knows which module dashboards exist. Adding a module is
 * one import and one array entry; nothing else in the shell changes.
 */
const ALL: DashboardModule[] = [
  genieDashboard,
  setupDashboard,
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
// 'setup' is here for the same reason as contacts: its manifest carries
// entitlementKey null, so it never appears in me.entitlements and would
// otherwise be filtered out - taking the /setup route with it, which is
// where a stranger's claim link lands. Being in CORE also keeps it out of
// the landing slot, which is right: nobody should arrive at "Set it up for
// me" as their home screen.
const CORE = new Set(['contacts', 'setup'])

/** Only modules this workspace can use, in registration order. */
export const enabledModules = (me: Me): DashboardModule[] =>
  ALL.filter((m) => CORE.has(m.id) || me.entitlements?.modules[m.id]?.enabled)

/*
 * landingPath lived here. It picked the first non-core, non-taster module to
 * land on, and issue 136 replaced it: everyone now lands on /home, which
 * leads with what is actually waiting instead of with whichever module
 * happened to sort first. Deleted rather than left unused - the CORE and
 * taster rules it encoded were only ever about choosing a landing module, and
 * nothing chooses one any more.
 */
