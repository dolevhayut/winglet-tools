import type { BlockKind, ContentTypeKey } from './types'

/**
 * PRD §8 — the schema *descriptions* the type generator consumes.
 *
 * WHY THIS IS A MIRROR AND NOT AN IMPORT
 * --------------------------------------
 * The API seeds these exact definitions from `apps/api/lib/seed.ts`. This
 * package is published to npm and cannot import from the API application, so
 * the definitions are restated here.
 *
 * THE DRIFT GUARD LIVES IN THE PRIVATE REPO, NOT HERE. These two files are in
 * different repositories, and only the private one can see both: it fetches
 * this file and compares. See `tools/guards/definitions-sync.test.ts` there.
 * An earlier version of this comment named a `tests/definitions.test.ts` in
 * this package that never existed, which is exactly the kind of claim a guard
 * is supposed to make impossible.
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

/**
 * `object` (M10 / PRD-v2 §3.2) is the only kind whose shape is not fixed here:
 * it names an entry in the project's own object registry through
 * `FieldDefinition.of`. With `repeated` it becomes `array<object>`.
 */
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
  'object',
] as const

export type FieldKind = (typeof FIELD_KINDS)[number]

/**
 * The optional members are spelled `?: T | undefined` rather than `?: T`,
 * for the same reason the generated interfaces are — see the note on
 * `fieldLine` in `typegen.ts`. Under `exactOptionalPropertyTypes` the short
 * form forbids an explicit `undefined`, and these values now arrive from a zod
 * parse of a `jsonb` column, whose inferred output is the long form.
 */
export interface FieldDefinition {
  readonly name: string
  readonly kind: FieldKind
  readonly required: boolean
  /**
   * What the studio calls this field, in the customer's language (M11).
   *
   * Absent from every seeded definition on purpose — the studio carries Hebrew
   * names for those already, and these definitions are also read by developers,
   * where English is right. This is for the fields a PROJECT defines, where the
   * studio would otherwise show the raw key.
   */
  readonly title?: string | undefined
  /** Array-valued field (`tags`, `items`, `images`, `sections`, `gallery`). */
  readonly repeated?: boolean | undefined
  /** `select` only — the closed set of allowed values. */
  readonly options?: readonly string[] | undefined
  /**
   * `reference` only — which content types may be pointed at.
   *
   * Widened from the four-key union to `string` in M11: a project defines its
   * own types now, and a reference restricted to the seeded four would be
   * useless the moment anyone used the feature.
   */
  readonly to?: readonly string[] | undefined
  /**
   * `blocks` only — which `_type`s are allowed in the array.
   *
   * `string` for the same reason as `to`: a definition read back out of `jsonb`
   * is only as narrow as whatever wrote it. The union stays closed where it
   * earns its keep — the discriminated `Block` type a consumer switches on.
   */
  readonly blocks?: readonly string[] | undefined
  /** `object` only — the key of the registered object this field carries. */
  readonly of?: string | undefined
  /**
   * Retired, but not removed (M11 / PRD-v2 §3.3). Hidden in the studio, still
   * served by the API, still present on every document that has one.
   */
  readonly deprecated?: boolean | undefined
}

/**
 * A reusable field shape, registered once per project and referenced by key.
 *
 * Nesting is allowed since M18, bounded by `MAX_OBJECT_DEPTH` and refused when
 * cyclic. The key is a plain `string`, not a union — the registry is customer
 * data, and a closed list of object keys would be the very defect M10 exists to
 * remove.
 */
export interface ObjectDefinition {
  readonly key: string
  readonly title: string
  readonly fields: readonly FieldDefinition[]
}

/**
 * Kinds an object's own field may take — M18: all of them, `object` included.
 *
 * M10 made objects flat and said lifting it later would be additive. What forced
 * it: the reference site's price list is `groups[] → rows[]`, two levels, so a
 * flat registry could only hold it as `custom` — served by the API, with no
 * control in the studio. The owner could not edit their own prices.
 *
 * The costs M10 avoided are paid in the API's `model.ts`, not here: a cycle is
 * refused at write time and depth is capped, so every registry a reader sees is
 * a bounded acyclic graph and can be walked without a visited-set.
 */
