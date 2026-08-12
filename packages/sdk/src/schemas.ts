import { z } from 'zod'

import type {
  Block,
  Collection,
  CollectionFields,
  ContentTypeKey,
  DocumentMeta,
  FaqObject,
  GalleryImageObject,
  ImageRef,
  Page,
  PageFields,
  PortableTextBlock,
  Post,
  PostFields,
  Product,
  ProductFields,
  Reference,
  SeoFields,
} from './types'

/**
 * Runtime validation for everything that crosses the wire.
 *
 * The object schemas below are deliberately NOT re-exported from the package
 * entry point: they are an implementation detail, and keeping them out of
 * `index.ts` keeps the published `.d.ts` down to the content types themselves.
 * The test suite imports this module directly to assert the schemas and the
 * generated types describe the same fields.
 *
 * Each public schema is annotated with `z.ZodType<T>` so the compiler proves the
 * parser produces exactly the interface in `types.ts` — if a field is added to
 * one and not the other, this file stops compiling.
 */

/* ── field values ─────────────────────────────────────────────────────────── */

export const contentTypeKeySchema = z.enum(['page', 'post', 'product', 'collection'])

export const documentStatusSchema = z.enum(['draft', 'published'])

export const imageRefObject = z.object({
  assetId: z.string().optional(),
  url: z.string().optional(),
  alt: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  // M12. Both optional on the read side: an image field written before these
  // existed has neither, and demanding them would turn old-but-valid content
  // into a ContentValidationError on the customer's live site.
  lqip: z.string().optional(),
  hotspot: z.object({ x: z.number(), y: z.number() }).optional(),
})

const imageRefSchema: z.ZodType<ImageRef> = imageRefObject

/**
 * The document `expand` resolves a reference into (M13), FLATTENED (M14).
 *
 * The API sends the wire envelope — `{ id, type, slug, data, … }` — so `_doc`
 * would arrive with its fields one level down while the document holding it has
 * them at the top. A customer would write `home.title` on one line and
 * `home.featured[0]._doc.data.title` on the next, for two things that are the
 * same kind of thing. `normaliseExpanded` below flattens it to the shape every
 * other document this SDK hands back already has.
 */
export const expandedDocumentObject = z.object({
  id: z.string(),
  type: z.string(),
  slug: z.string(),
  status: documentStatusSchema,
  locale: z.string(),
  data: z.unknown(),
  updated_at: z.string(),
})

/**
 * `_doc` HAS TO BE DECLARED HERE, or M13's `expand` silently does nothing.
 *
 * zod strips keys an object schema does not mention. Every project-defined type
 * decodes through `z.unknown()` and kept `_doc` by accident; the four SEEDED
 * types decode through real schemas, so `getCollection('picks', { expand:
 * ['items'] })` returned the reference with the resolved document quietly
 * removed — while `client.get('collection', 'picks', …)` returned it in full.
 * The same request, two answers, and the one that lost data was the one with the
 * better types.
 *
 * Found by M14 while checking that the generated types describe what actually
 * arrives, which is the entire argument PRD-v2 §6 makes for having them.
 */
export const referenceObject = z.object({
  _type: z.literal('reference').default('reference'),
  _ref: z.string(),
  type: contentTypeKeySchema.optional(),
  _doc: z.unknown().optional(),
})

const referenceSchema: z.ZodType<Reference> = referenceObject

export const seoObject = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  image: imageRefSchema.optional(),
})

const seoSchema: z.ZodType<SeoFields> = seoObject

/**
 * `custom` is §8's untyped escape hatch, so `unknown` is the honest value type:
 * anything that survived a jsonb round trip is legal, and the consumer narrows.
 */
export const customObject = z.record(z.string(), z.unknown())

/* ── richtext ─────────────────────────────────────────────────────────────── */

export const portableTextSpanObject = z.object({
  _type: z.literal('span'),
  text: z.string(),
  marks: z.array(z.string()).optional(),
  _key: z.string().optional(),
})

export const portableTextBlockObject = z.object({
  _type: z.literal('block'),
  style: z.string().optional(),
  children: z.array(portableTextSpanObject),
  // See the note on `PortableTextBlock.markDefs`: without this, a link survives
  // as a mark with no destination.
  markDefs: z.array(z.unknown()).optional(),
  listItem: z.string().optional(),
  level: z.number().optional(),
  _key: z.string().optional(),
})

const portableTextBlockSchema: z.ZodType<PortableTextBlock> = portableTextBlockObject

export const richTextSchema = z.array(portableTextBlockSchema)

/* ── blocks ───────────────────────────────────────────────────────────────── */

