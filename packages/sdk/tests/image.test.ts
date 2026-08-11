import { createHash, createHmac } from 'node:crypto'

import { ENV, keyPrefix } from '@product'
import { describe, expect, it } from 'vitest'

import { imageProps, imageUrl } from '../src/image'

/**
 * M12 (PRD-v2 §4.3) — the URL builder and the props it produces.
 *
 * The property that matters most is compatibility with the SERVER: a signature
 * this package computes differently from `apps/api/lib/images.ts` is a 404 on
 * every image on the customer's site. The signature is therefore recomputed here
 * from first principles rather than by calling the same helper — a test that
 * imports the implementation it is testing proves only that the code is
 * self-consistent.
 */

const PROJECT = '11111111-2222-4333-8444-555555555555'
// Built from the derived prefix rather than typed out: the slug guard forbids
// the product name as a literal anywhere outside `product.config.ts`, and a test
// fixture is no exception.
const READ_KEY = `${keyPrefix('read')}abcdef`
const ASSET = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

const ENVIRONMENT: Readonly<Record<string, string>> = {
  [ENV.apiUrl]: 'https://api.test/v1',
  [ENV.projectId]: PROJECT,
  [ENV.readKey]: READ_KEY,
}

/** The server's algorithm, restated. */
function expectedSignature(assetId: string, canonical: string): string {
  const key = createHash('sha256').update(READ_KEY, 'utf8').digest('hex')
  return createHmac('sha256', key).update(`${assetId}?${canonical}`, 'utf8').digest('hex').slice(0, 32)
}

const REF = {
  assetId: ASSET,
  url: `https://api.test/v1/assets/${ASSET}/file`,
  alt: 'בקתת הצפון בשקיעה',
  width: 4000,
  height: 3000,
  lqip: 'data:image/webp;base64,AAAA',
}

describe('imageUrl', () => {
  it('signs exactly what the server will verify', () => {
    const url = new URL(imageUrl({ assetId: ASSET, width: 800, env: ENVIRONMENT }))
    expect(url.pathname).toBe(`/v1/img/${ASSET}`)
    expect(url.searchParams.get('s')).toBe(expectedSignature(ASSET, 'w=800&fit=max&q=80'))
  })

  it('emits parameters in the canonical order, defaults included', () => {
    // The server hashes the canonical string; a different order is a different
    // signature and a different cache entry.
    const url = imageUrl({ assetId: ASSET, width: 800, height: 600, fit: 'crop', env: ENVIRONMENT })
    expect(url).toContain('?w=800&h=600&fit=crop&q=80&s=')
  })

  it('carries an explicit format and quality', () => {
    const url = imageUrl({
      assetId: ASSET,
      width: 1200,
      height: 630,
      fit: 'crop',
      format: 'jpeg',
      quality: 90,
      env: ENVIRONMENT,
    })
    expect(url).toContain('w=1200&h=630&fit=crop&fm=jpeg&q=90')
    expect(new URL(url).searchParams.get('s')).toBe(
      expectedSignature(ASSET, 'w=1200&h=630&fit=crop&fm=jpeg&q=90'),
    )
  })

  it('clamps a width past the server ceiling instead of producing a 422', () => {
    expect(imageUrl({ assetId: ASSET, width: 99_999, env: ENVIRONMENT })).toContain('w=4000')
  })

  it('rounds a fractional width — a viewport calculation rarely gives an integer', () => {
    expect(imageUrl({ assetId: ASSET, width: 800.6, env: ENVIRONMENT })).toContain('w=801')
  })

  it('drops a nonsensical dimension rather than signing it', () => {
    for (const width of [0, -10, Number.NaN]) {
      expect(imageUrl({ assetId: ASSET, width, env: ENVIRONMENT }), String(width)).toContain(
        'fit=max',
      )
      expect(imageUrl({ assetId: ASSET, width, env: ENVIRONMENT })).not.toContain('w=')
    }
  })
})

