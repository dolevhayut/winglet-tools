/**
 * PRD §8 — the public type surface of the content client.
 *
 * These interfaces are the hand-written twin of what `typegen.ts` emits into the
 * customer's generated types file. `tests/typegen.test.ts` proves the two cannot
 * drift: every field here exists there, with the same optionality.
 *
 * WHY OPTIONAL FIELDS ARE WRITTEN `?: T | undefined`
 * --------------------------------------------------
 * This repo compiles with `exactOptionalPropertyTypes`, under which `?: T` means
 * "absent, never explicitly undefined". A zod schema's `.optional()` produces
 * `T | undefined`, so a schema could not be typed as producing these values
 * unless the union is spelled out. Consumers compiling without that flag see no
 * difference at all; the generated file for the customer's own app uses the
 * plain `?: T` form.
 */

/* ── vocabulary ───────────────────────────────────────────────────────────── */

export type ContentTypeKey = 'page' | 'post' | 'product' | 'collection'

export type DocumentStatus = 'draft' | 'published'

/** §8's `currency: select('ILS'|'USD')`. */
export type Currency = 'ILS' | 'USD'

/** Locked decision T9 — three block types in Phase 1, not §8's eight. */
export type BlockKind = 'hero' | 'richtext' | 'cta'

/* ── document metadata ────────────────────────────────────────────────────── */

/**
 * What the API knows about a document that is not part of its content. Merged
 * onto the returned object under underscore-prefixed names so that the content
 * fields stay flat and ergonomic (`post.title`, not `post.data.title`) while
 * still being impossible to collide with.
 */
export interface DocumentMeta<TType extends ContentTypeKey = ContentTypeKey> {
  readonly _id: string
  readonly _type: TType
  readonly _status: DocumentStatus
  readonly _locale: string
  /** ISO-8601, UTC. */
  readonly _updatedAt: string
}

/* ── field value shapes ───────────────────────────────────────────────────── */

/** An `image` field: a reference to an asset, resolved by the API. */
export interface ImageRef {
  readonly assetId?: string | undefined
  readonly url?: string | undefined
  readonly alt?: string | undefined
  readonly width?: number | undefined
  readonly height?: number | undefined
}

/** A `reference` field: a pointer to another document in the same project. */
export interface Reference {
  readonly _type: 'reference'
  readonly _ref: string
  readonly type?: ContentTypeKey | undefined
}

/** The structured `seo` object every content type but `collection` carries. */
export interface SeoFields {
  readonly title?: string | undefined
  readonly description?: string | undefined
  readonly image?: ImageRef | undefined
}

/** §8's "custom: jsonb" escape hatch. */
export type CustomFields = Readonly<Record<string, unknown>>

/* ── richtext (portable-text-like) ────────────────────────────────────────── */

export interface PortableTextSpan {
  readonly _type: 'span'
  readonly text: string
  readonly marks?: readonly string[] | undefined
}

export interface PortableTextBlock {
  readonly _type: 'block'
  readonly style?: string | undefined
  readonly children: readonly PortableTextSpan[]
}

/** The value of any `richtext` field. */
export type RichText = readonly PortableTextBlock[]

/* ── blocks (`page.sections`) ─────────────────────────────────────────────── */

export interface HeroBlock {
  readonly _type: 'hero'
  readonly heading: string
  readonly subheading?: string | undefined
  readonly ctaLabel?: string | undefined
  readonly ctaHref?: string | undefined
  readonly image?: ImageRef | undefined
}

export interface RichtextBlock {
  readonly _type: 'richtext'
  readonly body: RichText
}

export interface CtaBlock {
  readonly _type: 'cta'
  readonly heading: string
  readonly body?: string | undefined
  readonly buttonLabel?: string | undefined
  readonly buttonHref?: string | undefined
}

/** Discriminated on `_type`, closed on purpose (see `definitions.ts`). */
export type Block = HeroBlock | RichtextBlock | CtaBlock

/* ── the four content types (§8) ──────────────────────────────────────────── */

export interface PageFields {
  readonly title: string
  readonly slug: string
  readonly sections?: readonly Block[] | undefined
  readonly seo?: SeoFields | undefined
  readonly custom?: CustomFields | undefined
}

export interface PostFields {
  readonly title: string
  readonly slug: string
  readonly excerpt?: string | undefined
  readonly body?: RichText | undefined
  readonly cover?: ImageRef | undefined
  /** ISO-8601 date. */
  readonly publishedAt?: string | undefined
  readonly tags?: readonly string[] | undefined
  readonly seo?: SeoFields | undefined
  readonly custom?: CustomFields | undefined
}

export interface ProductFields {
  readonly title: string
  readonly slug: string
  readonly description?: RichText | undefined
  readonly price?: number | undefined
  readonly currency?: Currency | undefined
  readonly images?: readonly ImageRef[] | undefined
  readonly inStock?: boolean | undefined
  readonly seo?: SeoFields | undefined
  readonly custom?: CustomFields | undefined
}

export interface CollectionFields {
  readonly title: string
  readonly slug: string
  readonly items?: readonly Reference[] | undefined
  readonly description?: string | undefined
  readonly custom?: CustomFields | undefined
}

export interface Page extends PageFields, DocumentMeta<'page'> {}
export interface Post extends PostFields, DocumentMeta<'post'> {}
export interface Product extends ProductFields, DocumentMeta<'product'> {}
export interface Collection extends CollectionFields, DocumentMeta<'collection'> {}

/** Maps a type key to the document interface it produces. */
export interface ContentTypeMap {
  readonly page: Page
  readonly post: Post
  readonly product: Product
  readonly collection: Collection
}

export type AnyDocument = ContentTypeMap[ContentTypeKey]

/* ── query options (§9's list parameters) ─────────────────────────────────── */

export interface ListOptions {
  /** 1–100. The API defaults to 20. */
  readonly limit?: number | undefined
  readonly offset?: number | undefined
  /** Matches a value inside the document's `tags` array. */
  readonly tag?: string | undefined
  /** BCP-47 language tag. Omit to accept any locale. */
  readonly locale?: string | undefined
}

/** A single-document read takes the locale but nothing paginated. */
export interface DocumentOptions {
  readonly locale?: string | undefined
}

/* ── the build payload (`GET /content/_all`) ──────────────────────────────── */

export interface BuildPayload {
  readonly projectId: string
  /** Monotonic per project; changes on every publish. Useful as a build key. */
  readonly contentVersion: number
  readonly types: readonly ContentTypeKey[]
  readonly documents: {
    readonly page: readonly Page[]
    readonly post: readonly Post[]
    readonly product: readonly Product[]
    readonly collection: readonly Collection[]
  }
  readonly total: number
  /** True when the project holds more documents than one payload carries. */
  readonly truncated: boolean
}
