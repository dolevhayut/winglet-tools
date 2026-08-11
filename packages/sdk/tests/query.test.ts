import { describe, expect, it } from 'vitest'

import { queryParams } from '../src/query'

/**
 * M13 (PRD-v2 §5) — the SDK's half of the query contract.
 *
 * These assert the exact parameter NAMES, not just that something was produced.
 * This module and the API's parser are two implementations of one grammar living
 * in two repositories, and a disagreement between them is invisible to both
 * typecheckers: the customer's site simply gets a 422, or — much worse — sends a
 * filter the server does not recognise, gets a 200, and renders unfiltered
 * content that looks entirely plausible.
 */

describe('filter', () => {
  it('writes the bracket form the API parses', () => {
    expect(queryParams({ filter: { visibility: { ne: 'hidden' } } })).toEqual({
      'filter[visibility][ne]': 'hidden',
    })
  })

  it('takes a bare value as the eq shorthand', () => {
    expect(queryParams({ filter: { status: 'active' } })).toEqual({
      'filter[status]': 'active',
    })
  })

  it('emits one parameter per operator on the same field', () => {
    // A date window is two conditions on one field, which is the shape §5's own
    // example uses for finding the currently-running promotion.
    expect(queryParams({ filter: { publishedAt: { gte: '2026-01-01', lte: 'now' } } })).toEqual({
      'filter[publishedAt][gte]': '2026-01-01',
      'filter[publishedAt][lte]': 'now',
    })
  })

  it('joins an `in` list with commas', () => {
    expect(queryParams({ filter: { kind: { in: ['cabin', 'suite'] } } })).toEqual({
      'filter[kind][in]': 'cabin,suite',
    })
  })

  it('passes `now` through untouched', () => {
    // The whole caching argument of §5.2 rests on this string surviving as a
    // string. Resolving it here would make every request a different URL.
    expect(queryParams({ filter: { endDate: { gte: 'now' } } })).toEqual({
      'filter[endDate][gte]': 'now',
    })
  })

  it('serialises a Date as ISO rather than as a human-readable string', () => {
    const params = queryParams({ filter: { opensAt: { lte: new Date('2026-08-12T00:00:00Z') } } })
    expect(params['filter[opensAt][lte]']).toBe('2026-08-12T00:00:00.000Z')
  })

  it('keeps numbers and booleans as their literal text', () => {
    expect(queryParams({ filter: { sleeps: { gte: 4 }, featured: true } })).toEqual({
      'filter[sleeps][gte]': '4',
      'filter[featured]': 'true',
    })
  })

  it('addresses the envelope through the reserved prefix', () => {
    expect(queryParams({ filter: { _locale: 'he' } })).toEqual({ 'filter[_locale]': 'he' })
  })
})

describe('sort, fields and expand', () => {
  it('accepts one sort key or several', () => {
    expect(queryParams({ sort: 'order:asc' })['sort']).toBe('order:asc')
    expect(queryParams({ sort: ['order:asc', 'title:desc'] })['sort']).toBe('order:asc,title:desc')
  })

  it('joins fields and expand with commas', () => {
    expect(queryParams({ fields: ['title', 'slug'] })['fields']).toBe('title,slug')
    expect(queryParams({ expand: ['heroImage'] })['expand']).toBe('heroImage')
  })

  it('ADDS an expanded field to the projection instead of letting it 422', () => {
    /*
     * The API refuses a projection that drops a field it was asked to expand,
     * and it is right to — the two contradict each other. But the caller meant
     * "title plus the resolved featured", so fixing it here turns an error the
     * customer has to debug into what they asked for.
     */
    const params = queryParams({ fields: ['title'], expand: ['featured'] })
    expect(params['fields']?.split(',').sort()).toEqual(['featured', 'title'])
    expect(params['expand']).toBe('featured')
  })

  it('does not add a duplicate when the field is already projected', () => {
    const params = queryParams({ fields: ['title', 'featured'], expand: ['featured'] })
    expect(params['fields']?.split(',').sort()).toEqual(['featured', 'title'])
  })
})

describe('nothing asked for produces nothing', () => {
  it('emits no keys at all for empty options', () => {
    // A request using none of M13 must produce the URL it produced before M13,
    // or every existing cache entry is invalidated for no reason.
    expect(queryParams({})).toEqual({})
  })

  it('emits no key for empty arrays', () => {
    // `?fields=` reaches the server as present-but-blank, and "return no fields"
    // is not what `[]` meant.
    expect(queryParams({ fields: [], expand: [], sort: [] })).toEqual({})
  })
})
