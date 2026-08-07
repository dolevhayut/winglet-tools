import { TYPES_FILE } from '@product'
import { describe, expect, it } from 'vitest'

import { BLOCK_LIST, CONTENT_TYPE_LIST } from '../src/definitions'
import type { BlockDefinition, ContentTypeDefinition } from '../src/definitions'
import { FIELD_SCHEMAS } from '../src/schemas'
import { DEFAULT_TYPEGEN_INPUT, blockNameFor, fieldType, generateTypes, typeNameFor } from '../src/typegen'

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
    for (const absent of ['imageText', 'faq', 'testimonials', 'contactForm', 'GalleryBlock']) {
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
  it.each(CONTENT_TYPE_LIST.map((definition) => definition.key))(
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
