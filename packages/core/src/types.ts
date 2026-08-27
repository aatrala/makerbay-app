export interface ModuleEntitlement {
  enabled: boolean
  plan: string
  limits: Record<string, number>
}

export interface Entitlements {
  modules: Record<string, ModuleEntitlement>
}

export interface TenantRow {
  tenantId: string
  name: string
  slug: string
  plan: string
  status: 'active' | 'suspended'
  createdAt: string
  // Billing state, written only by the billing handlers.
  stripeCustomerId?: string
  stripeSubscriptionId?: string
  stripeMeteredItemId?: string
  subscriptionStatus?: string
  currentPeriodEnd?: string
  // Webhook health, so "is Stripe actually reaching us" is answerable from
  // the dashboard rather than from CloudWatch.
  lastWebhookAt?: string
  lastWebhookType?: string
  lastWebhookLive?: boolean
  // Stripe Connect state, written only by the payments module. payoutsEnabled
  // is the single flag every public surface checks before showing a pay
  // button - no onboarded account, no button, never a dead control.
  stripeAccountId?: string
  payoutsEnabled?: boolean
  connectOnboardedAt?: string
  /**
   * IANA zone, detected in the browser at signup. Every module that shows a
   * time falls back to this rather than to a constant, so a workspace outside
   * Australia is not quietly told its bookings are in Sydney.
   */
  timezone?: string
}

export interface UserRow {
  userId: string
  email?: string
  tenantId: string
  role: 'owner' | 'member'
  createdAt: string
}

export interface ApiKeyRow {
  tenantId: string
  keyId: string
  keyHash: string
  type: 'secret' | 'publishable'
  scopes: string[]
  label: string
  createdAt: string
}

/** Caller identity resolved by the authorizer and passed via request context. */
export interface CallerContext {
  tenantId: string
  userId?: string
  email?: string
  keyId?: string
  scopes: string
  entitlements: string
  /**
   * Set only when a delegated principal is acting for an owner: a setup job
   * the owner granted with one tap (docs/spec-concierge.md). Present here so
   * every write can be attributed to the job and the person who authorised
   * it, rather than recorded as the owner doing it themselves. The key type
   * that populates these arrives with phase 1; until then they are never set,
   * and the code reading them falls through to the ordinary user branch.
   */
  taskId?: string
  onBehalfOf?: string
}

// ── Contacts ─────────────────────────────────────────────────────────────
// Core substrate: every workspace has these, no entitlement gates them.

export type ContactStatus = 'new' | 'contacted' | 'active' | 'won' | 'lost'

export interface ContactRow {
  tenantId: string
  contactId: string
  name?: string
  email?: string
  phone?: string
  status: ContactStatus
  note?: string
  tags?: string[]
  /** Which module first created this contact. */
  source?: string
  createdAt: string
  updatedAt: string
  lastActivityAt?: string
  /** GSI key for dedupe: tenantId#email:... or tenantId#phone:... */
  identityKey?: string
  /** Lowercased haystack, because DynamoDB contains() is case-sensitive. */
  searchText?: string
}

export interface ContactEventRow {
  pk: string
  sk: string
  tenantId: string
  contactId: string
  moduleId: string
  title: string
  body?: string
  href?: string
  at: string
}
