import { describe, expect, it } from 'vitest'

import { isCliError } from '../src/exit'
import { applySet, applySets, opsFromDataObject, parseSetFlag, parseSetValue } from '../src/patch'

/**
 * `edit`'s patch semantics — see `patch.ts` for why this is neither a raw
 * replace nor a deep merge. Every test here checks the one property that
 * actually matters: a field named by a path changes, and every sibling field —
 * at every level — comes out identical to how it went in.
 */

describe('parseSetValue', () => {
  it('parses JSON-shaped values', () => {
    expect(parseSetValue('42')).toBe(42)
    expect(parseSetValue('true')).toBe(true)
    expect(parseSetValue('null')).toBe(null)
    expect(parseSetValue('{"a":1}')).toEqual({ a: 1 })
    expect(parseSetValue('[1,2]')).toEqual([1, 2])
  })

  it('keeps a non-JSON string as-is', () => {
    expect(parseSetValue('Hello')).toBe('Hello')
    expect(parseSetValue('שלום עולם')).toBe('שלום עולם')
  })
})

describe('parseSetFlag', () => {
  it('splits on the first "=" and parses a dot-path', () => {
    expect(parseSetFlag('price=42')).toEqual({ path: ['price'], value: 42 })
    expect(parseSetFlag('seo.title=Hello')).toEqual({ path: ['seo', 'title'], value: 'Hello' })
  })

  it('keeps everything after the first "=" as the value', () => {
    expect(parseSetFlag('url=https://example.co.il?a=1')).toEqual({
      path: ['url'],
      value: 'https://example.co.il?a=1',
    })
  })

  it('rejects a flag with no "="', () => {
    expect(() => parseSetFlag('price')).toThrowError()
  })
})

describe('applySet', () => {
  it('sets a top-level field without touching siblings', () => {
    const base = { title: 'Old', price: 10, custom: { hours: '9-5' } }
    const result = applySet(base, ['price'], 42)
    expect(result).toEqual({ title: 'Old', price: 42, custom: { hours: '9-5' } })
    // The untouched nested object is not cloned.
    expect(result['custom']).toBe(base.custom)
  })

  it('creates intermediate objects that do not exist yet', () => {
    const result = applySet({ title: 'Old' }, ['seo', 'title'], 'New title')
    expect(result).toEqual({ title: 'Old', seo: { title: 'New title' } })
  })

  it('sets a nested field without touching its siblings', () => {
    const base = { seo: { title: 'Old', description: 'Kept' } }
    const result = applySet(base, ['seo', 'title'], 'New')
    expect(result).toEqual({ seo: { title: 'New', description: 'Kept' } })
  })

  it('never mutates the input', () => {
    const base = { seo: { title: 'Old' } }
    const frozenBase = JSON.parse(JSON.stringify(base))
    applySet(base, ['seo', 'title'], 'New')
    expect(base).toEqual(frozenBase)
  })

  it('refuses to set through a path segment that already holds a non-object', () => {
    const base = { price: 42 }
    let threw: unknown
    try {
      applySet(base, ['price', 'currency'], 'ILS')
    } catch (error) {
      threw = error
    }
    expect(isCliError(threw)).toBe(true)
    // Nothing was silently overwritten.
    expect(base).toEqual({ price: 42 })
  })

  it('does not choke on a path segment that already holds an array', () => {
    const base = { tags: ['a', 'b'] }
    expect(() => applySet(base, ['tags', 'first'], 'x')).toThrowError()
  })
})

describe('applySets', () => {
  it('folds multiple ops, each preserving what the others did not touch', () => {
    const base: Record<string, unknown> = {
      title: 'Old',
      price: 10,
      custom: { hours: '9-5', phone: '050-0000000' },
    }
    const result = applySets(base, [
      { path: ['price'], value: 42 },
      { path: ['custom', 'hours'], value: '10-6' },
    ])
    expect(result).toEqual({
      title: 'Old',
      price: 42,
      custom: { hours: '10-6', phone: '050-0000000' },
    })
  })

  it('leaves a document with sections/custom/seo entirely untouched when only one field is set', () => {
    // This is the exact shape of bug PROGRESS.md records against the studio's
    // own editor once: a write that only knew about "title" silently dropping
    // custom/seo/sections. `edit` must not repeat it.
    const base = {
      title: 'עמוד הבית',
      seo: { title: 'X', description: 'Y' },
      custom: { hours: '9-17', phone: '03-1234567' },
      sections: [{ _type: 'hero', heading: 'Hi' }],
    }
    const result = applySets(base, [{ path: ['title'], value: 'כותרת חדשה' }])
    expect(result).toEqual({ ...base, title: 'כותרת חדשה' })
  })
})

describe('opsFromDataObject', () => {
  it('treats each top-level key of --data as a dot-path', () => {
    const ops = opsFromDataObject({ price: 42, 'seo.title': 'Hello' })
    expect(ops).toEqual([
      { path: ['price'], value: 42 },
      { path: ['seo', 'title'], value: 'Hello' },
    ])
  })
})
