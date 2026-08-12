import { cacheTag, projectCacheTag } from '@product'

import type { ClientConfig, EnvSource } from './config'
import { assertServerRuntime, normaliseBaseUrl, readClientConfig, requirePreviewKey } from './config'
import { CONTENT_TYPE_KEYS, isContentTypeKey } from './definitions'
import { ApiResponseError } from './errors'
import type { FetchImplementation, HttpOptions, RequestSpec } from './http'
import { encodeSegment, requestJson, toValidationError } from './http'
import { queryParams } from './query'
import type { AssembledDocument, WireDocument, WireSingle } from './schemas'
import {
  assembleDocument,
  documentSchemas,
  normaliseExpanded,
  wireAllSchema,
  wireListSchema,
  wireSingleSchema,
} from './schemas'
import type {
  BuildPayload,
  Collection,
  ContentTypeKey,
  DocumentOptions,
  DynamicDocument,
  ListOptions,
  Page,
  Post,
  Product,
  ProjectFields,
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
  /**
   * One document of ANY type the project defines (M11).
   *
   * The four seeded types keep their named accessors above, which stay typed
   * without a type argument. This is the door for everything else, and since
   * M14 it needs no type argument either:
   *
   *   const room = await client.get('accommodation', slug)
   *   //    ^? DynamicDocument<AccommodationFields>
   *
   * The key resolves through `ProjectContentTypes`, which the generated types
   * file augments. That is stronger than passing the interface by hand, which is what
   * this used to require: a hand-passed argument is unrelated to the key, so
   * `get<Accommodation>('homePage', slug)` compiled and checked the home page
   * against a cabin's schema. A project with no generated types file still gets
   * the open record, exactly as before.
   *
   * Runtime validation for these is the SERVER's: it checks a document against
   * the project's own model on every write, so a shape that reached storage
   * already matched. This package cannot re-check it, because the schema is not
   * compiled in — and pretending otherwise, by validating against nothing,
   * would be worse than being honest about where the check happens.
   */
  readonly get: <K extends string, TFields = ProjectFields<K>>(
    typeKey: K,
    slug: string,
    options?: DocumentOptions,
  ) => Promise<DynamicDocument<TFields, K> | null>
  /** The list form of `get`. */
  readonly list: <K extends string, TFields = ProjectFields<K>>(
    typeKey: K,
    options?: ListOptions,
  ) => Promise<readonly DynamicDocument<TFields, K>[]>
  /** The whole project in one request — what a static build wants. */
  readonly getAll: () => Promise<BuildPayload>
  /** The tags every read from this client carries. */
  readonly tags: (typeKey?: string) => readonly string[]
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

  const parsed = documentSchemas[typeKey].safeParse(normaliseExpanded(payload))
  if (!parsed.success) throw toValidationError(`${url} (${typeKey}/${wire.slug})`, parsed.error)
  return assembleDocument(typeKey, parsed.data, wire)
}

/* ── the client ───────────────────────────────────────────────────────────── */

