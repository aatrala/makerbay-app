import { randomBytes } from 'node:crypto'

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Compact ULID: 10-char Crockford-base32 timestamp + 16 random chars. */
export function ulid(now = Date.now()): string {
  let t = now
  const time: string[] = new Array(10)
  for (let i = 9; i >= 0; i--) {
    time[i] = B32[t % 32]
    t = Math.floor(t / 32)
  }
  const rand = Array.from(randomBytes(16), (b) => B32[b & 31])
  return time.join('') + rand.join('')
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  const suffix = Array.from(randomBytes(3), (b) => B32[b & 31].toLowerCase()).join('')
  return base ? `${base}-${suffix}` : suffix
}
