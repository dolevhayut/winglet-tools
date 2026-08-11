import { TYPES_FILE } from '@product'
import { describe, expect, it } from 'vitest'

import {
  BLOCK_LIST,
  CONTENT_TYPE_KEYS,
  CONTENT_TYPE_LIST,
  OBJECT_LIST,
} from '../src/definitions'
import type { BlockDefinition, ContentTypeDefinition } from '../src/definitions'
import { FIELD_SCHEMAS } from '../src/schemas'
import {
  DEFAULT_TYPEGEN_INPUT,
  blockNameFor,
  fieldType,
  generateTypes,
  objectNameFor,
  typeNameFor,
} from '../src/typegen'

/**
 * PRD §11 — `types` regenerates the customer's types file from the schema
 * definitions. The generator is pure, so everything below is an assertion on a
 * returned string: no filesystem, no fixtures to clean up.
 */

const output = generateTypes()

/** The body of one interface, so a test can assert on its fields precisely. */
function interfaceBody(source: string, name: string): string {
  const match = new RegExp(
    `export interface ${name}(?: extends [^{]+)?\\s*\\{([^}]*)\\}`,
    'm',
  ).exec(source)
  if (match?.[1] === undefined) throw new Error(`No interface ${name} in the generated output`)
  return match[1]
}

function fieldLines(source: string, name: string): string[] {
  return interfaceBody(source, name)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('/'))
}

describe('purity', () => {
  it('is deterministic — the same input yields byte-identical output', () => {
    expect(generateTypes()).toBe(generateTypes())
  })

  it('reads nothing from the environment', () => {
    // A generator that embedded a timestamp, a path or a hostname would produce
    // a diff on every run and force a needless rebuild.
    expect(output).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(output).not.toContain(process.cwd())
  })

  it('generates only from the definitions it is handed', () => {
    const single: ContentTypeDefinition = {
      key: 'page',
      title: 'Page',
      titleField: 'title',
      slugField: 'slug',
      fields: [{ name: 'title', kind: 'string', required: true }],
    }
    const noBlocks: readonly BlockDefinition[] = []

    const narrow = generateTypes({ contentTypes: [single], blocks: noBlocks })

    expect(narrow).toContain("export type ContentTypeKey = 'page'")
    expect(narrow).not.toContain('interface Post')
    expect(narrow).not.toContain('interface HeroBlock')
    expect(narrow).toContain('export type Block = never')
  })
})

describe('the generated file', () => {
  it('names itself and warns against editing', () => {
    expect(output).toContain(TYPES_FILE)
    expect(output).toContain('DO NOT EDIT')
  })

  it('ends with exactly one newline and has no triple blank lines', () => {
    expect(output.endsWith('\n')).toBe(true)
    expect(output.endsWith('\n\n')).toBe(false)
    expect(output).not.toMatch(/\n\n\n/)
  })

  it('declares the four content type keys as a closed union', () => {
    expect(output).toContain(
      "export type ContentTypeKey = 'page' | 'post' | 'product' | 'collection'",
    )
  })
})

describe('blocks', () => {
  it('emits one interface per Phase 1 block, discriminated on _type', () => {
    for (const block of BLOCK_LIST) {
      const body = interfaceBody(output, blockNameFor(block.kind))
      expect(body).toContain(`readonly _type: '${block.kind}'`)
    }
  })

  it('emits the discriminated union', () => {
    expect(output).toContain('export type Block = HeroBlock | RichtextBlock | CtaBlock')
  })

  it('does not emit the five Phase 2 block types', () => {
    // Named as BLOCK interfaces, not as bare words. `faq` is one of §8's eight
    // block types AND — since M10 — a registered object, so asserting the
    // substring `faq` is absent would now fail on `FaqObject`, which is a
    // different feature that is supposed to be there.
    for (const absent of [
      'ImageTextBlock',
      'FaqBlock',
      'TestimonialsBlock',
      'ContactFormBlock',
      'GalleryBlock',
    ]) {
      expect(output).not.toContain(absent)
    }
  })
})

