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
