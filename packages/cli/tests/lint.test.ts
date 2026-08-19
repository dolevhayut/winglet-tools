import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ENV } from '@product'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ModelContentTypeDefinition,
  ModelFieldDefinition,
  ProjectModel,
} from '../src/api'
import { EXIT } from '../src/exit'
import { captureIo } from '../src/io'
import { CHECK_NAMES, findCheck, runLint } from '../src/lint'
import type { Finding, LintDocument } from '../src/lint'
import { run } from '../src/program'

/**
 * M16 — the tuning of the consistency checks, exercised against hand-built
 * documents with no network anywhere.
 *
 * EVERY CHECK IS TESTED TWICE, AND THE SECOND TEST IS THE IMPORTANT ONE.
 * Once for the problem it is supposed to find, and once for a lookalike it must
 * stay silent about. That pairing is the whole design of this milestone: a
 * finding has to be almost certainly real, so the silence is the feature and the
 * cases below are the specification of where the line was drawn. Several of them
 * assert a MISS on purpose — a real contradiction the check will not report —
 * and each says so, because a deliberate false negative that nobody wrote down
 * is indistinguishable from a bug.
 */

/* ── fixtures ─────────────────────────────────────────────────────────────── */

function field(
  name: string,
  kind: string,
  extra?: Partial<ModelFieldDefinition>,
): ModelFieldDefinition {
  return { name, kind, required: false, ...extra }
}

function contentType(
  key: string,
  fields: readonly ModelFieldDefinition[] = [],
  extra?: Partial<ModelContentTypeDefinition>,
): ModelContentTypeDefinition {
  return { key, title: key, fields, titleField: 'title', slugField: 'slug', ...extra }
}

function model(...types: readonly ModelContentTypeDefinition[]): ProjectModel {
  return { types, objects: [] }
}

let nextId = 0

function doc(
  type: string,
  slug: string,
  data: Readonly<Record<string, unknown>>,
): LintDocument {
  nextId += 1
  const title = data['title']
  return {
    id: `doc-${String(nextId)}`,
    type,
    slug,
    title: typeof title === 'string' ? title : undefined,
    data,
  }
}

/** Rich text: an array of blocks, which the walker reads as prose, not a list. */
function richText(...paragraphs: readonly string[]): unknown[] {
  return paragraphs.map((text) => ({
    _type: 'block',
    children: [{ _type: 'span', text }],
  }))
}

function reference(id: string): unknown {
  return { _type: 'reference', _ref: id }
}

function lint(
  documents: readonly LintDocument[],
  projectModel: ProjectModel,
  check: string,
): readonly Finding[] {
  const definition = findCheck(check)
  expect(definition, `no such check: ${check}`).toBeDefined()
  return runLint({
    documents,
    model: projectModel,
    ...(definition === undefined ? {} : { checks: [definition] }),
  }).findings
}

/* ── contradictory numbers ────────────────────────────────────────────────── */

/* ── entity names ─────────────────────────────────────────────────────────── */

/* ── broken links ─────────────────────────────────────────────────────────── */

