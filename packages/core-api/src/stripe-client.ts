import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import Stripe from 'stripe'

const sm = new SecretsManagerClient({})
let cached: { apiKey: string; webhookSecret: string } | undefined

/**
 * Stripe credentials from Secrets Manager. Values stay in memory for the
 * life of the execution environment and are never logged.
 */
async function credentials(): Promise<{ apiKey: string; webhookSecret: string }> {
  if (cached) return cached
  const r = await sm.send(new GetSecretValueCommand({ SecretId: process.env.STRIPE_SECRET_ARN! }))
  const parsed = JSON.parse(r.SecretString ?? '{}')
  if (!parsed.apiKey || parsed.apiKey === 'REPLACE_ME') throw new Error('stripe_not_configured')
  cached = { apiKey: parsed.apiKey, webhookSecret: parsed.webhookSecret ?? '' }
  return cached
}

export async function stripeClient(): Promise<Stripe> {
  const { apiKey } = await credentials()
  return new Stripe(apiKey, { apiVersion: '2025-10-29.clover' as Stripe.LatestApiVersion })
}

export async function webhookSecret(): Promise<string> {
  return (await credentials()).webhookSecret
}

/** True while the account is on Stripe test keys. */
export async function isTestMode(): Promise<boolean> {
  return (await credentials()).apiKey.startsWith('sk_test_')
}

// ── Plan catalog ─────────────────────────────────────────────────────────
// Base subscription plus metered overage: the SMB pays a predictable floor
// and only pays more when the assistant is actually used.

export interface PlanDefinition {
  id: string
  name: string
  monthlyPriceCents: number
  includedMessages: number
  overageCentsPerMessage: number
  limits: Record<string, number>
}

export const PLANS: Record<string, PlanDefinition> = {
  free: {
    id: 'free',
    name: 'Free',
    monthlyPriceCents: 0,
    includedMessages: 200,
    overageCentsPerMessage: 0,
    limits: { messagesPerMonth: 200, sources: 20, sourceBytes: 25 * 1024 * 1024 },
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    monthlyPriceCents: 2900,
    includedMessages: 2000,
    overageCentsPerMessage: 2,
    limits: { messagesPerMonth: 100000, sources: 500, sourceBytes: 2 * 1024 * 1024 * 1024 },
  },
}

export const PRO_PRODUCT_KEY = 'makerbay-assistant-pro'
