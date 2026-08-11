import { describe, expect, it } from 'vitest'

import { inferModel, imageFile, isPortableText, isSlug } from '../src/import/sanity'
import type { SanityDocument } from '../src/import/sanity'
import { toSlug } from '../src/import/write'

/**
 * M17 — inferring a content model from Sanity documents.
 *
 * Every case here is one this importer got WRONG against a real 40-document
 * export before it got it right. They are regressions, not hypotheticals.
 */

const doc = (type: string, fields: Record<string, unknown>): SanityDocument =>
  ({ _id: `${type}-1`, _type: type, ...fields }) as SanityDocument

describe('recognising Sanity shapes', () => {
  it('reads an export-rewritten image reference', () => {
    expect(imageFile({ _sanityAsset: 'image@file://./images/abc-100x50.jpg' })).toBe(
      'images/abc-100x50.jpg',
    )
  })

  it('reads a live asset reference', () => {
    expect(imageFile({ asset: { _ref: 'image-abc123-1600x900-jpg' } })).toBe(
      'images/abc123-1600x900.jpg',
    )
  })

  it('is not fooled by a plain object', () => {
    expect(imageFile({ alt: 'x' })).toBeNull()
  })

  it('recognises a slug and portable text', () => {
    expect(isSlug({ _type: 'slug', current: 'villa' })).toBe(true)
    expect(isPortableText([{ _type: 'block', children: [] }])).toBe(true)
    expect(isPortableText([{ _type: 'galleryImage' }])).toBe(false)
  })
})

describe('inference', () => {
  it('turns a Sanity slug into the document slug, not a field', () => {
    const model = inferModel([doc('page', { title: 'x', slug: { _type: 'slug', current: 'about' } })])
    const type = model.types[0]
    expect(type?.sourceSlugKey).toBe('slug')
    expect(type?.fields.find((f) => f.name === 'slug')?.kind).toBe('string')
  })

  it('treats an ANNOTATED image as an object with an image field', () => {
    // Sanity models `galleryImage` as `type: 'image'` with extra fields, so the
    // picture IS the value. Inferring `image` for it lost the picture entirely
    // and every gallery row was rejected for a missing `image`.
    const model = inferModel([
      doc('accommodation', {
        gallery: [
          {
            _type: 'galleryImage',
            _sanityAsset: 'image@file://./images/a-1x1.jpg',
            alt: 'x',
            category: 'rooms',
          },
        ],
      }),
    ])
    const shape = model.objects.find((object) => object.key === 'galleryImage')
    expect(shape?.fields.map((f) => f.name).sort()).toEqual(['alt', 'category', 'image'])
    expect(shape?.fields.find((f) => f.name === 'image')?.kind).toBe('image')
  })

  it('treats an image carrying only alt as a plain image field', () => {
    const model = inferModel([
      doc('page', { heroImage: { _type: 'image', _sanityAsset: 'image@file://./images/a-1x1.jpg', alt: 'x' } }),
    ])
    expect(model.types[0]?.fields.find((f) => f.name === 'heroImage')?.kind).toBe('image')
  })

  it('collects an object’s shape across EVERY type that uses it', () => {
    // `migrationMetadata` appears on nine types and only some carry
    // `qualityFlags`. Defining it from the first type processed left the key
    // undeclared and rejected every document that had it.
    const model = inferModel([
      doc('areaGuide', { migration: { _type: 'migrationMetadata', sourceId: '1' } }),
      doc('promotion', { migration: { _type: 'migrationMetadata', sourceId: '2', qualityFlags: [] } }),
    ])
    const shape = model.objects.find((object) => object.key === 'migrationMetadata')
    expect(shape?.fields.map((f) => f.name).sort()).toEqual(['qualityFlags', 'sourceId'])
  })

  it('treats an empty array as a list rather than as nothing', () => {
    const model = inferModel([doc('page', { tags: [] })])
    const field = model.types[0]?.fields.find((f) => f.name === 'tags')
    expect(field?.kind).toBe('stringList')
    expect(field?.repeated).toBe(true)
  })

  it('never names a shape after Sanity’s generic `object`', () => {
    // `_type: 'object'` is what Sanity writes for an inline anonymous shape.
    // Taking it as a name collected every unrelated inline shape into one.
    const model = inferModel([
      doc('homePage', { areaSection: { _type: 'object', title: 'a' } }),
      doc('homePage', { finalCta: { _type: 'object', buttonLabel: 'b' } }),
    ])
    expect(model.objects.map((object) => object.key)).not.toContain('object')
    expect(model.objects.length).toBeGreaterThan(1)
  })

  it('ignores every underscore-prefixed key', () => {
    // `_system` became a field called `_system`, which this API refuses: the
    // underscore prefix is reserved here too.
    const model = inferModel([doc('page', { _system: { a: 1 }, title: 'x' })])
    expect(model.types[0]?.fields.map((f) => f.name)).not.toContain('_system')
  })

  it('degrades a shape too deep for a flat object, and says so', () => {
    const model = inferModel([
      doc('pricePage', { groups: [{ _type: 'g', rows: [{ label: 'a', price: 1 }] }] }),
    ])
    expect(model.types[0]?.fields.find((f) => f.name === 'groups')?.kind).toBe('custom')
    expect(model.notes.some((note) => note.kind === 'flattened')).toBe(true)
  })

  it('picks the title field by candidate order, not key order', () => {
    // A testimonial has no title at all; "Reli Av" beats a slug as a row label.
    const withAuthor = inferModel([doc('testimonial', { author: 'Reli Av', text: 'x' })])
    expect(withAuthor.types[0]?.titleField).toBe('author')

    const both = inferModel([doc('post', { author: 'A', headline: 'H' })])
    expect(both.types[0]?.titleField).toBe('headline')
  })

  it('widens a field seen as two different string lengths', () => {
    const model = inferModel([
      doc('page', { body: 'short' }),
      doc('page', { body: 'x'.repeat(400) }),
    ])
    expect(model.types[0]?.fields.find((f) => f.name === 'body')?.kind).toBe('text')
  })
})

describe('slugs', () => {
  it('keeps a usable latin slug', () => {
    expect(toSlug('Cabin North', 'id')).toBe('cabin-north')
  })

  it('falls back to the source id for a Hebrew title', () => {
    // Every character is stripped, and inventing a transliteration would produce
    // a URL nobody chose.
    expect(toSlug('בקתת הצפון', 'wp-page-98')).toBe('wp-page-98')
  })

  it('never returns an empty slug', () => {
    expect(toSlug('', '')).toBe('item')
  })
})