describe('broken-links', () => {
  const site = model(contentType('page'), contentType('cabin'))

  it('finds a reference to a document that is not being served', () => {
    const cabin = doc('cabin', 'alpha', { title: 'בקתה אלפא' })
    const findings = lint(
      [cabin, doc('page', 'home', { featured: [reference(cabin.id), reference('doc-missing')] })],
      site,
      'broken-links',
    )

    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('doc-missing')
    expect(findings[0]?.locations[0]?.path).toBe('featured[1]')
  })

  it('finds a path whose siblings prove the prefix routes slugs', () => {
    const findings = lint(
      [
        doc('cabin', 'alpha', { title: 'בקתה אלפא' }),
        doc('cabin', 'beta', { title: 'בקתה ביתא' }),
        doc('page', 'home', {
          links: ['/cabins/alpha', '/cabins/beta', '/cabins/ghost'],
        }),
      ],
      site,
      'broken-links',
    )

    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('ghost')
  })

  it('stays silent when only one sibling resolves', () => {
    // One neighbour is a coincidence. The site's routing is the customer's own
    // code and cannot be read from here, so a prefix has to prove itself.
    expect(
      lint(
        [
          doc('cabin', 'alpha', { title: 'בקתה אלפא' }),
          doc('page', 'home', { links: ['/cabins/alpha', '/cabins/ghost'] }),
        ],
        site,
        'broken-links',
      ),
    ).toEqual([])
  })

  it('stays silent on top-level paths', () => {
    // `/contact` is where a hand-written page lives on almost every site.
    expect(
      lint(
        [
          doc('cabin', 'alpha', { title: 'בקתה אלפא' }),
          doc('cabin', 'beta', { title: 'בקתה ביתא' }),
          doc('page', 'home', { links: ['/alpha', '/beta', '/contact'] }),
        ],
        site,
        'broken-links',
      ),
    ).toEqual([])
  })

  it('stays silent on external links and on files', () => {
    expect(
      lint(
        [
          doc('cabin', 'alpha', { title: 'בקתה אלפא' }),
          doc('cabin', 'beta', { title: 'בקתה ביתא' }),
          doc('page', 'home', {
            links: [
              '/cabins/alpha',
              '/cabins/beta',
              'https://example.co.il/nothing',
              '/files/terms.pdf',
            ],
          }),
        ],
        site,
        'broken-links',
      ),
    ).toEqual([])
  })
})

/* ── missing alt ──────────────────────────────────────────────────────────── */

describe('missing-alt', () => {
  const gallery = model(contentType('page', [field('seo', 'seo'), field('gallery', 'gallery')]))

  it('finds an image published with no description', () => {
    const findings = lint(
      [
        doc('page', 'home', {
          gallery: [
            { assetId: 'asset-1', url: 'https://cdn.example/1.jpg', alt: 'שקיעה' },
            { assetId: 'asset-2', url: 'https://cdn.example/2.jpg' },
          ],
        }),
      ],
      gallery,
      'missing-alt',
    )

    expect(findings).toHaveLength(1)
    expect(findings[0]?.locations[0]?.path).toBe('gallery[1]')
  })

  it('stays silent on the SEO image and on things that merely have a url', () => {
    // A call to action is `{ url, label }`, and an Open Graph image is never
    // rendered with an alt attribute. Reporting either is how this check would
    // become the reason nobody runs the command.
    expect(
      lint(
        [
          doc('page', 'home', {
            seo: { title: 'דף הבית', image: { assetId: 'asset-3' } },
            cta: { url: '/cabins/alpha', label: 'לפרטים' },
            terms: { url: 'https://example.co.il/terms' },
            hero: { assetId: 'asset-4', url: 'https://cdn.example/4.jpg', alt: 'הבקתה בבוקר' },
          }),
        ],
        gallery,
        'missing-alt',
      ),
    ).toEqual([])
  })

  it('treats blank alt text as no alt text', () => {
    expect(
      lint(
        [doc('page', 'home', { hero: { assetId: 'asset-5', alt: '   ' } })],
        gallery,
        'missing-alt',
      ),
    ).toHaveLength(1)
  })
  it('stays silent on a VIDEO with dimensions', () => {
    // Width and height do not make something an image — a video has both for
    // exactly the same reasons. This was reported as "an image with no
    // description" until the corroboration rule stopped accepting size alone.
    const findings = lint(
      [doc('page', 'tour', { title: 'סיור', clip: { url: 'https://cdn.example/tour.mp4', width: 1920, height: 1080 } })],
      model(contentType('page')),
      'missing-alt',
    )
    expect(findings).toEqual([])
  })

  it('stays silent on a downloadable file', () => {
    const findings = lint(
      [doc('page', 'info', { title: 'מידע', file: { url: '/files/brochure.pdf', width: 800 } })],
      model(contentType('page')),
      'missing-alt',
    )
    expect(findings).toEqual([])
  })

  it('still catches an image served from a CDN path with no extension', () => {
    // The common real case, and the one the size signal exists for.
    const findings = lint(
      [doc('page', 'home', { title: 'בית', cover: { url: 'https://cdn.example/assets/x1y2', width: 1200, height: 800 } })],
      model(contentType('page')),
      'missing-alt',
    )
    expect(findings).toHaveLength(1)
  })

})

