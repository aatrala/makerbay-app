import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { getEffectiveEntitlement, getTenant, getUser, type CallerContext } from '@makerbay/core'
// Tool definitions live with the module that owns them. When a second module
// ships tools this becomes a registry keyed by moduleId.
import { assistantTools, type McpTool } from '../../../modules/assistant/api/src/mcp-tools'

type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<CallerContext>

/**
 * MCP server over the Streamable HTTP transport, stateless.
 *
 * Stateless is a deliberate choice: every request carries its own credential
 * and nothing needs to be remembered between calls, so no session id is
 * issued and no session state can be lost or leaked between tenants.
 */

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0]
const SERVER_INFO = { name: 'makerbay', title: 'MakerBay', version: '0.1.0' }

const JSON_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type,mcp-protocol-version,mcp-session-id',
  'access-control-allow-methods': 'POST,GET,DELETE,OPTIONS',
}

type JsonRpcId = string | number | null

const reply = (id: JsonRpcId, result: unknown): APIGatewayProxyResultV2 => ({
  statusCode: 200,
  headers: JSON_HEADERS,
  body: JSON.stringify({ jsonrpc: '2.0', id, result }),
})

const rpcError = (id: JsonRpcId, code: number, message: string, data?: unknown): APIGatewayProxyResultV2 => ({
  statusCode: 200,
  headers: JSON_HEADERS,
  body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } }),
})

const httpError = (statusCode: number, message: string): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: JSON_HEADERS,
  body: JSON.stringify({ error: message }),
})

export const handler = async (event: Event): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method

  if (method === 'OPTIONS') return { statusCode: 204, headers: JSON_HEADERS, body: '' }
  // We never push server-initiated messages, so there is no stream to open and
  // no session to delete. The spec allows declining both with 405.
  if (method === 'GET' || method === 'DELETE') return httpError(405, 'method_not_allowed')
  if (method !== 'POST') return httpError(405, 'method_not_allowed')

  // A version we do not implement must be rejected rather than guessed at.
  const declared = event.headers['mcp-protocol-version'] ?? event.headers['MCP-Protocol-Version']
  if (declared && !SUPPORTED_PROTOCOLS.includes(declared)) {
    return httpError(400, `unsupported_protocol_version: ${declared}`)
  }

  let message: any
  try {
    message = JSON.parse(event.body ?? '{}')
  } catch {
    return rpcError(null, -32700, 'Parse error')
  }
  if (Array.isArray(message)) return rpcError(null, -32600, 'Batching is not supported')

  const { id = null, method: rpcMethod, params } = message ?? {}
  const isNotification = id === null || id === undefined

  try {
    // initialize is answered before any tenant lookup so a client can discover
    // the server even while sorting out credentials.
    if (rpcMethod === 'initialize') {
      const requested = params?.protocolVersion
      return reply(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : LATEST_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Tools operate on one MakerBay workspace, identified by the API key in the Authorization header. ' +
          'ask_assistant answers from that workspace\'s documents and counts against its plan; search_knowledge ' +
          'returns raw passages without generating an answer.',
      })
    }

    if (rpcMethod === 'ping') return reply(id, {})

    // Notifications get 202 with no body, per the transport spec.
    if (typeof rpcMethod === 'string' && rpcMethod.startsWith('notifications/')) {
      return { statusCode: 202, headers: JSON_HEADERS, body: '' }
    }

    const caller = await resolveCaller(event)
    if (!caller.tenantId) {
      return rpcError(id, -32001, 'Unauthorized: provide a MakerBay secret API key as a Bearer token.')
    }

    const tools = await availableTools(caller.tenantId)

    if (rpcMethod === 'tools/list') {
      return reply(id, {
        tools: tools.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      })
    }

    if (rpcMethod === 'tools/call') {
      const name = params?.name
      const tool = tools.find((t) => t.name === name)
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`)
      if (tool.write && !caller.canWrite) {
        return reply(id, {
          content: [{ type: 'text', text: `${tool.name} needs a secret API key with write access.` }],
          isError: true,
        })
      }
      try {
        const output = await tool.run(caller.tenantId, params?.arguments ?? {})
        return reply(id, { content: [{ type: 'text', text: output }] })
      } catch (err) {
        // Tool failures are reported inside the result, not as protocol
        // errors, so the agent can read the reason and adapt.
        const text = err instanceof Error ? err.message : 'Tool call failed.'
        return reply(id, { content: [{ type: 'text', text }], isError: true })
      }
    }

    if (isNotification) return { statusCode: 202, headers: JSON_HEADERS, body: '' }
    return rpcError(id, -32601, `Method not found: ${rpcMethod}`)
  } catch (err) {
    console.error('mcp error', { rpcMethod, err })
    return rpcError(id, -32603, 'Internal error')
  }
}

async function resolveCaller(event: Event): Promise<{ tenantId: string; canWrite: boolean }> {
  const ctx = event.requestContext.authorizer?.lambda
  if (!ctx) return { tenantId: '', canWrite: false }

  // Dashboard users and secret keys may write; publishable keys are public
  // credentials and must not reach write tools.
  if (ctx.userId) {
    const user = await getUser(ctx.userId)
    return { tenantId: user?.tenantId ?? '', canWrite: true }
  }
  if (ctx.keyId) {
    const tenant = ctx.tenantId ? await getTenant(ctx.tenantId) : undefined
    return { tenantId: tenant?.tenantId ?? '', canWrite: ctx.scopes === '*' }
  }
  return { tenantId: '', canWrite: false }
}

/** Only tools whose module the workspace actually has enabled. */
async function availableTools(tenantId: string): Promise<McpTool[]> {
  const assistant = await getEffectiveEntitlement(tenantId, 'assistant')
  return assistant.enabled ? assistantTools : []
}
