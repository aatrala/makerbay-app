import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import type { CallerContext, Entitlements } from '@makerbay/core'

type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<CallerContext>

// M0 stub: proves the module seam (routing + entitlement gate) end to end.
// The real RAG pipeline lands in M1.
export const handler = async (event: Event): Promise<APIGatewayProxyResultV2> => {
  const ctx = event.requestContext.authorizer.lambda
  const entitlements: Entitlements = JSON.parse(ctx.entitlements || '{"modules":{}}')

  if (!entitlements.modules.assistant?.enabled) {
    return {
      statusCode: 403,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'module_not_enabled', moduleId: 'assistant' }),
    }
  }

  return {
    statusCode: 501,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: 'not_implemented', note: 'Assistant module arrives in M1' }),
  }
}
