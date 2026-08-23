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
}
