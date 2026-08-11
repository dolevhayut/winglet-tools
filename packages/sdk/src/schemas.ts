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
})

const imageRefSchema: z.ZodType<ImageRef> = imageRefObject

export const referenceObject = z.object({
  _type: z.literal('reference').default('reference'),
  _ref: z.string(),
  type: contentTypeKeySchema.optional(),
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
})

export const portableTextBlockObject = z.object({
  _type: z.literal('block'),
  style: z.string().optional(),
  children: z.array(portableTextSpanObject),
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