export function createClient(options: ClientOptions = {}): ContentClient {
  const resolved = resolve(options)
  const { projectId } = resolved.config

  const tags = (typeKey?: string): readonly string[] =>
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
      search: {
        status: statusFor(),
        locale: documentOptions.locale,
        ...queryParams(documentOptions),
      },
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
        // M13. Spread last so a shaping key can never be shadowed by one above,
        // and absent entirely when nothing was asked for — a request that uses
        // none of M13 produces the same URL, and therefore the same cache entry,
        // that it did before M13 existed.
        ...queryParams(listOptions),
      },
      tags: tags(typeKey),
    }

    const body = await requestJson(resolved.http, spec, wireListSchema)
    return body.documents.map((wire) => decode(typeKey, wire, spec.path))
  }

  /**
   * Decodes a document of a type this build has no schema for.
   *
   * `slug` is layered in from the envelope for the same reason as `decode`
   * above: it is a column, not a payload field, and only the seeded document
   * happens to carry a copy inside its data.
   */
  function decodeDynamic<TFields, K extends string = string>(
    wire: WireDocument,
  ): DynamicDocument<TFields, K> {
    const raw =
      typeof wire.data === 'object' && wire.data !== null
        ? { ...(wire.data as Record<string, unknown>), slug: wire.slug }
        : { slug: wire.slug }

    // M14 — the same flattening the seeded path gets. Without it, `_doc` would
    // arrive in the wire envelope here and flattened there, for the same field.
    const payload = normaliseExpanded(raw)

    return {
      ...(payload as TFields),
      _id: wire.id,
      // The literal comes from the CALL, the value from the wire. They agree —
      // the API answers the type it was asked for — and the cast is where that
      // agreement is asserted rather than proved.
      _type: wire.type as K,
      _status: wire.status,
      _locale: wire.locale,
      _updatedAt: wire.updated_at,
    }
  }

  async function get<K extends string, TFields = ProjectFields<K>>(
    typeKey: K,
    slug: string,
    documentOptions: DocumentOptions = {},
  ): Promise<DynamicDocument<TFields, K> | null> {
    const spec: RequestSpec = {
      path: `/content/${encodeSegment(typeKey)}/${encodeSegment(slug)}`,
      search: {
        status: statusFor(),
        locale: documentOptions.locale,
        ...queryParams(documentOptions),
      },
      tags: tags(typeKey),
    }

    let body: WireSingle
    try {
      body = await requestJson(resolved.http, spec, wireSingleSchema)
    } catch (error: unknown) {
      if (error instanceof ApiResponseError && error.code === 'PROJECT_NOT_FOUND') return null
      throw error
    }

    return decodeDynamic<TFields, K>('document' in body ? body.document : body)
  }

  async function list<K extends string, TFields = ProjectFields<K>>(
    typeKey: K,
    listOptions: ListOptions = {},
  ): Promise<readonly DynamicDocument<TFields, K>[]> {
    const spec: RequestSpec = {
      path: `/content/${encodeSegment(typeKey)}`,
      search: {
        status: statusFor(),
        limit: listOptions.limit,
        offset: listOptions.offset,
        tag: listOptions.tag,
        locale: listOptions.locale,
        // M13. Spread last so a shaping key can never be shadowed by one above,
        // and absent entirely when nothing was asked for — a request that uses
        // none of M13 produces the same URL, and therefore the same cache entry,
        // that it did before M13 existed.
        ...queryParams(listOptions),
      },
      tags: tags(typeKey),
    }

    const body = await requestJson(resolved.http, spec, wireListSchema)
    return body.documents.map((wire) => decodeDynamic<TFields, K>(wire))
  }

  async function getAll(): Promise<BuildPayload> {
    const spec: RequestSpec = {
      path: `/content/${ALL_TYPE_KEY}`,
      search: { status: statusFor() },
      // The per-type tags cannot be enumerated before the response arrives, so
      // the PROJECT tag is what makes this purgeable: a publish of any type
      // fires it, which is exactly the granularity a whole-project payload
      // deserves. The four seeded tags are kept so a build that reads `_all`
      // and a page that reads `getPage` are invalidated by the same publish.
      tags: [projectCacheTag(projectId), ...CONTENT_TYPE_KEYS.map((key) => cacheTag(projectId, key))],
    }

    const body = await requestJson(resolved.http, spec, wireAllSchema)

    const bucket = <K extends ContentTypeKey>(typeKey: K): readonly AssembledDocument<K>[] =>
      (body.documents[typeKey] ?? []).map((wire) => decode(typeKey, wire, spec.path))

    // Everything the project holds that this build has no schema for. Until M11
    // these were silently dropped, on the reasoning that the caller could not
    // switch on a string they had never seen. That reasoning cost the customer
    // most of their own site the moment they defined a type: a build payload
    // that omits `accommodation` is not a build payload.
    const dynamic: Record<string, readonly DynamicDocument[]> = {}
    for (const typeKey of body.types) {
      if (isContentTypeKey(typeKey)) continue
      dynamic[typeKey] = (body.documents[typeKey] ?? []).map((wire) => decodeDynamic(wire))
    }

    return {
      projectId: body.project_id,
      contentVersion: body.content_version,
      types: body.types,
      documents: {
        page: bucket('page'),
        post: bucket('post'),
        product: bucket('product'),
        collection: bucket('collection'),
      },
      documentsByType: dynamic,
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
    get,
    list,
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
