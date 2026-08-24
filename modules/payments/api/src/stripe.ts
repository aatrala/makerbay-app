import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import Stripe from 'stripe'

/**
 * Same secret, same discipline as packages/core-api/src/stripe-client.ts:
 * credentials stay in Lambda memory, are never logged, and never enter a
 * response. Duplicated here because modules import only from @makerbay/core,
 * and the platform's billing client is core-api territory.
 */

const sm = new SecretsManagerClient({})
let cached: string | undefined

async function apiKey(): Promise<string> {
  if (cached) return cached
  const r = await sm.send(new GetSecretValueCommand({ SecretId: process.env.STRIPE_SECRET_ARN! }))
  const parsed = JSON.parse(r.SecretString ?? '{}') as Record<string, string>
  const key = parsed.apiKey ?? parsed.api_key ?? parsed.secretKey ?? ''
  if (!/^(sk|rk)_(test|live)_/.test(key)) throw new Error('stripe_not_configured')
  cached = key
  return key
}

export async function stripe(): Promise<Stripe> {
  return new Stripe(await apiKey(), { apiVersion: '2025-10-29.clover' as Stripe.LatestApiVersion })
}

export async function isTestMode(): Promise<boolean> {
  return (await apiKey()).startsWith('sk_test_')
}
