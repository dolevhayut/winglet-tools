import { ENV } from '@product'
import { describe, expect, it } from 'vitest'

import { AI_CRAWLERS, robotsFrom, sitemapFrom } from '../src/seo'

const ORIGIN = { [ENV.siteOrigin]: 'https://example.co.il' }

function payload(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'p',
    contentVersion: 1,
    types: ['page', 'accommodation'],
    documents: { page: [], post: [], product: [], collection: [] },
    documentsByType: {},
    total: 0,
    truncated: false,
    ...overrides,
  }
}

const clientReturning = (value: ReturnType<typeof payload>) => ({
  getAll: async () => value as never,
})

describe('sitemapFrom', () => {
  it('uses the seeded page type at /{slug}, with home at the root', async () => {
    const client = clientReturning(
      payload({
        documents: {
          page: [
            { slug: 'home', _updatedAt: '2026-08-01T00:00:00.000Z' },
            { slug: 'about', _updatedAt: '2026-08-02T00:00:00.000Z' },
          ],
          post: [], product: [], collection: [],
        },
      }),
    )

    const entries = await sitemapFrom({ env: ORIGIN, client })()

    expect(entries.map((entry) => entry.url)).toEqual([
      'https://example.co.il/',
      'https://example.co.il/about',
    ])
    expect(entries[1]?.lastModified).toEqual(new Date('2026-08-02T00:00:00.000Z'))
  })

  /**
   * The design, asserted. A slug is not a route: this document is served at
   * `/accommodations/bikta-marva`, and only the app knows that.
   */
  it('omits a type with no declared route rather than guessing one', async () => {
    const client = clientReturning(
      payload({ documentsByType: { accommodation: [{ slug: 'bikta-marva' }] } }),
    )

    expect(await sitemapFrom({ env: ORIGIN, client })()).toEqual([])

    const declared = await sitemapFrom({
      env: ORIGIN,
      client,
      routes: { accommodation: (doc) => `/accommodations/${(doc as { slug: string }).slug}` },
    })()
    expect(declared.map((entry) => entry.url)).toEqual([
      'https://example.co.il/accommodations/bikta-marva',
    ])
  })

  it('takes a fixed path for a singleton, and never emits it twice', async () => {
    const client = clientReturning(
      payload({ documentsByType: { pricePage: [{ slug: 'prices' }, { slug: 'prices-old' }] } }),
    )

    const entries = await sitemapFrom({ env: ORIGIN, client, routes: { pricePage: '/prices' } })()

    expect(entries.map((entry) => entry.url)).toEqual(['https://example.co.il/prices'])
  })

  it('skips a document whose route function declines it', async () => {
    const client = clientReturning(
      payload({ documentsByType: { accommodation: [{ slug: 'a', hidden: true }, { slug: 'b' }] } }),
    )

    const entries = await sitemapFrom({
      env: ORIGIN,
      client,
      routes: {
        accommodation: (doc) =>
          (doc as { hidden?: boolean }).hidden === true ? null : `/x/${(doc as { slug: string }).slug}`,
      },
    })()

    expect(entries.map((entry) => entry.url)).toEqual(['https://example.co.il/x/b'])
  })

  /**
   * Found by shipping a sitemap that omitted `/area` — a real page of the demo
   * that renders every area guide and is itself no document.
   */
  it('carries paths that are not documents, without inventing a date for them', async () => {
    const client = clientReturning(payload())

    const entries = await sitemapFrom({ env: ORIGIN, client, extra: ['/area', '/about'] })()

    expect(entries.map((entry) => entry.url)).toEqual([
      'https://example.co.il/area',
      'https://example.co.il/about',
    ])
    expect(entries[0]?.lastModified).toBeUndefined()
  })

  it('emits nothing when no origin is configured, because every URL must be absolute', async () => {
    const client = clientReturning(
      payload({ documents: { page: [{ slug: 'about' }], post: [], product: [], collection: [] } }),
    )

    expect(await sitemapFrom({ env: {}, client })()).toEqual([])
  })

  /**
   * A sitemap that 500s is dropped by Search Console as broken. An empty one is
   * merely uninformative, and the next revalidation repairs it.
   */
  it('returns empty rather than throwing when the API is unreachable', async () => {
    const client = { getAll: async () => { throw new Error('ECONNREFUSED') } }

    await expect(sitemapFrom({ env: ORIGIN, client })()).resolves.toEqual([])
  })
})

describe('robotsFrom', () => {
  it('allows everything and points at the sitemap', () => {
    const robots = robotsFrom({ env: ORIGIN })

    expect(robots.sitemap).toBe('https://example.co.il/sitemap.xml')
    expect(robots.rules[0]).toMatchObject({ userAgent: '*', allow: '/' })
  })

  it('names the AI crawlers so the decision is visible and reversible', () => {
    const robots = robotsFrom({ env: ORIGIN })
    const ai = robots.rules[1]

    expect(ai?.userAgent).toEqual([...AI_CRAWLERS])
    expect(ai?.allow).toBe('/')
    expect(AI_CRAWLERS).toContain('GPTBot')
    expect(AI_CRAWLERS).toContain('Google-Extended')
  })

  it('flips them to disallow on request', () => {
    expect(robotsFrom({ env: ORIGIN, allowAi: false }).rules[1]).toMatchObject({ disallow: '/' })
  })

  /** A Sitemap line naming a host that is not this one misdirects every reader. */
  it('omits the sitemap line when no origin is configured', () => {
    expect(robotsFrom({ env: {} }).sitemap).toBeUndefined()
  })
})
