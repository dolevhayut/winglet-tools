import { createHash, createHmac } from 'node:crypto'

import { ENV } from '@product'
import { describe, expect, it } from 'vitest'

import { metadataFor, metadataFrom } from '../src/seo'
import type { SeoDocument } from '../src/seo'

/**
 * M21.2 — the `<head>` comes from the document, not from the code.
 *
 * The assertions that matter most are the negative ones: a field the owner left
 * empty must produce NO tag rather than an empty one, and a canonical must be
 * absent rather than wrong when the origin is unknown. Both failure modes are
 * silent in a browser and expensive in a search index.
 */

const API = 'https://api.example.test/v1'
const READ_KEY = 'read_key_for_tests'
const ASSET = '11111111-2222-3333-4444-555555555555'

const env = {
  [ENV.apiUrl]: API,
  [ENV.projectId]: 'project-under-test',
  [ENV.readKey]: READ_KEY,
} as const

/**
 * `metadataBase` is declared `string | URL | null`, so it is narrowed here once
 * rather than asserted on directly in eight places.
 */
function baseOrigin(meta: {
  readonly metadataBase?: string | URL | null | undefined
}): string | undefined {
  const base = meta.metadataBase
  if (base === undefined || base === null) return undefined
  return base instanceof URL ? base.origin : new URL(base).origin
}

function document(fields: SeoDocument): SeoDocument {
  return { _id: 'doc-1', _type: 'page', ...fields }
}

/* ── title ────────────────────────────────────────────────────────────────── */

describe('title', () => {
  it('takes the owner’s seo.title', () => {
    const meta = metadataFrom(document({ title: 'Coded title', seo: { title: 'Owner’s title' } }), { env })
    expect(meta.title).toBe('Owner’s title')
  })

  it('falls back to the document’s own title field', () => {
    expect(metadataFrom(document({ title: 'Coded title' }), { env }).title).toBe('Coded title')
  })

  it('falls back to a named field for a type that titles differently', () => {
    const meta = metadataFrom(document({ heading: 'By another name' }), { env, titleField: 'heading' })
    expect(meta.title).toBe('By another name')
  })

  it('treats a whitespace-only seo.title as absent', () => {
    const meta = metadataFrom(document({ title: 'Real title', seo: { title: '   ' } }), { env })
    expect(meta.title).toBe('Real title')
  })

  /** An empty <title> is a title, and a worse one than the layout's. */
  it('omits the title entirely when there is nothing to say', () => {
    const meta = metadataFrom(document({}), { env })
    expect(meta.title).toBeUndefined()
    expect('title' in meta).toBe(false)
  })
})

/* ── description ──────────────────────────────────────────────────────────── */

describe('description', () => {
  it('lands in both description and openGraph.description', () => {
    const meta = metadataFrom(document({ seo: { description: 'What the page is about.' } }), { env })
    expect(meta.description).toBe('What the page is about.')
    expect(meta.openGraph?.description).toBe('What the page is about.')
  })

  it('is omitted when the owner left it empty', () => {
    const meta = metadataFrom(document({ title: 'A page' }), { env })
    expect(meta.description).toBeUndefined()
    expect(meta.openGraph?.description).toBeUndefined()
  })
})

/* ── the OG image, and its permanence ─────────────────────────────────────── */

