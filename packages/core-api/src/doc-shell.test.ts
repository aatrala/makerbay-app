import { describe, expect, it, vi } from 'vitest'

/**
 * The link-preview card (issue 118 phase 2).
 *
 * The requirement is that the card cannot carry a price or a customer's name
 * into a group chat. The strongest guarantee is structural - this function is
 * never given the token, so it cannot identify a document - but these tests
 * pin the observable half: nothing about the document reaches the HTML.
 */

const tenants: Record<string, { name: string } | undefined> = {
  'dunn-plumbing': { name: 'Dunn Plumbing' },
  'renamed-old-slug': { name: 'Dunn Plumbing' },
}

vi.mock('@makerbay/core', () => ({
  getTenantBySlugOrAlias: async (slug: string) => tenants[slug],
}))

const { handler } = await import('./doc-shell')

const render = async (slug?: string, kind?: string) =>
  handler({ queryStringParameters: { ...(slug ? { slug } : {}), ...(kind ? { kind } : {}) } } as never)

describe('doc shell', () => {
  it('names the business in the card, not MakerBay', async () => {
    const r = await render('dunn-plumbing', 'quote')
    expect(r.body).toContain('<meta property="og:title" content="Quote from Dunn Plumbing" />')
    // The customer is deciding whether they trust their tradesperson, and has
    // never heard of us.
    expect(r.body).toContain('<meta property="og:site_name" content="Dunn Plumbing" />')
  })

  it('says which kind of document it is', async () => {
    expect((await render('dunn-plumbing', 'invoice')).body).toContain('Invoice from Dunn Plumbing')
    expect((await render('dunn-plumbing', 'quote')).body).toContain('Quote from Dunn Plumbing')
  })

  it('sets a real title, which the old static shell never did', async () => {
    const r = await render('dunn-plumbing', 'quote')
    expect(r.body).toContain('<title>Quote from Dunn Plumbing</title>')
    expect(r.body).not.toContain('<title>Chat</title>')
  })

  /**
   * The whole point. This function receives a slug and a kind - the token is
   * discarded at the edge - so there is no argument here that could identify a
   * document even if someone added code to look one up.
   */
  it('has no way to be told which document it is', async () => {
    const r = await handler({
      queryStringParameters: {
        slug: 'dunn-plumbing', kind: 'quote',
        // Everything an attacker or a careless refactor might try to pass.
        token: 'IdC_9xKq2mVvA1sPzR7bWnLe', quoteId: '01J8ZXQ7T4Y9V2M6K3N5P8R1QW',
      },
    } as never)
    expect(r.body).not.toContain('IdC_9xKq2mVvA1sPzR7bWnLe')
    expect(r.body).not.toContain('01J8ZXQ7T4Y9V2M6K3N5P8R1QW')
  })

  it('carries no amount, no customer and no document number', async () => {
    const r = await render('dunn-plumbing', 'quote')
    expect(r.body).not.toMatch(/\$\s?\d/)
    expect(r.body).not.toMatch(/\bQ-\d/)
    expect(r.body).not.toMatch(/\bINV-\d/)
  })

  // og:url would be the easy way to echo a token back into the card.
  it('emits no og:url, so the link cannot leak through the card', async () => {
    expect((await render('dunn-plumbing', 'quote')).body).not.toMatch(/<meta[^>]+og:url/)
  })

  // A card that sometimes vanishes is worse than a text card that always
  // renders: the only image available is an uncapped phone photo.
  it('emits no og:image while there is no bounded image to point at', async () => {
    expect((await render('dunn-plumbing', 'quote')).body).not.toMatch(/<meta[^>]+og:image/)
  })

  it('serves under an old address after a rename', async () => {
    expect((await render('renamed-old-slug', 'quote')).body).toContain('Dunn Plumbing')
  })

  // An unknown slug and a revoked link must look identical, or the preview
  // becomes an oracle for which businesses exist.
  it('says nothing about why an unknown link failed', async () => {
    const r = await render('no-such-business', 'quote')
    expect(r.statusCode).toBe(404)
    expect(r.body).not.toContain('no-such-business')
    expect(r.body.toLowerCase()).not.toContain('not found')
  })

  it('still serves a page when the lookup throws', async () => {
    const core = await import('@makerbay/core')
    const spy = vi.spyOn(core, 'getTenantBySlugOrAlias').mockRejectedValueOnce(new Error('ddb down'))
    const r = await render('dunn-plumbing', 'quote')
    // The customer's document is fine; only the card is not. A 500 here would
    // break the link itself.
    expect(r.body).toContain('<html')
    spy.mockRestore()
  })

  it('escapes a business name rather than letting it write markup', async () => {
    tenants['xss-co'] = { name: '"><script>alert(1)</script>' }
    const r = await render('xss-co', 'quote')
    expect(r.body).not.toContain('<script>alert(1)')
    expect(r.body).toContain('&lt;script&gt;')
    delete tenants['xss-co']
  })

  it('keeps the page out of search indexes', async () => {
    expect((await render('dunn-plumbing', 'quote')).body).toContain('noindex')
  })

  it('sets the headers a document page needs', async () => {
    const r = await render('dunn-plumbing', 'quote')
    expect(r.headers['content-type']).toContain('text/html')
    expect(r.headers['referrer-policy']).toBe('no-referrer')
    expect(r.headers['x-content-type-options']).toBe('nosniff')
  })

  it('is cacheable per business, since the token never reaches it', async () => {
    expect((await render('dunn-plumbing', 'quote')).headers['cache-control']).toContain('max-age=')
  })

  it('defaults to quote rather than failing on a missing kind', async () => {
    expect((await render('dunn-plumbing')).body).toContain('Quote from Dunn Plumbing')
  })

  it('refuses to render a card with no business at all', async () => {
    expect((await render()).statusCode).toBe(404)
  })
})
