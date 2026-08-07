import { cacheTag, projectCacheTag } from '@product'

import type { ClientConfig, EnvSource } from './config'
import { assertServerRuntime, normaliseBaseUrl, readClientConfig, requirePreviewKey } from './config'
import { CONTENT_TYPE_KEYS, isContentTypeKey } from './definitions'
import { ApiResponseError } from './errors'
import type { FetchImplementation, HttpOptions, RequestSpec } from './http'
import { encodeSegment, requestJson, toValidationError } from './http'
import type { AssembledDocument, WireDocument, WireSingle } from './schemas'
import {
  assembleDocument,
  documentSchemas,
  wireAllSchema,
  wireListSchema,
  wireSingleSchema,
} from './schemas'
import type {
  BuildPayload,
  Collection,
  ContentTypeKey,
  DocumentOptions,
  ListOptions,
  Page,
  Post,
  Product,
} from './types'

/**
 * PRD §10 — the content client.
 *
 * Every read is a `GET` against §9's Content API, tagged for `revalidateTag`
 * with both the project tag and the per-type tag, so a publish can invalidate
 * one content type or the whole site.
 */

export interface ClientOptions {
  /**
   * Where the environment is read from. Defaults to `process.env`; a test or a
   * multi-tenant build script can pass its own map instead.
   */
  readonly env?: EnvSource | undefined
  /** Overrides the URL from the environment. */
  readonly apiBaseUrl?: string | undefined
  /** Overrides the project id from the environment. */
  readonly projectId?: string | undefined
  /** Overrides the key from the environment. Must match `preview`. */
  readonly key?: string | undefined
  /** `true` reads drafts with the preview key and bypasses the cache. */
  readonly preview?: boolean | undefined
  /** Injected for tests; defaults to the platform `fetch`. */
  readonly fetchImplementation?: FetchImplementation | undefined
  /** Time-based revalidation on top of tags. Omit for tag-only invalidation. */
  readonly revalidate?: number | false | undefined
}

export interface ContentClient {
  readonly getPage: (slug: string, options?: DocumentOptions) => Promise<Page | null>
  readonly getPages: (options?: ListOptions) => Promise<readonly Page[]>
  readonly getPost: (slug: string, options?: DocumentOptions) => Promise<Post | null>
  readonly getPosts: (options?: ListOptions) => Promise<readonly Post[]>
  readonly getProduct: (slug: string, options?: DocumentOptions) => Promise<Product | null>
  readonly getProducts: (options?: ListOptions) => Promise<readonly Product[]>
  readonly getCollection: (
    slug: string,
    options?: DocumentOptions,
  ) => Promise<Collection | null>
  readonly getCollections: (options?: ListOptions) => Promise<readonly Collection[]>
  /** The whole project in one request — what a static build wants. */
  readonly getAll: () => Promise<BuildPayload>
  /** The tags every read from this client carries. */
  readonly tags: (typeKey?: ContentTypeKey) => readonly string[]
  readonly projectId: string
  readonly preview: boolean
}

const ALL_TYPE_KEY = '_all'

/**
 * A preview client asks for `status=all`, which returns every document rendered
 * from its working copy: a draft shows its unpublished edits, and a published
 * document with no pending edit shows what is live. That is exactly what an
 * editor previewing the site expects to see.
 */
const PREVIEW_STATUS = 'all'

/* ── configuration ────────────────────────────────────────────────────────── */

interface Resolved {
  readonly config: ClientConfig
  readonly key: string
  readonly preview: boolean
  readonly http: HttpOptions
}

function defaultFetch(): FetchImplementation {
  return (input, init) => fetch(input, init)
}

function resolve(options: ClientOptions): Resolved {
  assertServerRuntime()

  const preview = options.preview === true
  const fromEnv = readClientConfig(options.env ?? process.env)

  const config: ClientConfig = {
    apiBaseUrl: normaliseBaseUrl(options.apiBaseUrl ?? fromEnv.apiBaseUrl),
    projectId: options.projectId ?? fromEnv.projectId,
    readKey: fromEnv.readKey,
    previewKey: fromEnv.previewKey,
    revalidateSecret: fromEnv.revalidateSecret,
  }

  const key =
    options.key ?? (preview ? requirePreviewKey(config) : config.readKey)

  return {
    config,
    key,
    preview,
    http: {
      baseUrl: config.apiBaseUrl,
      key,
      fetchImplementation: options.fetchImplementation ?? defaultFetch(),
      // A preview must never be served from a cache built for the public site.
      cache: !preview,
      revalidate: options.revalidate,
    },
  }
}

/* ── document decoding ────────────────────────────────────────────────────── */