describe('openGraph.images', () => {
  const withImage = document({
    title: 'A page',
    seo: { image: { assetId: ASSET, alt: 'A cabin at dusk' } },
  })

  function firstImage(meta: ReturnType<typeof metadataFrom>) {
    const images = meta.openGraph?.images
    expect(Array.isArray(images)).toBe(true)
    return (images as ReadonlyArray<Record<string, unknown>>)[0]
  }

  it('renders the card size social networks expect', () => {
    const image = firstImage(metadataFrom(withImage, { env }))
    expect(image?.['width']).toBe(1200)
    expect(image?.['height']).toBe(630)
    expect(String(image?.['url'])).toContain('w=1200')
    expect(String(image?.['url'])).toContain('h=630')
    expect(String(image?.['url'])).toContain('fit=crop')
  })

  it('requests JPEG, the format every scraper can draw', () => {
    expect(String(firstImage(metadataFrom(withImage, { env }))?.['url'])).toContain('fm=jpeg')
  })

  it('carries the asset’s alt text, which the owner wrote once', () => {
    expect(firstImage(metadataFrom(withImage, { env }))?.['alt']).toBe('A cabin at dusk')
  })

  it('is an absolute URL on the API origin, as the OG spec requires', () => {
    const url = String(firstImage(metadataFrom(withImage, { env }))?.['url'])
    expect(url.startsWith(`${API}/img/${ASSET}?`)).toBe(true)
  })

  /**
   * THE DECISION THIS MILESTONE HAD TO MAKE. A social network caches the card
   * for years; an expiring URL means every share saved today breaks later, and
   * cannot be repaired. The derivative route signs the asset id and the
   * transform and nothing else — no timestamp, no expiry — so this asserts the
   * absence of one directly rather than trusting the comment above it.
   */
  it('carries no expiry, so a cached card never breaks', () => {
    const url = new URL(String(firstImage(metadataFrom(withImage, { env }))?.['url']))
    const parameters = [...url.searchParams.keys()].sort()
    expect(parameters).toEqual(['fit', 'fm', 'h', 'q', 's', 'w'])

    for (const name of ['expires', 'exp', 'e', 'st', 'X-Amz-Expires', 'X-Amz-Date', 'token']) {
      expect(url.searchParams.get(name)).toBeNull()
    }
  })

  /** Same input, same URL, forever — the property "permanent" actually means. */
  it('is byte-identical across calls', () => {
    const once = String(firstImage(metadataFrom(withImage, { env }))?.['url'])
    const twice = String(firstImage(metadataFrom(withImage, { env }))?.['url'])
    expect(once).toBe(twice)
  })

  /**
   * And the signature really is the read key's digest over the transform, which
   * is what makes the URL reproducible without a stored token — and what makes
   * key rotation, not time, the only thing that invalidates it.
   */
  it('is signed with the read key’s digest over the transform alone', () => {
    const url = new URL(String(firstImage(metadataFrom(withImage, { env }))?.['url']))
    const canonical = 'w=1200&h=630&fit=crop&fm=jpeg&q=80'
    const key = createHash('sha256').update(READ_KEY, 'utf8').digest('hex')
    const expected = createHmac('sha256', key).update(`${ASSET}?${canonical}`, 'utf8').digest('hex').slice(0, 32)

    expect(url.searchParams.get('s')).toBe(expected)
  })

  it('emits no images key when the owner chose no image', () => {
    const meta = metadataFrom(document({ title: 'A page' }), { env })
    expect(meta.openGraph?.images).toBeUndefined()
  })
})

/* ── canonical ────────────────────────────────────────────────────────────── */