describe('content types', () => {
  it('emits a Fields interface and a document interface per type', () => {
    for (const definition of CONTENT_TYPE_LIST) {
      const name = typeNameFor(definition.key)
      expect(output).toContain(`export interface ${name}Fields {`)
      expect(output).toContain(
        `export interface ${name} extends ${name}Fields, DocumentMeta<'${definition.key}'> {}`,
      )
    }
  })

  it('maps every §8 field kind to the right TypeScript type', () => {
    expect(fieldLines(output, 'PageFields')).toEqual([
      'readonly title: string',
      'readonly slug: string',
      'readonly sections?: readonly (HeroBlock | RichtextBlock | CtaBlock)[] | undefined',
      // M10 — `array<object>` resolves to the registered object's interface.
      'readonly faq?: readonly FaqObject[] | undefined',
      'readonly gallery?: readonly GalleryImageObject[] | undefined',
      'readonly seo?: SeoFields | undefined',
      'readonly custom?: CustomFields | undefined',
    ])

    expect(fieldLines(output, 'PostFields')).toEqual([
      'readonly title: string',
      'readonly slug: string',
      'readonly excerpt?: string | undefined',
      'readonly body?: RichText | undefined',
      'readonly cover?: ImageRef | undefined',
      'readonly publishedAt?: string | undefined',
      'readonly tags?: readonly string[] | undefined',
      'readonly seo?: SeoFields | undefined',
      'readonly custom?: CustomFields | undefined',
    ])

    expect(fieldLines(output, 'ProductFields')).toEqual([
      'readonly title: string',
      'readonly slug: string',
      'readonly description?: RichText | undefined',
      'readonly price?: number | undefined',
      "readonly currency?: 'ILS' | 'USD' | undefined",
      'readonly images?: readonly ImageRef[] | undefined',
      'readonly inStock?: boolean | undefined',
      'readonly seo?: SeoFields | undefined',
      'readonly custom?: CustomFields | undefined',
    ])

    expect(fieldLines(output, 'CollectionFields')).toEqual([
      'readonly title: string',
      'readonly slug: string',
      'readonly items?: readonly Reference[] | undefined',
      'readonly description?: string | undefined',
      'readonly custom?: CustomFields | undefined',
    ])
  })

  it('parenthesises a repeated union so the array binds to the whole of it', () => {
    expect(
      fieldType({
        name: 'sections',
        kind: 'blocks',
        required: false,
        repeated: true,
        blocks: ['hero', 'cta'],
      }),
    ).toBe('readonly (HeroBlock | CtaBlock)[]')
  })

  it('emits the key-to-document map', () => {
    expect(output).toContain('readonly page: Page')
    expect(output).toContain('export type AnyDocument = ContentTypeMap[ContentTypeKey]')
  })
})

describe('the generated types agree with the runtime schemas', () => {
  // Iterates CONTENT_TYPE_KEYS, not the definitions' `key` field: since M11 that
  // field is a plain `string` (a project defines its own types), and only the
  // four seeded keys have a compiled schema to compare against.
  it.each(CONTENT_TYPE_KEYS)(
    '%s: same field names, same optionality',
    (key) => {
      const generated = fieldLines(output, `${typeNameFor(key)}Fields`).map((line) => {
        const match = /^readonly (\w+)(\??):/.exec(line)
        if (match === null) throw new Error(`Unparseable generated line: ${line}`)
        return { name: match[1] ?? '', optional: match[2] === '?' }
      })

      // `shape` is a union of four differently-keyed objects; iterating entries
      // sidesteps indexing it by a plain string.
      const runtime = Object.entries(FIELD_SCHEMAS[key].shape).map(([name, schema]) => ({
        name,
        optional: schema.safeParse(undefined).success,
      }))

      expect([...generated].sort((a, b) => a.name.localeCompare(b.name))).toEqual(
        [...runtime].sort((a, b) => a.name.localeCompare(b.name)),
      )
    },
  )
})

describe('the default input', () => {
  it('is §8 and the three Phase 1 blocks', () => {
    expect(DEFAULT_TYPEGEN_INPUT.contentTypes).toEqual(CONTENT_TYPE_LIST)
    expect(DEFAULT_TYPEGEN_INPUT.blocks).toEqual(BLOCK_LIST)
  })
})

/* ── objects (M10) ────────────────────────────────────────────────────────── */

