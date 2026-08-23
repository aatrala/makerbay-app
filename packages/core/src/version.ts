import assistantManifest from '../../../modules/assistant/module.json'

/**
 * One manifest per module, and one place that knows the platform version.
 * The same file feeds the version endpoint, the dashboard footer and (later)
 * the marketing module pages, so a module cannot be described in two places
 * that disagree.
 */

export interface ModuleManifest {
  id: string
  name: string
  tagline: string
  status: 'live' | 'in-development' | 'planned'
  version: Record<string, string>
  routes: string[]
  meteredMetrics: string[]
  entitlementKey: string
}

/** Platform version: the core (tenancy, auth, entitlements, billing) itself. */
export const PLATFORM_VERSION = '1.4.0'

export const MODULES: ModuleManifest[] = [assistantManifest as ModuleManifest]

export const moduleManifest = (id: string): ModuleManifest | undefined =>
  MODULES.find((m) => m.id === id)
