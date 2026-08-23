import assistantManifest from '../../../modules/assistant/module.json'
import bookingManifest from '../../../modules/booking/module.json'
import contactsManifest from '../../../modules/contacts/module.json'
import quotesManifest from '../../../modules/quotes/module.json'
import requestsManifest from '../../../modules/requests/module.json'
import reviewsManifest from '../../../modules/reviews/module.json'

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
export const PLATFORM_VERSION = '1.7.0'

export const MODULES: ModuleManifest[] = [
  assistantManifest,
  contactsManifest,
  requestsManifest,
  bookingManifest,
  quotesManifest,
  reviewsManifest,
] as ModuleManifest[]

export const moduleManifest = (id: string): ModuleManifest | undefined =>
  MODULES.find((m) => m.id === id)

/** Everything a customer can switch on and be billed for. */
export const billableModules = (): ModuleManifest[] => MODULES.filter((m) => !m.core)

/** Ordered the way the roadmap tells the story, not the way the array is written. */
export const roadmapOrder = (): ModuleManifest[] =>
  [...MODULES].sort((a, b) => a.roadmap.order - b.roadmap.order)

const STATUS_LABEL: Record<ModuleManifest['status'], string> = {
  live: 'Available now',
  'in-development': 'In development',
  planned: 'Planned',
}

export const statusLabel = (s: ModuleManifest['status']): string => STATUS_LABEL[s]