export const heroBlockObject = z.object({
  _type: z.literal('hero'),
  heading: z.string(),
  subheading: z.string().optional(),
  ctaLabel: z.string().optional(),
  ctaHref: z.string().optional(),
  image: imageRefSchema.optional(),
})

export const richtextBlockObject = z.object({
  _type: z.literal('richtext'),
  body: richTextSchema,
})

export const ctaBlockObject = z.object({
  _type: z.literal('cta'),
  heading: z.string(),
  body: z.string().optional(),
  buttonLabel: z.string().optional(),
  buttonHref: z.string().optional(),
})

/**
 * Closed on `_type`, exactly as `seed.ts` intends: "an agent that invents a
 * ninth `_type` should fail validation, not silently persist it". On the read
 * side that surfaces as a `ContentValidationError` naming the offending block,
 * which is far easier to debug than a section that quietly vanished.
 */
export const blockObject = z.discriminatedUnion('_type', [
  heroBlockObject,
  richtextBlockObject,
  ctaBlockObject,
])

const blockSchema: z.ZodType<Block> = blockObject

/* ── registered objects (M10) ─────────────────────────────────────────────── */

/**
 * The `_key` the server stamps on every element of an `array<object>`.
 *
 * Optional on the read side rather than required, deliberately: a document
 * written before M10, or restored from a version snapshot that predates it, has
 * items with no key. Demanding one would turn old-but-valid content into a
 * `ContentValidationError` on the customer's site, which is the one failure a
 * CMS may never cause.
 */
export const objectItemMetaObject = z.object({
  _key: z.string().optional(),
})

export const faqObject = objectItemMetaObject.extend({
  question: z.string(),
  answer: z.string(),
})

export const galleryImageObject = objectItemMetaObject.extend({
  image: imageRefSchema,
  alt: z.string(),
  caption: z.string().optional(),
})

const faqSchema: z.ZodType<FaqObject> = faqObject
const galleryImageSchema: z.ZodType<GalleryImageObject> = galleryImageObject

/* ── the four content types ───────────────────────────────────────────────── */

export const pageFieldsObject = z.object({
  title: z.string(),
  slug: z.string(),
  sections: z.array(blockSchema).optional(),
  faq: z.array(faqSchema).optional(),
  gallery: z.array(galleryImageSchema).optional(),
  seo: seoSchema.optional(),
  custom: customObject.optional(),
})

export const postFieldsObject = z.object({
  title: z.string(),
  slug: z.string(),
  excerpt: z.string().optional(),
  body: richTextSchema.optional(),
  cover: imageRefSchema.optional(),
  publishedAt: z.string().optional(),
  tags: z.array(z.string()).optional(),
  seo: seoSchema.optional(),
  custom: customObject.optional(),
})

export const productFieldsObject = z.object({
  title: z.string(),
  slug: z.string(),
  description: richTextSchema.optional(),
  price: z.number().optional(),
  currency: z.enum(['ILS', 'USD']).optional(),
  images: z.array(imageRefSchema).optional(),
  inStock: z.boolean().optional(),
  seo: seoSchema.optional(),
  custom: customObject.optional(),
})

export const collectionFieldsObject = z.object({
  title: z.string(),
  slug: z.string(),
  items: z.array(referenceSchema).optional(),
  description: z.string().optional(),
  custom: customObject.optional(),
})

/** The per-type field schemas, keyed the same way the API keys its types. */
export const FIELD_SCHEMAS = {
  page: pageFieldsObject,
  post: postFieldsObject,
  product: productFieldsObject,
  collection: collectionFieldsObject,
} as const

const pageFieldsSchema: z.ZodType<PageFields> = pageFieldsObject
const postFieldsSchema: z.ZodType<PostFields> = postFieldsObject
const productFieldsSchema: z.ZodType<ProductFields> = productFieldsObject
const collectionFieldsSchema: z.ZodType<CollectionFields> = collectionFieldsObject

/* ── the wire envelope (§9) ───────────────────────────────────────────────── */

/** One row of `documents`, exactly as the Content API serialises it. */
export const wireDocumentSchema = z.object({
  id: z.string(),
  type: z.string(),
  slug: z.string(),
  status: documentStatusSchema,
  locale: z.string(),
  data: z.unknown(),
  updated_at: z.string(),
})

export type WireDocument = z.infer<typeof wireDocumentSchema>

export const wireListSchema = z.object({
  type: z.string(),
  documents: z.array(wireDocumentSchema),
  pagination: z.object({
    limit: z.number(),
    offset: z.number(),
    total: z.number(),
  }),
})

/**
 * The API wraps a single document in `{ document: … }`. The bare form is
 * accepted too so that a future unwrapped response — or a hand-rolled fixture —
 * still parses; the union costs nothing and removes a class of breakage.
 */