/* ── the search fields (M21.8) ────────────────────────────────────────────── */

describe('the seo checks', () => {
  /*
   * `stayRule` deliberately has NO seo field. It is the type that proves these
   * checks read the model instead of assuming one: a rule is a title and a
   * sentence, it is never a page, and reporting a missing search description on
   * one is the finding that would teach an operator to skip the output.
   *
   * `landing` names its field `search` rather than `seo`, for the same reason
   * the rest of the binary looks names up: the KIND is fixed by the schema, the
   * name belongs to whoever defined the type.
   */
  const site = model(
    contentType('page', [field('title', 'string'), field('seo', 'seo')]),
    contentType('landing', [field('title', 'string'), field('search', 'seo')]),
    contentType('stayRule', [field('title', 'string'), field('body', 'text')]),
  )

  const TITLE = 'בקתות אירוח בגליל העליון' // 24
  const DESCRIPTION =
    'בקתת ספא פרטית עם ג׳קוזי, נוף פתוח אל הכינרת וארוחת בוקר כפרית שמוגשת אל הבקתה. לזוגות בלבד, כניסה מגיל 18.' // 107

  /** A string of exactly `length` characters, for the boundary cases. */
  function chars(length: number): string {
    return 'א'.repeat(length)
  }

  describe('missing-seo', () => {
    it('finds a published page with no search title and no search description', () => {
      const findings = lint([doc('page', 'home', { title: 'דף הבית' })], site, 'missing-seo')

      expect(findings).toHaveLength(1)
      expect(findings[0]?.message).toContain('no search title and no description')
      expect(findings[0]?.locations[0]?.path).toBe('seo.title')
    })

    it('finds a page that has a title but no description', () => {
      const findings = lint(
        [doc('page', 'home', { seo: { title: TITLE } })],
        site,
        'missing-seo',
      )

      expect(findings).toHaveLength(1)
      expect(findings[0]?.message).toContain('no search description')
      expect(findings[0]?.locations[0]?.path).toBe('seo.description')
    })

    it('treats a blank string as no value at all', () => {
      expect(
        lint(
          [doc('page', 'home', { seo: { title: '   ', description: DESCRIPTION } })],
          site,
          'missing-seo',
        ),
      ).toHaveLength(1)
    })

    it('stays silent on a type that has no search field', () => {
      // The whole point. A stay rule cannot hold an seo value, so it can never
      // be missing one.
      expect(
        lint([doc('stayRule', 'checkin', { title: 'שעת כניסה', body: 'מ-16:00' })], site, 'missing-seo'),
      ).toEqual([])
    })

    it('stays silent when both are filled in', () => {
      expect(
        lint(
          [doc('page', 'home', { seo: { title: TITLE, description: DESCRIPTION } })],
          site,
          'missing-seo',
        ),
      ).toEqual([])
    })

    it('reads the field by its kind, not by the name `seo`', () => {
      const findings = lint([doc('landing', 'promo', { search: { title: TITLE } })], site, 'missing-seo')

      expect(findings).toHaveLength(1)
      expect(findings[0]?.locations[0]?.path).toBe('search.description')
    })
  })

  describe('seo-title-length', () => {
    it('finds a title too short to say anything', () => {
      const findings = lint(
        [doc('page', 'home', { seo: { title: 'בקתה', description: DESCRIPTION } })],
        site,
        'seo-title-length',
      )

      expect(findings).toHaveLength(1)
      expect(findings[0]?.message).toContain('4-character')
      expect(findings[0]?.locations[0]?.quote).toBe('בקתה')
    })

    it('finds a title that will be cut off', () => {
      const findings = lint(
        [doc('page', 'home', { seo: { title: chars(61), description: DESCRIPTION } })],
        site,
        'seo-title-length',
      )

      expect(findings).toHaveLength(1)
      expect(findings[0]?.message).toContain('cut off')
    })

    it('stays silent at both boundaries', () => {
      // 15 and 60 are IN range. An off-by-one here reports a title that is fine,
      // which is the failure mode this whole file is tuned against.
      expect(
        lint(
          [
            doc('page', 'a', { seo: { title: chars(15) } }),
            doc('page', 'b', { seo: { title: chars(60) } }),
            doc('page', 'c', { seo: { title: TITLE } }),
          ],
          site,
          'seo-title-length',
        ),
      ).toEqual([])
    })

    it('stays silent when there is no title, leaving that to missing-seo', () => {
      // Two findings for one empty field is how an operator learns the output is
      // padded.
      expect(lint([doc('page', 'home', {})], site, 'seo-title-length')).toEqual([])
    })

    it('counts what a reader sees, not UTF-16 units', () => {
      // 🌿 is two code units and one character. Counting units would report a
      // 60-character title as 61.
      expect(
        lint([doc('page', 'home', { seo: { title: `🌿${chars(59)}` } })], site, 'seo-title-length'),
      ).toEqual([])
    })
  })

  describe('seo-description-length', () => {
    it('finds a description too short to say anything', () => {
      const findings = lint(
        [doc('page', 'home', { seo: { title: TITLE, description: 'נוף לכינרת.' } })],
        site,
        'seo-description-length',
      )

      expect(findings).toHaveLength(1)
      expect(findings[0]?.message).toContain('11-character')
      expect(findings[0]?.locations[0]?.path).toBe('seo.description')
    })

    it('finds a description that will be cut off', () => {
      expect(
        lint(
          [doc('page', 'home', { seo: { title: TITLE, description: chars(161) } })],
          site,
          'seo-description-length',
        ),
      ).toHaveLength(1)
    })

    it('stays silent at both boundaries and on a real one', () => {
      expect(
        lint(
          [
            doc('page', 'a', { seo: { description: chars(70) } }),
            doc('page', 'b', { seo: { description: chars(160) } }),
            doc('page', 'c', { seo: { description: DESCRIPTION } }),
          ],
          site,
          'seo-description-length',
        ),
      ).toEqual([])
    })
  })

  describe('duplicate-seo', () => {
    it('reports one finding carrying every page that shares the title', () => {
      const findings = lint(
        [
          doc('page', 'alpha', { seo: { title: TITLE } }),
          doc('page', 'beta', { seo: { title: TITLE } }),
          doc('page', 'gamma', { seo: { title: TITLE } }),
        ],
        site,
        'duplicate-seo',
      )

      expect(findings).toHaveLength(1)
      expect(findings[0]?.locations).toHaveLength(3)
      expect(findings[0]?.locations.map((location) => location.slug)).toEqual([
        'alpha',
        'beta',
        'gamma',
      ])
    })

    it('stays silent across types, which is the deliberate miss', () => {
      // A landing page copied from a page IS a real duplicate and is not
      // reported. The reason is the pair this rule exists to suppress: a
      // settings singleton's seo is the site-wide default, and the home page
      // matching it is the default working, not two pages fighting. Nothing in
      // the model says which types are pages, so the two cases are the same
      // shape. Measured on the reference site, unrestricted matching found one
      // collision and it was that pair.
      expect(
        lint(
          [
            doc('page', 'alpha', { seo: { title: TITLE } }),
            doc('landing', 'promo', { search: { title: TITLE } }),
          ],
          site,
          'duplicate-seo',
        ),
      ).toEqual([])
    })

    it('names the type in the message, because the type is the scope', () => {
      const findings = lint(
        [
          doc('landing', 'promo', { search: { title: TITLE } }),
          doc('landing', 'promo-2', { search: { title: TITLE } }),
        ],
        site,
        'duplicate-seo',
      )

      expect(findings).toHaveLength(1)
      expect(findings[0]?.message).toContain('2 landing documents')
      expect(findings[0]?.locations[0]?.path).toBe('search.title')
    })

    it('stays silent on titles that differ only in case or in spacing', () => {
      // Deliberate miss. Case-folding would catch a few more and would also
      // start reporting pairs a person looking at both would call different —
      // Hebrew has no case, so the rule would only ever fire on Latin brand
      // names, which are exactly where the capitalisation is the point.
      expect(
        lint(
          [
            doc('page', 'alpha', { seo: { title: 'Nofim Guesthouse' } }),
            doc('page', 'beta', { seo: { title: 'nofim guesthouse' } }),
          ],
          site,
          'duplicate-seo',
        ),
      ).toEqual([])
    })

    it('stays silent when the titles are simply absent', () => {
      // Two empty fields are not two pages claiming the same name.
      expect(
        lint(
          [doc('page', 'alpha', {}), doc('page', 'beta', { seo: { description: DESCRIPTION } })],
          site,
          'duplicate-seo',
        ),
      ).toEqual([])
    })
  })
})

