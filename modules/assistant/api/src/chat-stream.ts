import { CognitoJwtVerifier } from 'aws-jwt-verify'
import {
  emitUsage,
  findApiKeyByHash,
  getEntitlements,
  getMonthUsage,
  getTenant,
  getTenantBySlug,
  getUser,
  hashApiKey,
  ulid,
} from '@makerbay/core'
import { getConfig, getSessionMessages, putMessage } from './db'
import { classifyAnswer, retrieveChunks, streamAnswer } from './rag'

// Provided by the Lambda Node runtime when the function is deployed with
// RESPONSE_STREAM invoke mode.
declare const awslambda: {
  streamifyResponse: (
    fn: (event: FunctionUrlEvent, responseStream: ResponseStream, context: unknown) => Promise<void>,
  ) => unknown
  HttpResponseStream: {
    from: (stream: ResponseStream, metadata: { statusCode: number; headers: Record<string, string> }) => ResponseStream
  }
}

interface ResponseStream {
  write: (chunk: string) => void
  end: () => void
}

interface FunctionUrlEvent {
  requestContext: { http: { method: string } }
  headers?: Record<string, string | undefined>
  body?: string
  isBase64Encoded?: boolean
}

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID!,
  tokenUse: 'id',
  clientId: process.env.USER_POOL_CLIENT_ID!,
})

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'POST,OPTIONS',
}

/**
 * Streaming chat. Emits newline-delimited JSON so browsers can render tokens
 * as they arrive: one `meta` line, many `delta` lines, one `done` line.
 * The non-streaming route stays available for API callers that want a single
 * JSON response.
 */
const streamingHandler = async (
  event: FunctionUrlEvent,
  responseStream: ResponseStream,
): Promise<void> => {
  const method = event.requestContext?.http?.method ?? 'POST'
  if (method === 'OPTIONS') {
    awslambda.HttpResponseStream.from(responseStream, { statusCode: 204, headers: CORS }).end()
    return
  }

  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: { ...CORS, 'content-type': 'application/x-ndjson' },
  })
  const send = (obj: unknown) => stream.write(`${JSON.stringify(obj)}\n`)
  const fail = (error: string) => {
    send({ type: 'error', error })
    stream.end()
  }

  try {
    const raw = event.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body ?? '{}'
    const body = JSON.parse(raw)
    const message = String(body.message ?? '').trim()
    if (!message) return fail('message_required')

    const tenantId = await resolveTenant(event, body)
    if (!tenantId) return fail('unauthorized')

    const entitlement = (await getEntitlements(tenantId)).modules.assistant
    if (!entitlement?.enabled) return fail('module_not_enabled')

    const limit = entitlement.limits.messagesPerMonth ?? 200
    const used = (await getMonthUsage(tenantId, new Date().toISOString().slice(0, 7)))['assistant.message'] ?? 0
    if (used >= limit) return fail('limit_exceeded')

    const sessionId = /^[A-Z0-9]{10,32}$/.test(String(body.sessionId ?? '')) ? body.sessionId : ulid()
    const config = await getConfig(tenantId)
    const history = await getSessionMessages(tenantId, sessionId, 10)
    const chunks = await retrieveChunks(tenantId, message)

    const now = new Date().toISOString()
    const messageId = `${now}#${ulid()}`
    send({ type: 'meta', sessionId, messageId })

    let answer = config.fallbackMessage
    let fallback = true
    let tokens = 0

    if (chunks.length > 0) {
      // Hold back the opening tokens: the model occasionally leads with the
      // fallback sentence and then answers anyway, and once a token is on the
      // wire it cannot be retracted.
      const holdUntil = config.fallbackMessage.length + 40
      let buffered = ''
      let flushed = false

      const result = await streamAnswer(config, chunks, history, message, (delta) => {
        if (flushed) {
          send({ type: 'delta', text: delta })
          return
        }
        buffered += delta
        if (buffered.length < holdUntil) return
        const decided = classifyAnswer(buffered, config.fallbackMessage)
        flushed = true
        send({ type: 'delta', text: decided.text })
      })
      tokens = result.inputTokens + result.outputTokens

      const decided = classifyAnswer(result.text, config.fallbackMessage)
      answer = decided.text
      fallback = decided.fallback
      // Nothing was flushed if the whole reply was shorter than the hold-back.
      if (!flushed) send({ type: 'delta', text: answer })
    } else {
      send({ type: 'delta', text: answer })
    }

    const citations = fallback
      ? []
      : [...new Map(chunks.map((c) => [c.sourceId, c])).values()].map((c) => ({
          sourceId: c.sourceId,
          name: c.sourceName,
          excerpt: c.text.slice(0, 160),
        }))

    const pk = `${tenantId}#${sessionId}`
    const common = { pk, tenantId, sessionId }
    await putMessage({ ...common, sk: `${now}#0${ulid()}`, role: 'user', text: message })
    await putMessage({ ...common, sk: messageId, role: 'assistant', text: answer, citations, fallback })

    await emitUsage({ tenantId, moduleId: 'assistant', metric: 'message', quantity: 1 })
    if (tokens > 0) await emitUsage({ tenantId, moduleId: 'assistant', metric: 'tokens', quantity: tokens })

    send({ type: 'done', sessionId, messageId, citations, fallback })
    stream.end()
  } catch (err) {
    console.error('chat-stream error', err)
    fail('internal_error')
  }
}

/**
 * Same identities the non-streaming routes accept: a dashboard user's Cognito
 * token, a publishable key, or a workspace slug. Secret keys are rejected —
 * a public chat surface never needs more than chat access.
 */
async function resolveTenant(event: FunctionUrlEvent, body: Record<string, unknown>): Promise<string> {
  const auth = (event.headers?.authorization ?? event.headers?.Authorization ?? '').replace(/^Bearer\s+/i, '').trim()
  if (auth && !auth.startsWith('mb_sk_')) {
    if (auth.startsWith('mb_pk_')) return (await keyTenant(auth)) ?? ''
    try {
      const payload = await verifier.verify(auth)
      return (await getUser(payload.sub))?.tenantId ?? ''
    } catch {
      return ''
    }
  }

  const key = typeof body.key === 'string' ? body.key : undefined
  if (key) return (await keyTenant(key)) ?? ''

  const slug = typeof body.slug === 'string' ? body.slug : undefined
  if (slug) {
    const tenant = await getTenantBySlug(slug)
    return tenant?.status === 'active' ? tenant.tenantId : ''
  }
  return ''
}

async function keyTenant(key: string): Promise<string | undefined> {
  if (!key.startsWith('mb_pk_')) return undefined
  const row = await findApiKeyByHash(hashApiKey(key))
  if (!row || row.type !== 'publishable' || !row.scopes.includes('chat:invoke')) return undefined
  return (await getTenant(row.tenantId)) ? row.tenantId : undefined
}

export const handler = awslambda.streamifyResponse(streamingHandler)
