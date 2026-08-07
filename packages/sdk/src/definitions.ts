import type { BlockKind, ContentTypeKey } from './types'

/**
 * PRD §8 — the schema *descriptions* the type generator consumes.
 *
 * WHY THIS IS A MIRROR AND NOT AN IMPORT
 * --------------------------------------
 * The API seeds these exact definitions from `apps/api/lib/seed.ts`. This
 * package is published to npm and cannot import from the API application, so
 * the definitions are restated here. `tests/definitions.test.ts` imports the
 * API's copy and asserts the two are deep-equal, so a drift fails the build
 * rather than silently generating types the server does not honour.
 *
 * The block field definitions live ONLY here: `seed.ts` names the three block
 * kinds but never describes their fields, and the generator needs them.
 */

export const CONTENT_TYPE_KEYS: readonly ContentTypeKey[] = [
  'page',
  'post',
  'product',
  'collection',
]

export const BLOCK_KINDS: readonly BlockKind[] = ['hero', 'richtext', 'cta']

/** Narrows an arbitrary string from the wire to a key this version knows. */
export function isContentTypeKey(value: string): value is ContentTypeKey {
  return (CONTENT_TYPE_KEYS as readonly string[]).includes(value)
}

export const FIELD_KINDS = [
  'string',
  'text',
  'richtext',
  'number',
  'boolean',
  'date',
  'image',
  'gallery',
  'reference',
  'select',
  'url',
  'seo',
  'blocks',
  'stringList',
  'custom',
] as const

export type FieldKind = (typeof FIELD_KINDS)[number]

export interface FieldDefinition {
  readonly name: string
  readonly kind: FieldKind
  readonly required: boolean
  /** Array-valued field (`tags`, `items`, `images`, `sections`). */
  readonly repeated?: boolean
  /** `select` only — the closed set of allowed values. */
  readonly options?: readonly string[]
  /** `reference` only — which content types may be pointed at. */
  readonly to?: readonly ContentTypeKey[]
  /** `blocks` only — which `_type`s are allowed in the array. */
  readonly blocks?: readonly BlockKind[]
}

export interface ContentTypeDefinition {
  readonly key: ContentTypeKey
  readonly title: string
  readonly titleField: string
  readonly slugField: string
  readonly fields: readonly FieldDefinition[]
}

/** A block is a small content type with a `_type` discriminator instead of a slug. */
export interface BlockDefinition {
  readonly kind: BlockKind
  readonly title: string
  readonly fields: readonly FieldDefinition[]
}

/* ── the four content types ───────────────────────────────────────────────── */

const TITLE_FIELD: FieldDefinition = { name: 'title', kind: 'string', required: true }
const SLUG_FIELD: FieldDefinition = { name: 'slug', kind: 'string', required: true }
const SEO_FIELD: FieldDefinition = { name: 'seo', kind: 'seo', required: false }
const CUSTOM_FIELD: FieldDefinition = { name: 'custom', kind: 'custom', required: false }

const PAGE: ContentTypeDefinition = {
  key: 'page',
  title: 'Page',
  titleField: 'title',
  slugField: 'slug',
  fields: [
    TITLE_FIELD,
    SLUG_FIELD,
    { name: 'sections', kind: 'blocks', required: false, repeated: true, blocks: BLOCK_KINDS },
    SEO_FIELD,
    CUSTOM_FIELD,
  ],
}

const POST: ContentTypeDefinition = {
  key: 'post',
  title: 'Post',
  titleField: 'title',
  slugField: 'slug',
  fields: [
    TITLE_FIELD,
    SLUG_FIELD,
    { name: 'excerpt', kind: 'text', required: false },
    { name: 'body', kind: 'richtext', required: false },
    { name: 'cover', kind: 'image', required: false },
    { name: 'publishedAt', kind: 'date', required: false },
    { name: 'tags', kind: 'stringList', required: false, repeated: true },
    SEO_FIELD,
    CUSTOM_FIELD,
  ],
}

const PRODUCT: ContentTypeDefinition = {
  key: 'product',
  title: 'Product',
  titleField: 'title',
  slugField: 'slug',
  fields: [
    TITLE_FIELD,
    SLUG_FIELD,
    { name: 'description', kind: 'richtext', required: false },
    { name: 'price', kind: 'number', required: false },
    { name: 'currency', kind: 'select', required: false, options: ['ILS', 'USD'] },
    { name: 'images', kind: 'gallery', required: false, repeated: true },
    { name: 'inStock', kind: 'boolean', required: false },
    SEO_FIELD,
    CUSTOM_FIELD,
  ],
}

const COLLECTION: ContentTypeDefinition = {
  key: 'collection',
  title: 'Collection',
  titleField: 'title',
  slugField: 'slug',
  fields: [
    TITLE_FIELD,
    SLUG_FIELD,
    {
      name: 'items',
      kind: 'reference',
      required: false,
      repeated: true,
      to: ['page', 'post', 'product'],
    },
    { name: 'description', kind: 'text', required: false },
    CUSTOM_FIELD,
  ],
}

export const CONTENT_TYPES: Readonly<Record<ContentTypeKey, ContentTypeDefinition>> = {
  page: PAGE,
  post: POST,
  product: PRODUCT,
  collection: COLLECTION,
}

/** Generation order — matches the API's seeding order. */
export const CONTENT_TYPE_LIST: readonly ContentTypeDefinition[] = CONTENT_TYPE_KEYS.map(
  (key) => CONTENT_TYPES[key],
)

/* ── the three blocks (locked decision T9) ────────────────────────────────── */

const HERO: BlockDefinition = {
  kind: 'hero',
  title: 'Hero',
  fields: [
    { name: 'heading', kind: 'string', required: true },
    { name: 'subheading', kind: 'text', required: false },
    { name: 'ctaLabel', kind: 'string', required: false },
    { name: 'ctaHref', kind: 'url', required: false },
    { name: 'image', kind: 'image', required: false },
  ],
}

const RICHTEXT: BlockDefinition = {
  kind: 'richtext',
  title: 'Rich text',
  fields: [{ name: 'body', kind: 'richtext', required: true }],
}

const CTA: BlockDefinition = {
  kind: 'cta',
  title: 'Call to action',
  fields: [
    { name: 'heading', kind: 'string', required: true },
    { name: 'body', kind: 'text', required: false },
    { name: 'buttonLabel', kind: 'string', required: false },
    { name: 'buttonHref', kind: 'url', required: false },
  ],
}

export const BLOCKS: Readonly<Record<BlockKind, BlockDefinition>> = {
  hero: HERO,
  richtext: RICHTEXT,
  cta: CTA,
}

export const BLOCK_LIST: readonly BlockDefinition[] = BLOCK_KINDS.map((kind) => BLOCKS[kind])
