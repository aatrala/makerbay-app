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
  let raw: string
  try {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: process.env.STRIPE_SECRET_ARN! }))
    raw = r.SecretString ?? ''
  } catch (err) {
    console.error('could not read stripe secret', {
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : '',
    })
    throw new Error('stripe_not_configured')
  }

  let parsed: Record<string, string>
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Shape only — no secret content in the log.
    console.warn('stripe secret is not valid JSON', {
      length: raw.length,
      startsWithBrace: raw.trimStart().startsWith('{'),
    })
    throw new Error('stripe_not_configured')
  }

  // Accept the common field-name variants so a hand-edited secret works.
  const apiKey: string = parsed.apiKey ?? parsed.api_key ?? parsed.secretKey ?? parsed.STRIPE_SECRET_KEY ?? ''
  const hook: string =
    parsed.webhookSecret ?? parsed.webhook_secret ?? parsed.signingSecret ?? parsed.STRIPE_WEBHOOK_SECRET ?? ''

  // Secret keys are sk_*, restricted keys rk_* — both are valid server-side.
  const usable = /^(sk|rk)_(test|live)_/.test(apiKey)
  if (!usable) {
    // Field names and the key-type prefix only — never key material.
    console.warn('stripe credentials unusable', {
      fieldsPresent: Object.keys(parsed),
      apiKeyPrefix: apiKey ? `${apiKey.slice(0, 8)}…` : '(empty)',
      apiKeyLength: apiKey.length,
      webhookSecretPrefix: hook ? `${hook.slice(0, 6)}…` : '(empty)',
    })
    throw new Error('stripe_not_configured')
  }
  cached = { apiKey, webhookSecret: hook }
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
/** Billing Meter event name. Metered prices must be backed by a meter. */
export const METER_EVENT_NAME = 'makerbay_assistant_messages'