function decode<K extends ContentTypeKey>(
  typeKey: K,
  wire: WireDocument,
  url: string,
): AssembledDocument<K> {
  // `slug` is a COLUMN on the document, not a field inside its payload — the
  // API returns it in the envelope. Validating `wire.data` alone therefore
  // rejected every document created through the Management API, because only
  // the seeded one happens to carry a copy inside its payload. The envelope is
  // authoritative and is layered in before validation; a stale copy in the
  // payload loses.
  const payload =
    typeof wire.data === 'object' && wire.data !== null
      ? { ...(wire.data as Record<string, unknown>), slug: wire.slug }
      : { slug: wire.slug }

  const parsed = documentSchemas[typeKey].safeParse(payload)
  if (!parsed.success) throw toValidationError(`${url} (${typeKey}/${wire.slug})`, parsed.error)
  return assembleDocument(typeKey, parsed.data, wire)
}

/* ── the client ───────────────────────────────────────────────────────────── */

export function createClient(options: ClientOptions = {}): ContentClient {
  const resolved = resolve(options)
  const { projectId } = resolved.config

  const tags = (typeKey?: ContentTypeKey): readonly string[] =>
    typeKey === undefined
      ? [projectCacheTag(projectId)]
      : [projectCacheTag(projectId), cacheTag(projectId, typeKey)]

  const statusFor = (): string | undefined =>
    resolved.preview ? PREVIEW_STATUS : undefined

  async function getDocument<K extends ContentTypeKey>(
    typeKey: K,
    slug: string,
    documentOptions: DocumentOptions = {},
  ): Promise<AssembledDocument<K> | null> {
    const spec: RequestSpec = {
      path: `/content/${encodeSegment(typeKey)}/${encodeSegment(slug)}`,
      search: { status: statusFor(), locale: documentOptions.locale },
      tags: tags(typeKey),
    }

    let body: WireSingle
    try {
      body = await requestJson(resolved.http, spec, wireSingleSchema)
    } catch (error: unknown) {
      // The API says PROJECT_NOT_FOUND for a slug that does not exist in the
      // caller's project — indistinguishable, by design, from one that belongs
      // to another tenant. Either way it is "no such document" for this key, and
      // a page that renders `notFound()` should not need a try/catch.
      if (error instanceof ApiResponseError && error.code === 'PROJECT_NOT_FOUND') return null
      throw error
    }

    const wire: WireDocument = 'document' in body ? body.document : body
    return decode(typeKey, wire, spec.path)
  }

  async function getList<K extends ContentTypeKey>(
    typeKey: K,
    listOptions: ListOptions = {},
  ): Promise<readonly AssembledDocument<K>[]> {
    const spec: RequestSpec = {
      path: `/content/${encodeSegment(typeKey)}`,
      search: {
        status: statusFor(),
        limit: listOptions.limit,
        offset: listOptions.offset,
        tag: listOptions.tag,
        locale: listOptions.locale,
      },
      tags: tags(typeKey),
    }

    const body = await requestJson(resolved.http, spec, wireListSchema)
    return body.documents.map((wire) => decode(typeKey, wire, spec.path))
  }

  async function getAll(): Promise<BuildPayload> {
    const spec: RequestSpec = {
      path: `/content/${ALL_TYPE_KEY}`,
      search: { status: statusFor() },
      tags: [projectCacheTag(projectId), ...CONTENT_TYPE_KEYS.map((key) => cacheTag(projectId, key))],
    }

    const body = await requestJson(resolved.http, spec, wireAllSchema)

    const bucket = <K extends ContentTypeKey>(typeKey: K): readonly AssembledDocument<K>[] =>
      (body.documents[typeKey] ?? []).map((wire) => decode(typeKey, wire, spec.path))

    return {
      projectId: body.project_id,
      contentVersion: body.content_version,
      // A type the server knows but this SDK version does not is dropped rather
      // than widening the union with a string the caller cannot switch on.
      types: body.types.filter(isContentTypeKey),
      documents: {
        page: bucket('page'),
        post: bucket('post'),
        product: bucket('product'),
        collection: bucket('collection'),
      },
      total: body.total,
      truncated: body.truncated,
    }
  }

  return {
    getPage: (slug, documentOptions) => getDocument('page', slug, documentOptions),
    getPages: (listOptions) => getList('page', listOptions),
    getPost: (slug, documentOptions) => getDocument('post', slug, documentOptions),
    getPosts: (listOptions) => getList('post', listOptions),
    getProduct: (slug, documentOptions) => getDocument('product', slug, documentOptions),
    getProducts: (listOptions) => getList('product', listOptions),
    getCollection: (slug, documentOptions) => getDocument('collection', slug, documentOptions),
    getCollections: (listOptions) => getList('collection', listOptions),
    getAll,
    tags,
    projectId,
    preview: resolved.preview,
  }
}

/**
 * The same surface, reading drafts with the preview key. Uncached, so an edit
 * saved a second ago is visible on the next request.
 */
export function previewClient(options: ClientOptions = {}): ContentClient {
  return createClient({ ...options, preview: true })
}