describe('alternates.canonical', () => {
  const origin = 'https://guesthouse.example'

  it('is the slug’s path against the configured origin', () => {
    const meta = metadataFrom(document({ slug: 'rooms' }), { env: { ...env, [ENV.siteOrigin]: origin } })
    expect(meta.alternates?.canonical).toBe('/rooms')
    expect(baseOrigin(meta)).toBe(origin)
  })

  /** The convention this package seeds: `getPage('home')` is the site root. */
  it('maps the home slug to the root', () => {
    const meta = metadataFrom(document({ slug: 'home' }), { env: { ...env, [ENV.siteOrigin]: origin } })
    expect(meta.alternates?.canonical).toBe('/')
  })

  it('accepts an explicit path for a site that routes differently', () => {
    const meta = metadataFrom(document({ slug: 'first-post' }), {
      env: { ...env, [ENV.siteOrigin]: origin },
      path: '/blog/first-post',
    })
    expect(meta.alternates?.canonical).toBe('/blog/first-post')
  })

  /**
   * The root-layout case. A settings singleton has a slug and does not have a
   * URL; deriving one would put the same wrong canonical on every page.
   */
  it('is suppressed for a document that does not own a URL', () => {
    const meta = metadataFrom(document({ slug: 'settings', title: 'The Guesthouse' }), {
      env: { ...env, [ENV.siteOrigin]: origin },
      path: false,
    })
    expect(meta.alternates).toBeUndefined()
    expect(meta.openGraph?.url).toBeUndefined()
    // The title still comes through — suppressing a URL is not suppressing SEO.
    expect(meta.title).toBe('The Guesthouse')
    expect(baseOrigin(meta)).toBe(origin)
  })

  it('adds a scheme to a bare host and strips a trailing slash', () => {
    const meta = metadataFrom(document({ slug: 'rooms' }), {
      env: { ...env, [ENV.siteOrigin]: 'guesthouse.example/' },
    })
    expect(baseOrigin(meta)).toBe('https://guesthouse.example')
  })

  it('falls back to the deployment’s production host', () => {
    const meta = metadataFrom(document({ slug: 'rooms' }), {
      env: { ...env, VERCEL_PROJECT_PRODUCTION_URL: 'guesthouse.example' },
    })
    expect(baseOrigin(meta)).toBe('https://guesthouse.example')
  })

  /**
   * A canonical naming the wrong origin de-indexes the right page. Silence is
   * the safe answer, so an unconfigured site gets no canonical at all.
   */
  it('is omitted when no origin is configured', () => {
    const meta = metadataFrom(document({ slug: 'rooms' }), { env })
    expect(meta.alternates).toBeUndefined()
    expect(baseOrigin(meta)).toBeUndefined()
  })

  it('is omitted when the configured origin is unparseable', () => {
    const meta = metadataFrom(document({ slug: 'rooms' }), {
      env: { ...env, [ENV.siteOrigin]: 'http://[not a host]' },
    })
    expect(meta.alternates).toBeUndefined()
  })

  it('is omitted when the document has no slug', () => {
    const meta = metadataFrom(document({ title: 'A page' }), { env: { ...env, [ENV.siteOrigin]: origin } })
    expect(meta.alternates).toBeUndefined()
    // The origin is still known, so relative OG URLs resolve.
    expect(baseOrigin(meta)).toBe(origin)
  })
})

/* ── openGraph shape ──────────────────────────────────────────────────────── */

describe('openGraph', () => {
  it('carries the site name, locale and type when asked', () => {
    const meta = metadataFrom(document({ title: 'A page' }), {
      env,
      siteName: 'The Guesthouse',
      locale: 'he_IL',
      type: 'article',
    })
    expect(meta.openGraph?.siteName).toBe('The Guesthouse')
    expect(meta.openGraph).toMatchObject({ locale: 'he_IL', type: 'article' })
  })

  it('defaults to a website', () => {
    expect(metadataFrom(document({ title: 'A page' }), { env }).openGraph).toMatchObject({ type: 'website' })
  })

  it('is omitted entirely when the document says nothing', () => {
    expect(metadataFrom(document({}), { env }).openGraph).toBeUndefined()
  })
})

/* ── the factory ──────────────────────────────────────────────────────────── */

describe('metadataFor', () => {
  it('reads the document the loader returns', async () => {
    const generateMetadata = metadataFor(() => document({ seo: { title: 'From the studio' } }), { env })
    expect((await generateMetadata({})).title).toBe('From the studio')
  })

  it('awaits an async loader', async () => {
    const generateMetadata = metadataFor(
      async () => Promise.resolve(document({ seo: { title: 'Fetched' } })),
      { env },
    )
    expect((await generateMetadata({})).title).toBe('Fetched')
  })

  it('passes Next’s props through to the loader', async () => {
    const generateMetadata = metadataFor(
      async ({ params }: { params: Promise<{ slug: string }> }) =>
        document({ slug: (await params).slug, title: 'Dynamic' }),
      { env, origin: 'https://guesthouse.example' },
    )

    const meta = await generateMetadata({ params: Promise.resolve({ slug: 'cabin-north' }) })
    expect(meta.alternates?.canonical).toBe('/cabin-north')
  })

  /**
   * A `generateMetadata` that throws takes down a page whose body may render
   * perfectly well. The page's own `notFound()` owns that decision.
   */
  it('yields the layout’s metadata for a missing document rather than throwing', async () => {
    const generateMetadata = metadataFor(() => null, { env })
    await expect(generateMetadata({})).resolves.toEqual({})
  })

  it('tolerates a malformed seo field instead of throwing', () => {
    expect(metadataFrom(document({ title: 'A page', seo: 'not an object' }), { env }).title).toBe('A page')
    expect(metadataFrom(document({ title: 'A page', seo: ['nope'] }), { env }).title).toBe('A page')
  })
})