describe('imageProps', () => {
  it('returns null for an absent image, so a caller guards once', () => {
    expect(imageProps(null, { env: ENVIRONMENT })).toBeNull()
    expect(imageProps(undefined, { env: ENVIRONMENT })).toBeNull()
    expect(imageProps({}, { env: ENVIRONMENT })).toBeNull()
  })

  it('takes the alt text from the ASSET, which is where the owner wrote it', () => {
    // The reason alt lives on the asset: written once in the media library,
    // inherited by every page. An API that made `alt` a required prop would
    // have the developer invent one per usage, which is how alt text becomes
    // "image".
    expect(imageProps(REF, { width: 800, env: ENVIRONMENT })?.alt).toBe('בקתת הצפון בשקיעה')
  })

  it('lets a caller override the alt where the context differs', () => {
    expect(imageProps(REF, { width: 800, alt: 'לוגו', env: ENVIRONMENT })?.alt).toBe('לוגו')
  })

  it('feeds the LQIP straight into blurDataURL', () => {
    const props = imageProps(REF, { width: 800, env: ENVIRONMENT })
    expect(props?.placeholder).toBe('blur')
    expect(props?.blurDataURL).toBe('data:image/webp;base64,AAAA')
  })

  it('omits the placeholder entirely when there is no LQIP', () => {
    // An older asset has none. `placeholder: 'blur'` with no `blurDataURL` is a
    // runtime error in next/image, so both must be absent together.
    const props = imageProps({ assetId: ASSET }, { width: 800, env: ENVIRONMENT })
    expect(props?.placeholder).toBeUndefined()
    expect(props?.blurDataURL).toBeUndefined()
  })

  it('builds a srcset that keeps the requested aspect ratio at every width', () => {
    // A `fit=crop` at 16:10 must stay 16:10 across the set, or the browser swaps
    // in a differently-shaped image on resize and the page reflows.
    const props = imageProps(REF, { width: 1600, height: 1000, fit: 'crop', env: ENVIRONMENT })
    const entries = (props?.srcSet ?? '').split(', ')

    for (const entry of entries) {
      const url = new URL(entry.split(' ')[0] ?? '')
      const w = Number(url.searchParams.get('w'))
      const h = Number(url.searchParams.get('h'))
      expect(h / w).toBeCloseTo(1000 / 1600, 2)
    }
  })

  it('never offers a width more than 2x the one asked for', () => {
    // The server budgets twelve renditions per asset. One `<img>` offering
    // every width in the ladder would spend most of it on sizes nobody sees.
    const props = imageProps(REF, { width: 640, env: ENVIRONMENT })
    const widths = (props?.srcSet ?? '')
      .split(', ')
      .map((entry) => Number(entry.split(' ')[1]?.replace('w', '')))
    expect(Math.max(...widths)).toBeLessThanOrEqual(1280)
    expect(widths.length).toBeLessThanOrEqual(6)
  })

  it('always offers at least one candidate, even for a tiny request', () => {
    const props = imageProps(REF, { width: 24, env: ENVIRONMENT })
    expect((props?.srcSet ?? '').length).toBeGreaterThan(0)
  })

  it('lazy-loads by default and eagerly with priority', () => {
    expect(imageProps(REF, { width: 800, env: ENVIRONMENT })?.loading).toBe('lazy')

    const hero = imageProps(REF, { width: 1600, priority: true, env: ENVIRONMENT })
    expect(hero?.loading).toBe('eager')
    // The single biggest lever on LCP, and the one thing that cannot be inferred
    // from the image itself.
    expect(hero?.fetchPriority).toBe('high')
  })

  it('defaults sizes to full width and accepts an override', () => {
    expect(imageProps(REF, { width: 800, env: ENVIRONMENT })?.sizes).toBe('100vw')
    expect(
      imageProps(REF, { width: 800, sizes: '(max-width: 700px) 100vw, 33vw', env: ENVIRONMENT })
        ?.sizes,
    ).toBe('(max-width: 700px) 100vw, 33vw')
  })

  it('recovers the asset id from a URL-only reference', () => {
    // A field written before assets carried an id, or by hand.
    const props = imageProps(
      { url: `https://api.test/v1/assets/${ASSET}/file` },
      { width: 400, env: ENVIRONMENT },
    )
    expect(props?.src).toContain(`/img/${ASSET}`)
  })

  it('accepts a bare asset id string', () => {
    expect(imageProps(ASSET, { width: 400, env: ENVIRONMENT })?.src).toContain(`/img/${ASSET}`)
  })

  it('signs every entry in the srcset, not only the src', () => {
    const props = imageProps(REF, { width: 1280, env: ENVIRONMENT })
    for (const entry of (props?.srcSet ?? '').split(', ')) {
      const url = new URL(entry.split(' ')[0] ?? '')
      const w = url.searchParams.get('w') ?? ''
      expect(url.searchParams.get('s')).toBe(expectedSignature(ASSET, `w=${w}&fit=max&q=80`))
    }
  })
})