describe('registered objects', () => {
  it('emits one interface per object, extending the item-key carrier', () => {
    for (const object of OBJECT_LIST) {
      expect(output).toContain(
        `export interface ${objectNameFor(object.key)} extends ObjectItemMeta {`,
      )
    }
  })

  it('emits `_key` as OPTIONAL', () => {
    // The server always stamps one, but a document written before M10 — or
    // restored from a snapshot that predates it — has items without one.
    // Requiring it would make the customer's own content fail to type-check
    // against their own generated types.
    expect(fieldLines(output, 'ObjectItemMeta')).toEqual(['readonly _key?: string | undefined'])
  })

  it('carries required-ness and kind through to the object interface', () => {
    expect(fieldLines(output, objectNameFor('galleryImage'))).toEqual([
      'readonly image: ImageRef',
      'readonly alt: string',
      'readonly caption?: string | undefined',
    ])
  })

  it('suffixes the name, so an object and a content type may share a key', () => {
    // Separate namespaces on the server; without the suffix a project holding
    // both would generate the same interface twice and fail to compile.
    expect(objectNameFor('page')).toBe('PageObject')
    expect(objectNameFor('page')).not.toBe(typeNameFor('page'))
  })

  it('resolves a repeated object field to a readonly array of the interface', () => {
    expect(
      fieldType(
        { name: 'gallery', kind: 'object', required: false, repeated: true, of: 'galleryImage' },
        new Set(['galleryImage']),
      ),
    ).toBe('readonly GalleryImageObject[]')
  })

  it('resolves a single object field to the bare interface', () => {
    expect(
      fieldType({ name: 'hero', kind: 'object', required: true, of: 'galleryImage' }, new Set(['galleryImage'])),
    ).toBe('GalleryImageObject')
  })

  it('degrades an UNKNOWN object to an open record rather than a dangling name', () => {
    // A types file that references an interface which was never emitted does
    // not compile in the customer's project. An unreadable-but-present value is
    // the honest answer while a registry fetch is stale.
    expect(fieldType({ name: 'rooms', kind: 'object', required: false, of: 'roomCard' }, new Set()))
      .toBe('Readonly<Record<string, unknown>>')
  })

  it('degrades a field whose `of` was never set', () => {
    expect(fieldType({ name: 'broken', kind: 'object', required: false }, new Set(['faq']))).toBe(
      'Readonly<Record<string, unknown>>',
    )
  })

  it('emits no object section at all when the project defines none', () => {
    const bare = generateTypes({ contentTypes: CONTENT_TYPE_LIST, blocks: BLOCK_LIST, objects: [] })
    expect(bare).not.toContain('ObjectItemMeta')
    // The page fields still generate — they just lose their resolved shape.
    expect(bare).toContain('readonly faq?: readonly Readonly<Record<string, unknown>>[] | undefined')
  })

  it('generates a project-specific registry, not the built-in one', () => {
    // The whole point of M10 reaching typegen: two projects on the same CLI
    // version produce different files.
    const custom = generateTypes({
      contentTypes: CONTENT_TYPE_LIST,
      blocks: BLOCK_LIST,
      objects: [
        {
          key: 'priceRow',
          title: 'Price row',
          fields: [
            { name: 'label', kind: 'string', required: true },
            { name: 'price', kind: 'number', required: true },
          ],
        },
      ],
    })
    expect(custom).toContain('export interface PriceRowObject extends ObjectItemMeta {')
    expect(custom).not.toContain('FaqObject')
  })
})

/* ── project-defined types (M11) ──────────────────────────────────────────── */

describe('types the project defined rather than the SDK', () => {
  const ACCOMMODATION: ContentTypeDefinition = {
    key: 'accommodation',
    title: 'מתחם אירוח',
    titleField: 'title',
    slugField: 'slug',
    fields: [
      { name: 'title', kind: 'string', required: true },
      { name: 'slug', kind: 'string', required: true },
      { name: 'sleeps', kind: 'number', required: false },
      { name: 'visibility', kind: 'select', required: false, options: ['listed', 'hidden'] },
      { name: 'gallery', kind: 'object', required: false, repeated: true, of: 'galleryImage' },
      { name: 'sections', kind: 'blocks', required: false, repeated: true, blocks: ['hero', 'cta'] },
      { name: 'oldField', kind: 'string', required: false, deprecated: true },
    ],
  }

  const generated = generateTypes({
    contentTypes: [ACCOMMODATION],
    blocks: BLOCK_LIST,
    objects: OBJECT_LIST,
  })

  it('emits the interface pair under the project’s own key', () => {
    expect(generated).toContain('export interface AccommodationFields {')
    expect(generated).toContain(
      "export interface Accommodation extends AccommodationFields, DocumentMeta<'accommodation'> {}",
    )
  })

  it('puts the key in the union and the map', () => {
    expect(generated).toContain("export type ContentTypeKey = 'accommodation'")
    expect(generated).toContain('readonly accommodation: Accommodation')
  })

  it('resolves every field kind, including the ones read back from jsonb', () => {
    expect(fieldLines(generated, 'AccommodationFields')).toEqual([
      'readonly title: string',
      'readonly slug: string',
      'readonly sleeps?: number | undefined',
      "readonly visibility?: 'listed' | 'hidden' | undefined",
      'readonly gallery?: readonly GalleryImageObject[] | undefined',
      // The regression this pins: `blocks` used to be dropped on the way from
      // the API to the generator, so a project-sourced `sections` came out as
      // `readonly never[]` — readable, never assignable.
      'readonly sections?: readonly (HeroBlock | CtaBlock)[] | undefined',
      'readonly oldField?: string | undefined',
    ])
  })

  it('marks a retired field @deprecated instead of dropping it', () => {
    // Dropping it would turn "still served by the API" into a compile error on
    // the customer's next `types` run — the exact breakage deprecation exists
    // to avoid.
    expect(generated).toContain('@deprecated')
    expect(generated).toContain('readonly oldField?: string | undefined')
  })
})