export const wireSingleSchema = z.union([
  z.object({ document: wireDocumentSchema }),
  wireDocumentSchema,
])

export type WireSingle = z.infer<typeof wireSingleSchema>

export const wireAllSchema = z.object({
  project_id: z.string(),
  content_version: z.number(),
  types: z.array(z.string()),
  documents: z.record(z.string(), z.array(wireDocumentSchema)),
  total: z.number(),
  truncated: z.boolean(),
})

/** §9's failure envelope, parsed leniently: any code, present or not. */
export const wireErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})

/* ── assembling a document ────────────────────────────────────────────────── */

/**
 * The field schema for a type key, with the metadata columns folded in under
 * their underscore-prefixed names. Built per type key rather than generically so
 * that `_type` is the literal, not the whole union.
 */
export type FieldSchemas = { readonly [K in ContentTypeKey]: z.ZodType<FieldsOf[K]> }

export const documentSchemas: FieldSchemas = {
  page: pageFieldsSchema,
  post: postFieldsSchema,
  product: productFieldsSchema,
  collection: collectionFieldsSchema,
}

export type FieldsOf = {
  readonly page: PageFields
  readonly post: PostFields
  readonly product: ProductFields
  readonly collection: CollectionFields
}

export type DocumentOf = {
  readonly page: Page
  readonly post: Post
  readonly product: Product
  readonly collection: Collection
}

/**
 * What `assembleDocument` produces for one type key.
 *
 * Structurally identical to `DocumentOf[K]` — `Page` is declared as exactly
 * `PageFields` plus `DocumentMeta<'page'>` — but expressed as an intersection
 * so the compiler can verify the merge below with no cast. Indexing `DocumentOf`
 * by a type parameter would collapse to `never`, because the four `_type`
 * literals conflict.
 */
export type AssembledDocument<K extends ContentTypeKey> = FieldsOf[K] & DocumentMeta<K>

/**
 * Merges the validated field values with the envelope metadata.
 *
 * The metadata is spread last so a content field named `_id` could never
 * shadow the real one — the underscore names are reserved, not merely
 * conventional.
 */
export function assembleDocument<K extends ContentTypeKey>(
  typeKey: K,
  fields: FieldsOf[K],
  wire: WireDocument,
): AssembledDocument<K> {
  return {
    ...fields,
    _id: wire.id,
    _type: typeKey,
    _status: wire.status,
    _locale: wire.locale,
    _updatedAt: wire.updated_at,
  }
}

/* ── expanded references (M13, normalised in M14) ─────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Flattens the `_doc` the API attaches, into the shape every other document
 * this SDK returns already has.
 *
 * WHY THE SDK DOES THIS AND THE API DOES NOT
 * -------------------------------------------
 * The API's job is to serialise rows, and a row is an envelope with a `data`
 * column — `{ id, slug, data: {...} }`. The SDK's job is to hand the customer
 * something pleasant to read, which is why `getPage()` has always returned
 * `{ title, ...,  _id, _type }` rather than the envelope. Expand was the first
 * place a document arrived somewhere OTHER than the top level, and it kept the
 * envelope: `home.title` beside `home.featured[0]._doc.data.title`, for two
 * things that are the same kind of thing.
 *
 * WHY THE WALK IS SHALLOW
 * -----------------------
 * `expand` only ever attaches `_doc` to a TOP-LEVEL field, or to the elements of
 * one — that is the whole of its contract, and the API refuses to go deeper.
 * Walking the entire document would cost every read something in order to find
 * places `_doc` cannot be.
 */
export function normaliseExpanded(data: unknown): unknown {
  if (!isRecord(data)) return data

  const flatten = (value: unknown): unknown => {
    if (!isRecord(value) || value['_type'] !== 'reference') return value
    const doc = value['_doc']
    if (!isRecord(doc)) return value

    const fields = isRecord(doc['data']) ? doc['data'] : {}
    return {
      ...value,
      _doc: {
        ...fields,
        _id: doc['id'],
        _type: doc['type'],
        _status: doc['status'],
        _locale: doc['locale'],
        _updatedAt: doc['updated_at'],
      },
    }
  }

  let touched = false
  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      const mapped = value.map(flatten)
      // Reference identity is the cheapest way to know whether anything changed,
      // and returning the original object when nothing did keeps this off the
      // hot path for every read that did not expand.
      if (mapped.some((entry, index) => entry !== value[index])) touched = true
      out[key] = mapped
      continue
    }
    const mapped = flatten(value)
    if (mapped !== value) touched = true
    out[key] = mapped
  }

  return touched ? out : data
}
