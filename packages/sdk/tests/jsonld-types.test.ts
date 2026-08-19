import { ENV, keyPrefix } from '@product'
import { describe, expect, it } from 'vitest'

import { articleJsonLd, breadcrumbJsonLd, imageObjectJsonLd, productJsonLd } from '../src/seo'

const ORIGIN = { [ENV.siteOrigin]: 'https://example.co.il' }
/*
 * Signing an image URL needs the project's read key, so an image test needs a
 * configured project. Without it `imageProps` throws, which is now caught and
 * turned into "no image" — a case worth exercising in its own right below.
 */
const CONFIGURED = {
  ...ORIGIN,
  [ENV.apiUrl]: 'https://api.example.test/v1',
  [ENV.projectId]: '00000000-0000-0000-0000-000000000000',
  // Built from `keyPrefix` rather than typed out: the guard forbids the name as
  // a literal, and a renamed product should break here loudly.
  [ENV.readKey]: `${keyPrefix('read')}${'0'.repeat(43)}`,
}
const IMAGE = { assetId: '11111111-2222-3333-4444-555555555555', alt: 'תיאור' }

describe('articleJsonLd', () => {
  /**
   * Google's wording is "there are no required properties". An earlier draft of
   * this project's research said headline, author, datePublished and image were
   * all required and it was wrong, so the gate here is a headline alone.
   */
  it('emits from a headline alone', () => {
    expect(articleJsonLd({ title: 'מהיומן' }, { author: 'מעיין הזית', env: ORIGIN }))
      .toMatchObject({ '@type': 'Article', headline: 'מהיומן' })
  })

  it('attributes to an Organization, because the model has no author field', () => {
    const value = articleJsonLd({ title: 'x' }, { author: 'מעיין הזית', env: ORIGIN })
    expect(value?.['author']).toEqual({ '@type': 'Organization', name: 'מעיין הזית' })
  })

  it('carries the dates it has and invents neither', () => {
    const withDate = articleJsonLd(
      { title: 'x', publishedAt: '2026-03-01', _updatedAt: '2026-08-01T00:00:00.000Z' },
      { author: 'a', env: ORIGIN },
    )
    expect(withDate).toMatchObject({ datePublished: '2026-03-01', dateModified: '2026-08-01T00:00:00.000Z' })

    const without = articleJsonLd({ title: 'x' }, { author: 'a', env: ORIGIN })
    expect(without).not.toHaveProperty('datePublished')
    expect(without).not.toHaveProperty('dateModified')
  })

  it('returns null with no headline at all', () => {
    expect(articleJsonLd({ body: 'text' }, { author: 'a', env: ORIGIN })).toBeNull()
  })
})

describe('breadcrumbJsonLd', () => {
  it('numbers the trail and links every step but the current page', () => {
    const value = breadcrumbJsonLd(
      [{ name: 'בית', path: '/' }, { name: 'המתחמים', path: '/accommodations' }, { name: 'בקתת מרווה' }],
      { env: ORIGIN },
    )
    const items = value?.['itemListElement'] as ReadonlyArray<Record<string, unknown>>

    expect(items.map((item) => item['position'])).toEqual([1, 2, 3])
    expect(items[1]?.['item']).toBe('https://example.co.il/accommodations')
    expect(items[2]).not.toHaveProperty('item')
  })

  /** One step is the page itself, and a one-item trail tells a crawler nothing. */
  it('returns null for a trail of fewer than two steps', () => {
    expect(breadcrumbJsonLd([{ name: 'בית', path: '/' }], { env: ORIGIN })).toBeNull()
    expect(breadcrumbJsonLd([], { env: ORIGIN })).toBeNull()
  })
})

describe('productJsonLd', () => {
  it('emits the offer with the currency it was given', () => {
    const value = productJsonLd(
      { title: 'טיפול', price: 380, slug: 'treatment' },
      { currency: 'ILS', env: ORIGIN },
    )

    expect(value).toMatchObject({ '@type': 'Product', name: 'טיפול' })
    expect(value?.['offers']).toMatchObject({ '@type': 'Offer', price: 380, priceCurrency: 'ILS' })
  })

  /**
   * The reason to emit a Product is the offer. One without a price occupies the
   * markup budget and answers nothing a crawler asked.
   */
  it('returns null without a price', () => {
    expect(productJsonLd({ title: 'טיפול' }, { currency: 'ILS', env: ORIGIN })).toBeNull()
  })

  /**
   * Availability is never assumed. A room may be booked and a treatment
   * withdrawn, and telling a comparison engine something is available when it
   * is not costs a real customer a real journey.
   */
  it('omits availability unless the document states it', () => {
    const silent = productJsonLd({ title: 'a', price: 1 }, { currency: 'ILS', env: ORIGIN })
    expect(silent?.['offers']).not.toHaveProperty('availability')

    const stated = productJsonLd(
      { title: 'a', price: 1, inStock: false },
      { currency: 'ILS', env: ORIGIN },
    )
    expect(stated?.['offers']).toMatchObject({ availability: 'https://schema.org/OutOfStock' })
  })
})

describe('imageObjectJsonLd', () => {
  it('keeps alt and caption apart, because they answer different questions', () => {
    const value = imageObjectJsonLd(
      { image: IMAGE, alt: 'בקתת עץ מול הוואדי', caption: 'בקתת מרווה' },
      { env: CONFIGURED },
    )

    expect(value).toMatchObject({
      '@type': 'ImageObject',
      name: 'בקתת עץ מול הוואדי',
      caption: 'בקתת מרווה',
    })
    expect(typeof value?.['contentUrl']).toBe('string')
  })

  it('returns null without an image, and claims no licence it does not have', () => {
    expect(imageObjectJsonLd({ alt: 'only alt' }, { env: ORIGIN })).toBeNull()
    expect(imageObjectJsonLd(null, { env: ORIGIN })).toBeNull()

    const value = imageObjectJsonLd({ image: IMAGE, alt: 'a' }, { env: CONFIGURED })
    expect(value).not.toHaveProperty('license')
    expect(value).not.toHaveProperty('creator')
  })
})

/**
 * The hardening that this test file found. Signing an image URL needs the
 * project's read key, so an incomplete environment made `imageProps` throw —
 * inside `generateMetadata`, which would have taken down a page whose body
 * renders perfectly well. It now yields no image instead.
 */
describe('an incomplete environment costs an image, not the page', () => {
  it('returns the object without an image rather than throwing', () => {
    expect(() =>
      imageObjectJsonLd({ image: IMAGE, alt: 'a' }, { env: ORIGIN }),
    ).not.toThrow()
    expect(imageObjectJsonLd({ image: IMAGE, alt: 'a' }, { env: ORIGIN })).toBeNull()

    const article = articleJsonLd({ title: 'x', cover: IMAGE }, { author: 'a', env: ORIGIN })
    expect(article).toMatchObject({ headline: 'x' })
    expect(article).not.toHaveProperty('image')
  })
})
