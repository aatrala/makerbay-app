/**
 * The propose/execute split, lifted from Genie so the setup agent inherits it
 * rather than growing a parallel one.
 *
 * The load-bearing property, and the reason this shape is worth preserving:
 * **the agent never holds a credential.** An executor is handed the caller's
 * own bearer token and calls the ordinary module API with it, so
 * authorisation, entitlements, emails, contact events and usage all run the
 * same code path as a button press. An agent cannot reach anything its human
 * could not.
 */

const API = () => process.env.API_BASE ?? 'https://api.makerbay.app'

export interface ProposedAction {
  /** One sentence the confirmation card shows. Built server-side, never by a model. */
  summary: string
  /** Frozen at propose time. The confirm request contributes nothing but an id. */
  params: Record<string, string>
}

export interface WriteTool {
  propose: (
    tenantId: string,
    args: Record<string, unknown>,
  ) => Promise<ProposedAction | { error: string }>
  execute: (
    params: Record<string, string>,
    auth: string,
  ) => Promise<{ receipt: string } | { error: string }>
  audit: (
    params: Record<string, string>,
    receipt: string,
  ) => { action: string; moduleId: string; targetId?: string }
}

export async function apiCall(
  method: string,
  path: string,
  auth: string,
  payload?: Record<string, unknown>,
): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const r = await fetch(`${API()}${path}`, {
    method,
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  })
  const parsed = (await r.json().catch(() => ({}))) as Record<string, unknown>
  return { ok: r.ok, body: parsed }
}

/** Ids come from server reads, never from model text or scraped content. */
export const ULID_RE = /^[0-9A-Z]{26}$/
