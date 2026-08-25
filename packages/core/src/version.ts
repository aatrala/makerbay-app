import assistantManifest from '../../../modules/assistant/module.json'
import bookingManifest from '../../../modules/booking/module.json'
import contactsManifest from '../../../modules/contacts/module.json'
import quotesManifest from '../../../modules/quotes/module.json'
import requestsManifest from '../../../modules/requests/module.json'
import presenceManifest from '../../../modules/presence/module.json'
import reviewsManifest from '../../../modules/reviews/module.json'
import paymentsManifest from '../../../modules/payments/module.json'
import genieManifest from '../../../modules/genie/module.json'
import visibilityManifest from '../../../modules/visibility/module.json'
import voiceManifest from '../../../modules/voice/module.json'

/**
 * One manifest per module, and one place that knows the platform version.
 * The same file feeds the version endpoint, the dashboard footer, the
 * marketing module pages and the roadmap, so a module cannot be described
 * in two places that disagree.
 */

export interface ModuleFeature {
  title: string
  body: string
}

export interface ModuleFaq {
  q: string
  a: string
}

export interface ModuleManifest {
  id: string
  name: string
  tagline: string
  status: 'live' | 'in-development' | 'planned'
  /** Core modules ship with every workspace and are never entitlement-gated. */
  core?: boolean
  version: Record<string, string>
  routes: string[]
  meteredMetrics: string[]
  /** null for core modules, which have nothing to switch on or off. */
  entitlementKey: string | null
  /**
   * 'free' modules are on for every workspace at no cost. They are the ones
   * that cost us almost nothing to run and make the paid modules more useful:
   * a free module that feeds Contacts is customer acquisition, not lost
   * revenue. 'paid' modules carry real marginal cost or real willingness to
   * pay, and stay behind an entitlement.
   */
  pricing?: 'free' | 'paid'
  /** Generous caps that exist to bound cost, not to force an upgrade. */
  freeLimits?: Record<string, number>
  dependsOn: string[]
  roadmap: { order: number; note: string }
  marketing: {
    summary: string
    audience: string
    features: ModuleFeature[]
    faq?: ModuleFaq[]
  }
}

/** Platform version: the core (tenancy, auth, entitlements, billing) itself. */
export const PLATFORM_VERSION = '1.28.0'

export const MODULES: ModuleManifest[] = [
  contactsManifest,
  assistantManifest,
  requestsManifest,
  bookingManifest,
  quotesManifest,
  presenceManifest,
  visibilityManifest,
  voiceManifest,
  reviewsManifest,
  paymentsManifest,
  genieManifest,
] as ModuleManifest[]

export const moduleManifest = (id: string): ModuleManifest | undefined =>
  MODULES.find((m) => m.id === id)

/** Everything a customer can switch on and be billed for. */
export const billableModules = (): ModuleManifest[] =>
  MODULES.filter((m) => !m.core && m.pricing !== 'free')

/** Modules every workspace gets at no cost, core substrate included. */
export const freeModules = (): ModuleManifest[] =>
  MODULES.filter((m) => m.core || m.pricing === 'free')

/** Is this module free for everyone, and therefore never entitlement-gated? */
export const isFreeModule = (moduleId: string): boolean => {
  const m = MODULES.find((x) => x.id === moduleId)
  return Boolean(m && (m.core || m.pricing === 'free'))
}

/** The caps a free module runs under. Bounds our cost; never forces an upgrade. */
export const freeModuleLimits = (moduleId: string): Record<string, number> =>
  MODULES.find((x) => x.id === moduleId)?.freeLimits ?? {}

/** Ordered the way the roadmap tells the story, not the way the array is written. */
export const roadmapOrder = (): ModuleManifest[] =>
  [...MODULES].sort((a, b) => a.roadmap.order - b.roadmap.order)

const STATUS_LABEL: Record<ModuleManifest['status'], string> = {
  live: 'Available now',
  'in-development': 'In development',
  planned: 'Planned',
}

export const statusLabel = (s: ModuleManifest['status']): string => STATUS_LABEL[s]
