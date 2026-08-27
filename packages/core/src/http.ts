/**
 * The JSON response every handler returns. This was copied into nineteen
 * files; one home means a header or a serialisation rule changes once.
 *
 * Typed structurally rather than as APIGatewayProxyResultV2 so core stays
 * free of Lambda typings -- the shape is assignable to it, so handlers keep
 * their `Promise<APIGatewayProxyResultV2>` signatures unchanged.
 */
export interface JsonResult {
  statusCode: number
  headers: Record<string, string>
  body: string
}

export const json = (statusCode: number, body: unknown): JsonResult => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/**
 * Scope enforcement.
 *
 * Before this existed, three places in the whole platform read `ctx.scopes`
 * and all three treated it as the boolean `=== '*'`. No module handler
 * enforced a named scope, and secret keys carry `['*']`, so "give this caller
 * limited access" was not expressible. That is the prerequisite for any
 * delegated principal - a concierge job acting for an owner (see
 * docs/spec-concierge.md) must be able to write a page and nothing else.
 *
 * Additive by design: `'*'` still passes everything, so every existing
 * secret key and every Cognito session behaves exactly as before.
 */

/** Scopes a delegated or restricted caller can be granted. Deliberately narrow. */
export type Scope =
  | 'presence:config:write'
  | 'presence:page:write'
  | 'presence:photo:write'
  | 'assistant:config:write'
  | 'assistant:sources:write'
  | 'assistant:help:publish'
  | 'booking:services:write'
  | 'booking:config:write'
  | 'payments:connect:start'
  | 'chat:invoke'

/**
 * Never mintable on a delegation, whatever the owner confirms: minting further
 * keys, billing, destroying a workspace, or anything that emails a customer.
 * Enforced by the routes themselves rejecting non-'*' callers.
 */
export const NEVER_DELEGATED = ['core:keys:write', 'core:billing:write', 'core:tenant:delete'] as const

export const hasScope = (ctx: { scopes: string }, scope: Scope): boolean => {
  const held = String(ctx.scopes ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return held.includes('*') || held.includes(scope)
}

/**
 * Returns a 403 when the caller lacks the scope, or undefined when it holds
 * it. Call at the top of a mutating route:
 *
 *   const denied = requireScope(ctx, 'booking:services:write')
 *   if (denied) return denied
 */
export const requireScope = (ctx: { scopes: string }, scope: Scope): JsonResult | undefined =>
  hasScope(ctx, scope)
    ? undefined
    : json(403, {
        error: 'insufficient_scope',
        required: scope,
        message: 'This key is not allowed to do that.',
      })