/* ── orphan documents ─────────────────────────────────────────────────────── */

/* ── the runner ───────────────────────────────────────────────────────────── */

describe('runLint', () => {
  it('runs every check by default and reports which ones ran', () => {
    const report = runLint({ documents: [], model: model() })
    expect(report.checks).toEqual(CHECK_NAMES)
    expect(report.findings).toEqual([])
    expect(report.documentCount).toBe(0)
  })

})

/* ── the command ──────────────────────────────────────────────────────────── */

const scratchDirs: string[] = []

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-lint-'))
  scratchDirs.push(dir)
  mkdirSync(join(dir, 'app'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'demo' }, null, 2)}\n`)
  return dir
}

function fakeApi(documents: Readonly<Record<string, readonly unknown[]>>, types: unknown): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString()
    const body = url.includes('/content/_all')
      ? {
          project_id: 'proj-1',
          content_version: 3,
          types: Object.keys(documents),
          documents,
          total: Object.values(documents).reduce((sum, list) => sum + list.length, 0),
          truncated: false,
        }
      : { types, objects: [] }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

function io(dir: string): ReturnType<typeof captureIo> {
  return captureIo({
    cwd: dir,
    env: { [ENV.projectId]: 'proj-1', [ENV.readKey]: 'read-key-test' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe('the lint command', () => {
  const wireDocument = (id: string, slug: string, data: unknown): unknown => ({
    id,
    type: 'page',
    slug,
    status: 'published',
    locale: 'he',
    data,
    updated_at: '2026-08-01T00:00:00.000Z',
  })

  it('exits 0 and says so when the content is consistent', async () => {
    const dir = project()
    fakeApi({ page: [wireDocument('doc-1', 'home', { title: 'ברוכים הבאים' })] }, [
      { key: 'page', title: 'עמוד', titleField: 'title', slugField: 'slug', fields: [] },
    ])

    const captured = io(dir)
    const code = await run(['lint', '--api-url', 'https://api.example.co.il/v1'], captured)

    expect(code).toBe(EXIT.ok)
    expect(captured.stdout()).toContain('No content problems found')
  })

  it('exits 1 with a single JSON object when findings exist', async () => {
    const dir = project()
    fakeApi(
      {
        page: [
          wireDocument('doc-1', 'villa', {
            title: 'הוילה',
            // An image with no description. Was a number contradiction until
            // that check was withdrawn; this one is a fact about a value.
            cover: { url: 'https://cdn.example/villa.jpg', width: 1200, height: 800 },
          }),
        ],
      },
      [{ key: 'page', title: 'עמוד', titleField: 'title', slugField: 'slug', fields: [] }],
    )

    const captured = io(dir)
    const code = await run(
      ['lint', '--json', '--api-url', 'https://api.example.co.il/v1'],
      captured,
    )

    expect(code).toBe(EXIT.error)
    const payload: unknown = JSON.parse(captured.stdout())
    expect(payload).toMatchObject({ ok: false, command: 'lint', documents: 1 })
  })

  it('refuses an unknown --check and names the ones that exist', async () => {
    const dir = project()
    fakeApi({}, [])

    const captured = io(dir)
    const code = await run(['lint', '--check', 'spelling'], captured)

    expect(code).toBe(EXIT.error)
    expect(captured.stderr()).toContain('No such check: spelling')
    expect(captured.stderr()).toContain('broken-links')
  })
})
