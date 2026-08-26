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
