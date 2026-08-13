import { describe, expect, it } from 'vitest'

import { formatFieldSpec, parseFieldSpec } from '../src/field-spec'
import { isCliError } from '../src/exit'

/**
 * The compact `--field name:kind` syntax (M10).
 *
 * This is the surface an agent types to define a content shape, so the property
 * that matters most is not that valid input parses — it is that INVALID input
 * fails loudly with the offending token named. A modifier silently ignored here
 * becomes a field that is quietly optional, or quietly single-valued, in every
 * document the project ever stores.
 */

function rejection(spec: string): string {
  try {
    parseFieldSpec(spec)
  } catch (error: unknown) {
    if (isCliError(error)) return error.message
    throw error
  }
  throw new Error(`expected "${spec}" to be rejected`)
}

describe('parseFieldSpec', () => {
  it('reads the plain form', () => {
    expect(parseFieldSpec('caption:text')).toEqual({
      name: 'caption',
      kind: 'text',
      required: false,
    })
  })

  it('reads required', () => {
    expect(parseFieldSpec('question:string!')).toEqual({
      name: 'question',
      kind: 'string',
      required: true,
    })
  })

  it('reads repeated', () => {
    expect(parseFieldSpec('tags:stringList[]')).toEqual({
      name: 'tags',
      kind: 'stringList',
      required: false,
      repeated: true,
    })
  })

  it('reads repeated AND required together', () => {
    expect(parseFieldSpec('images:gallery[]!')).toEqual({
      name: 'images',
      kind: 'gallery',
      required: true,
      repeated: true,
    })
  })

  it('reads select options', () => {
    expect(parseFieldSpec('category:select=room|spa|outdoor')).toEqual({
      name: 'category',
      kind: 'select',
      required: false,
      options: ['room', 'spa', 'outdoor'],
    })
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseFieldSpec('  price:number!  ').name).toBe('price')
  })

  /*
   * M18 — an object may now contain an object, so this stopped being about the
   * flat rule and became about the SHAPE being named. A bare `object` is still
   * refused, and it has to be: a field of kind object with no `of` is a field
   * nothing can render, validate or generate a type for.
   */
  it('rejects a bare object, because it names no shape', () => {
    expect(rejection('gallery:object')).toContain('which shape it carries')
  })

  it('parses a nested object field, list and single', () => {
    expect(parseFieldSpec('rows:object<priceRow>[]')).toEqual({
      name: 'rows',
      kind: 'object',
      of: 'priceRow',
      required: false,
      repeated: true,
    })
    expect(parseFieldSpec('seo:object<seo>!')).toEqual({
      name: 'seo',
      kind: 'object',
      of: 'seo',
      required: true,
    })
  })

  it('round-trips through formatFieldSpec, so `objects list` output is reusable', () => {
    // What an agent reads back must be what it can pass straight in — that is
    // the whole reason the notation is shared between the two commands.
    const spec = 'rows:object<priceRow>[]'
    expect(formatFieldSpec(parseFieldSpec(spec))).toBe(spec)
  })

  it('rejects an unknown kind and lists the real ones', () => {
    let hint = ''
    try {
      parseFieldSpec('x:stringy')
    } catch (error: unknown) {
      if (!isCliError(error)) throw error
      hint = error.hint ?? ''
    }
    expect(hint).toContain('string')
    expect(hint).toContain('richtext')
  })

  it('rejects a select with no options', () => {
    expect(rejection('category:select')).toContain('no options')
  })

  it('rejects options on a kind that is not select', () => {
    expect(rejection('title:string=a|b')).toContain('Only a select field')
  })

  it('rejects a name that is not a usable identifier', () => {
    for (const spec of ['1st:string', 'my-field:string', ':string', 'a b:string']) {
      expect(rejection(spec)).toContain('Cannot read the field')
    }
  })

  it('rejects a spec with no kind at all', () => {
    expect(rejection('title')).toContain('Cannot read the field')
  })
})

describe('formatFieldSpec', () => {
  it('round-trips every form it can parse', () => {
    for (const spec of [
      'caption:text',
      'question:string!',
      'tags:stringList[]',
      'images:gallery[]!',
      'category:select=room|spa',
    ]) {
      expect(formatFieldSpec(parseFieldSpec(spec))).toBe(spec)
    }
  })

  it('shows which object an `object` field points at', () => {
    // Not parseable input — `object` fields are attached to content types, not
    // registered inside one — but `objects list --types` prints them.
    expect(
      formatFieldSpec({ name: 'gallery', kind: 'object', required: false, repeated: true, of: 'galleryImage' }),
    ).toBe('gallery:object<galleryImage>[]')
  })
})
