import { ENV } from '@product'
import { describe, expect, it } from 'vitest'

import { llmsTxtFrom } from '../src/seo'

/**
 * M21.9 — `llms.txt`.
 *
 * Shipped with its worth stated rather than assumed: Google says it is not
 * needed for AI Overviews or AI Mode, OpenAI's crawler docs do not mention it,
 * and 97% of published ones receive zero AI requests. What these tests hold to
 * is the only claim the file can honestly make — that it carries a NAME and a
 * SENTENCE per page, from the same fields `metadataFrom` reads, where
 * `sitemap.xml` carries a URL.
 */

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

const failingClient = {
  getAll: async () => {
    throw new Error('unreachable')
  },
}

describe('llmsTxtFrom', () => {
  it('carries the owner’s title and description per page, which is the point', async () => {
    const client = clientReturning(
      payload({
        documentsByType: {
          accommodation: [
            {
              slug: 'bikta-marva',
              title: 'בקתת מרווה',
              seo: { title: 'בקתת מרווה · ג׳קוזי מול הוואדי', description: 'בקתת עץ לזוגות.' },
            },
          ],
        },
      }),
    )

    const text = await llmsTxtFrom({
      title: 'מעיין הזית',
      summary: 'אירוח כפרי בגליל העליון.',
      env: ORIGIN,
      client,
      headings: { accommodation: 'המתחמים' },
      routes: { accommodation: (doc) => `/accommodations/${(doc as { slug: string }).slug}` },
    })()

    expect(text).toBe(
      [
        '# מעיין הזית',
        '',
        '> אירוח כפרי בגליל העליון.',
        '',
        '## המתחמים',
        '',
        '- [בקתת מרווה · ג׳קוזי מול הוואדי](https://example.co.il/accommodations/bikta-marva): בקתת עץ לזוגות.',
        '',
      ].join('\n'),
    )
  })

  it('falls back to the title field, the same way metadataFrom does', async () => {
    // Two sources for one name is how a page's <title> and its entry here come
    // to disagree. There is one resolution and this asserts they share it.
    const client = clientReturning(
      payload({ documents: { page: [{ slug: 'about', title: 'עלינו' }], post: [], product: [], collection: [] } }),
    )

    const text = await llmsTxtFrom({ title: 'האתר', env: ORIGIN, client })()
    expect(text).toContain('- [עלינו](https://example.co.il/about)')
    // No description in the document, so no colon-clause invented for it.
    expect(text).not.toContain('עלינו](https://example.co.il/about):')
  })

  it('skips a document with no name at all rather than linking a blank', async () => {
    const client = clientReturning(
      payload({ documents: { page: [{ slug: 'ghost' }], post: [], product: [], collection: [] } }),
    )

    const text = await llmsTxtFrom({ title: 'האתר', env: ORIGIN, client })()
    expect(text).not.toContain('/ghost')
    expect(text).toBe('# האתר\n')
  })

  it('omits a type with no declared route rather than guessing one', async () => {
    // The same rule as the sitemap, and the same reason: a slug is not a route.
    const client = clientReturning(
      payload({ documentsByType: { accommodation: [{ slug: 'bikta-marva', title: 'בקתת מרווה' }] } }),
    )

    expect(await llmsTxtFrom({ title: 'האתר', env: ORIGIN, client })()).toBe('# האתר\n')
  })

  it('takes the extras heading in the site’s own language', async () => {
    // A file whose sections read Hebrew, Hebrew, then "Other pages" is the
    // jargon this product does not do. The default is English and wrong for
    // most sites here, which is why the option exists.
    const text = await llmsTxtFrom({
      title: 'x',
      env: ORIGIN,
      client: clientReturning(payload()),
      extraHeading: 'עמודים נוספים',
      extra: [{ path: '/area', title: 'הסביבה' }],
    })()

    expect(text).toContain('## עמודים נוספים')
    expect(text).not.toContain('Other pages')
  })

  it('lists app-owned pages last, under their own heading', async () => {
    const client = clientReturning(payload())

    const text = await llmsTxtFrom({
      title: 'האתר',
      env: ORIGIN,
      client,
      extra: [{ path: '/area', title: 'הסביבה', description: 'מה יש מסביב.' }, '/contact'],
    })()

    expect(text).toContain('## Other pages')
    expect(text).toContain('- [הסביבה](https://example.co.il/area): מה יש מסביב.')
    // A bare string yields a link whose text is the path — as informative as
    // the sitemap line for the same page, which is why a title is worth giving.
    expect(text).toContain('- [/contact](https://example.co.il/contact)')
  })

  it('emits the header alone when the API is unreachable', async () => {
    // A file that 500s is worse than a thin one, exactly as with the sitemap.
    const text = await llmsTxtFrom({
      title: 'האתר',
      summary: 'שורה אחת.',
      env: ORIGIN,
      client: failingClient,
      extra: [{ path: '/area', title: 'הסביבה' }],
    })()

    expect(text).toBe('# האתר\n\n> שורה אחת.\n\n## Other pages\n\n- [הסביבה](https://example.co.il/area)\n')
  })

  it('emits nothing but the header without an origin', async () => {
    // Every URL here is absolute. A relative link in a file fetched from an
    // unknown base resolves to nothing at all.
    const client = clientReturning(
      payload({ documents: { page: [{ slug: 'about', title: 'עלינו' }], post: [], product: [], collection: [] } }),
    )

    expect(await llmsTxtFrom({ title: 'האתר', env: {}, client })()).toBe('# האתר\n')
  })

  it('never lists one URL twice, and neutralises brackets in a name', async () => {
    const client = clientReturning(
      payload({
        documents: {
          page: [
            { slug: 'home', title: 'בית' },
            { slug: 'home', title: 'בית שוב' },
          ],
          post: [], product: [], collection: [],
        },
      }),
    )

    const text = await llmsTxtFrom({
      title: 'האתר',
      env: ORIGIN,
      client,
      // `]` would close the link text early and leave the URL as visible prose.
      extra: [{ path: '/x', title: 'שם [עם] סוגריים', description: 'שורה\nראשונה' }],
    })()

    expect(text.match(/https:\/\/example\.co\.il\/\)/gu)).toHaveLength(1)
    expect(text).toContain('- [שם עם סוגריים](https://example.co.il/x): שורה ראשונה')
  })
})
