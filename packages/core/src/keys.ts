import { createHash, randomBytes } from 'node:crypto'

export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

export function generateApiKey(type: 'secret' | 'publishable'): { secret: string; hash: string } {
  const prefix = type === 'secret' ? 'mb_sk' : 'mb_pk'
  const secret = `${prefix}_${randomBytes(24).toString('base64url')}`
  return { secret, hash: hashApiKey(secret) }
}

export const SCOPES_BY_KEY_TYPE: Record<'secret' | 'publishable', string[]> = {
  secret: ['*'],
  publishable: ['chat:invoke'],
}