export const OBJECT_FIELD_KINDS = FIELD_KINDS

/** How deep a chain of object references may run. Mirrors the API's constant. */
export const MAX_OBJECT_DEPTH = 3

/**
 * How many documents a content type may hold (M15 / PRD-v2 §6.1).
 *
 * `single` is a type there should be exactly one of — `siteSettings`,
 * `homePage`, `pricePage`. It is not a display preference: the API refuses a
 * second document of a `single` type, because the studio hiding a button only
 * protects the person looking at the studio, and the agent is the primary
 * worker here.
 */
export const CARDINALITIES = ['single', 'many'] as const

export type Cardinality = (typeof CARDINALITIES)[number]

export interface ContentTypeDefinition {
  /**
   * A plain `string` since M11. `ContentTypeKey` still names the four this
   * package SEEDS and gives named accessors to; a definition read back from a
   * project may be any key the customer defined.
   */
  readonly key: string
  readonly title: string
  readonly titleField: string
  readonly slugField: string
  /**
   * Absent means `many` (M15).
   *
   * Optional rather than defaulted into every definition so that a row stored
   * before M15 parses unchanged: no backfill, no migration, and a reader one
   * deploy behind still understands the whole model. Same reasoning as
   * `deprecated` on a field.
   */
  readonly cardinality?: Cardinality | undefined
  /**
   * The studio sidebar heading this type is filed under, in the customer's
   * language (M15 / PRD-v2 §6.2) — "מתחמי אירוח", "מחירים וכללים", "הגדרות".
   *
   * A LABEL ON THE TYPE, NOT A SEPARATE NAVIGATION DOCUMENT. §6.2 draws it as
   * an array of groups naming their members, which is more expressive and buys
   * a whole class of bug: a navigation list can name a type that was deleted,
   * omit one that was added, and disagree with the model in either direction.
   * Grouping BY a label the type itself carries cannot drift, because there is
   * only one list. What it gives up is ordering within a group — those come out
   * in model order — which is the cheaper thing to lose.
   */
  readonly group?: string | undefined
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

/* ── the seeded object registry (M10) ─────────────────────────────────────── */

/**
 * Two objects, seeded into every project. Not privileged: once content types
 * become definable they are indistinguishable from anything an agent registers
 * with the CLI's `objects add`. They exist because a field kind with nothing to
 * point at cannot be demonstrated, and because these two shapes are the
 * most-repeated ones PRD-v2 measured on a real production site.
 *
 * `required` means the key must be PRESENT, not non-empty — the same meaning it
 * carries on `title`.
 */
const FAQ_OBJECT: ObjectDefinition = {
  key: 'faq',
  title: 'Question and answer',
  fields: [
    { name: 'question', kind: 'string', required: true },
    { name: 'answer', kind: 'text', required: true },
  ],
}

const GALLERY_IMAGE_OBJECT: ObjectDefinition = {
  key: 'galleryImage',
  title: 'Gallery image',
  fields: [
    { name: 'image', kind: 'image', required: true },
    { name: 'alt', kind: 'string', required: true },
    { name: 'caption', kind: 'text', required: false },
  ],
}

export const OBJECT_LIST: readonly ObjectDefinition[] = [FAQ_OBJECT, GALLERY_IMAGE_OBJECT]

export const OBJECTS: Readonly<Record<string, ObjectDefinition>> = Object.fromEntries(
  OBJECT_LIST.map((definition) => [definition.key, definition]),
)

const PAGE: ContentTypeDefinition = {
  key: 'page',
  title: 'Page',
  titleField: 'title',
  slugField: 'slug',
  fields: [
    TITLE_FIELD,
    SLUG_FIELD,
    { name: 'sections', kind: 'blocks', required: false, repeated: true, blocks: BLOCK_KINDS },
    // The first two `array<object>` fields in the product. Optional, so every
    // document written before M10 is still valid and every consumer that never
    // reads them still compiles.
    { name: 'faq', kind: 'object', required: false, repeated: true, of: 'faq' },
    { name: 'gallery', kind: 'object', required: false, repeated: true, of: 'galleryImage' },
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
