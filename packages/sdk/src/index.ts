import { cacheTag, projectCacheTag } from '@product'

import type { ClientConfig, EnvSource } from './config'
import { readClientConfig } from './config'
import type { ClientOptions, ContentClient } from './client'
import { createClient, previewClient } from './client'
import type {
  BuildPayload,
  Collection,
  DocumentOptions,
  ListOptions,
  Page,
  Post,
  Product,
} from './types'

/**
 * PRD §10 — the public surface.
 *
 *   import { getPage, getPosts } from '<the SDK package>'
 *
 *   const home  = await getPage('home')
 *   const posts = await getPosts({ limit: 10, tag: 'ai' })
 *
 * SERVER ONLY. Everything here reads an API key from the environment; calling
 * it from a `'use client'` module throws rather than shipping that key to a
 * browser. The write key is never read by this package at all.
 */

/* ── the default client ───────────────────────────────────────────────────── */

let defaultClient: ContentClient | undefined

/**
 * Created on first use, not at import, so that importing this package in an
 * environment with no configuration is harmless — and so a build script may
 * still call `configure` before the first read.
 */
function client(): ContentClient {
  defaultClient ??= createClient()
  return defaultClient
}

/**
 * Replaces the client the top-level functions delegate to. Useful for a build
 * script that reads several projects, and for tests.
 */
export function configure(options: ClientOptions): ContentClient {
  defaultClient = createClient(options)
  return defaultClient
}

/** Drops the memoised client so the next call re-reads the environment. */
export function resetClient(): void {
  defaultClient = undefined
}

/* ── §10's functions ──────────────────────────────────────────────────────── */

export function getPage(slug: string, options?: DocumentOptions): Promise<Page | null> {
  return client().getPage(slug, options)
}

export function getPages(options?: ListOptions): Promise<readonly Page[]> {
  return client().getPages(options)
}

export function getPost(slug: string, options?: DocumentOptions): Promise<Post | null> {
  return client().getPost(slug, options)
}

export function getPosts(options?: ListOptions): Promise<readonly Post[]> {
  return client().getPosts(options)
}

export function getProduct(slug: string, options?: DocumentOptions): Promise<Product | null> {
  return client().getProduct(slug, options)
}

export function getProducts(options?: ListOptions): Promise<readonly Product[]> {
  return client().getProducts(options)
}

export function getCollection(
  slug: string,
  options?: DocumentOptions,
): Promise<Collection | null> {
  return client().getCollection(slug, options)
}

export function getCollections(options?: ListOptions): Promise<readonly Collection[]> {
  return client().getCollections(options)
}

/** The whole project in one request — what a static build wants. */
export function getAll(): Promise<BuildPayload> {
  return client().getAll()
}

/* ── clients ──────────────────────────────────────────────────────────────── */

export { createClient, previewClient }
export type { ClientOptions, ContentClient }

/* ── configuration ────────────────────────────────────────────────────────── */

export { readClientConfig }
export type { ClientConfig, EnvSource }

/* ── cache tags, so a caller can build its own `revalidateTag` calls ──────── */

export { cacheTag, projectCacheTag }

/* ── type generation (the CLI's `types` command) ──────────────────────────── */

export { DEFAULT_TYPEGEN_INPUT, generateTypes } from './typegen'
export type { TypegenInput } from './typegen'
export {
  BLOCKS,
  BLOCK_KINDS,
  BLOCK_LIST,
  CONTENT_TYPES,
  CONTENT_TYPE_KEYS,
  CONTENT_TYPE_LIST,
  FIELD_KINDS,
  isContentTypeKey,
} from './definitions'
export type {
  BlockDefinition,
  ContentTypeDefinition,
  FieldDefinition,
  FieldKind,
} from './definitions'

/* ── errors ───────────────────────────────────────────────────────────────── */

export {
  API_ERROR_CODES,
  ApiResponseError,
  ContentError,
  ContentValidationError,
  MissingConfigError,
  TransportError,
  isApiErrorCode,
  isContentError,
} from './errors'
export type { ApiErrorCode } from './errors'

/* ── content types ────────────────────────────────────────────────────────── */

export type {
  AnyDocument,
  Block,
  BlockKind,
  BuildPayload,
  Collection,
  CollectionFields,
  ContentTypeKey,
  ContentTypeMap,
  CtaBlock,
  Currency,
  CustomFields,
  DocumentMeta,
  DocumentOptions,
  DocumentStatus,
  HeroBlock,
  ImageRef,
  ListOptions,
  Page,
  PageFields,
  PortableTextBlock,
  PortableTextSpan,
  Post,
  PostFields,
  Product,
  ProductFields,
  Reference,
  RichText,
  RichtextBlock,
  SeoFields,
} from './types'
