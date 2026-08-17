import { ENV } from '@product'
import { describe, expect, it } from 'vitest'

import { businessJsonLd, jsonLdHtml } from '../src/seo'

/**
 * M21.3. The research this implements is in `research/geo-2026.md` in the
 * private repo, and the short version is that most of what a 2026 guide tells
 * you to emit is either gone or ineligible: `FAQPage` was removed from Google
 * Search in June 2026, and `Review`/`AggregateRating` cannot be self-serving.
 * `LocalBusiness` is what is left, it needs two properties, and this model
 * already holds both.
 */

const SETTINGS = {
  title: 'מעיין הזית',
  address: 'משק פרטי בגליל העליון',
  phone: '04-000-0000',
  seo: { description: 'חמישה מתחמי אירוח פרטיים' },
}

// Keyed from the config rather than typed out: the guard forbids the name as a
// literal, and a renamed prefix should break here loudly rather than silently
// stop configuring the origin.
const ORIGIN = { [ENV.siteOrigin]: 'https://example.co.il' }

describe('businessJsonLd', () => {
  it('emits the two required properties, and address as a PostalAddress', () => {
    const value = businessJsonLd(SETTINGS, { env: ORIGIN })

    expect(value).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'LocalBusiness',
      name: 'מעיין הזית',
      address: { '@type': 'PostalAddress', streetAddress: 'משק פרטי בגליל העליון' },
    })
  })

  it('takes a subtype, because every subtype inherits these properties', () => {
    expect(businessJsonLd(SETTINGS, { type: 'LodgingBusiness', env: ORIGIN })).toMatchObject({
      '@type': 'LodgingBusiness',
    })
  })

  /**
   * The whole point of the null. An item missing a required property is not
   * eligible for anything, so emitting it publishes an incomplete entity claim
   * and buys nothing. The caller renders no script at all.
   */
  it.each([
    ['no name', { address: 'somewhere' }],
    ['no address', { title: 'a business' }],
    ['neither', { phone: '04-000-0000' }],
  ])('returns null with %s', (_label, document) => {
    expect(businessJsonLd(document, { env: ORIGIN })).toBeNull()
  })

  it('returns null for a missing document rather than throwing', () => {
    expect(businessJsonLd(undefined, { env: ORIGIN })).toBeNull()
    expect(businessJsonLd(null, { env: ORIGIN })).toBeNull()
  })

  it('omits what it cannot fill instead of emitting an empty value', () => {
    const value = businessJsonLd({ title: 'a', address: 'b' }, { env: {} })

    expect(value).not.toHaveProperty('telephone')
    expect(value).not.toHaveProperty('description')
    expect(value).not.toHaveProperty('url')
    expect(value).not.toHaveProperty('image')
  })

  /**
   * Recorded as a test rather than only as a comment, because the omission is
   * deliberate and the next person to read the template will see hours sitting
   * right there and assume it was forgotten. It was not: the values are
   * free text an owner typed in their own language, and a wrong opening hour
   * published as machine-readable fact turns a customer away.
   */
  it('never guesses opening hours out of free text', () => {
    const value = businessJsonLd(
      { ...SETTINGS, hours: [{ day: 'א׳-ה׳', hours: '09:00-17:00' }] },
      { env: ORIGIN },
    )

    expect(value).not.toHaveProperty('openingHoursSpecification')
    expect(value).not.toHaveProperty('openingHours')
  })

  it('reads renamed fields when told, rather than guessing at them', () => {
    const value = businessJsonLd(
      { businessName: 'שם אחר', where: 'כתובת אחרת' },
      { env: ORIGIN, fields: { name: 'businessName', address: 'where' } },
    )

    expect(value).toMatchObject({ name: 'שם אחר' })
  })
})

describe('jsonLdHtml', () => {
  /**
   * The plainest XSS available in this product: `</script>` typed into a field
   * an owner is invited to write prose in would close the tag, and everything
   * after it becomes markup.
   */
  it('escapes a script tag hidden in owner-authored content', () => {
    const html = jsonLdHtml(
      businessJsonLd(
        { title: 'a', address: '</script><img src=x onerror=alert(1)>' },
        { env: ORIGIN },
      ),
    )

    expect(html).not.toContain('</script>')
    expect(html).toContain('\\u003c')
    // Still valid JSON, and still the same string on the other side.
    expect(JSON.parse(html ?? '')).toMatchObject({
      address: { streetAddress: '</script><img src=x onerror=alert(1)>' },
    })
  })

  it('passes null through, so a caller renders nothing', () => {
    expect(jsonLdHtml(null)).toBeNull()
  })
})
