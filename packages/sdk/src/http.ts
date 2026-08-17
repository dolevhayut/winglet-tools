import { z } from 'zod'

import { ApiResponseError, ContentValidationError, TransportError, isApiErrorCode } from './errors'
import { wireErrorSchema } from './schemas'

/**
 * The one place a network request happens, and the one place Next's cache is
 * configured.
 *
 * CACHING — why `fetch` and not `'use cache'`
 * -------------------------------------------
 * §10 specifies `unstable_cache`, which is gone, and Next 16's replacement
 * (`'use cache'` + `cacheTag`) is gated behind the `cacheComponents` flag. The
 * customer's app will not have that flag set, and requiring it would make this
 * SDK impossible to drop into an existing project. Native fetch caching needs
 * zero configuration and behaves identically on Next 15 and 16:
 *
 *   fetch(url, { cache: 'force-cache', next: { tags: [...] } })
 *
 * `revalidateTag(tag)` then purges exactly those entries — which is what the
 * publish webhook and the revalidate route handler call.
 *
 * Outside a Next runtime the extra `next` key is simply ignored by the platform
 * `fetch`, so the same code path serves build scripts and tests.
 */

/**
 * `RequestInit` plus the Next-specific field, which the DOM lib does not know.
 *
 * `tags` is a MUTABLE `string[]`, and that is not an oversight. It was
 * `readonly string[]`, which compiled for as long as no file in this package
 * pulled Next's types into the program: without them `RequestInit` is the DOM
 * lib's, which has no `next` key at all, so this interface was free to declare
 * whatever it liked. `seo.ts` imports `Metadata` from `next` — a type-only
 * import — and that loads Next's own `RequestInit` augmentation, which declares
 * `tags?: string[]`. A readonly array is not assignable to a mutable one, so the
 * `extends` became an error in a file nobody had touched.
 *
 * Matching Next's declaration is the honest fix. Narrowing a member of an
 * interface you claim to extend was always a latent lie; it just had no way to
 * be caught.
 */
export interface CachedRequestInit extends RequestInit {
  readonly next?: {
    readonly tags?: string[]
    readonly revalidate?: number | false
  }
}

export type FetchImplementation = (
  input: string,
  init: CachedRequestInit,
) => Promise<Response>

export interface HttpOptions {
  readonly baseUrl: string
  readonly key: string
  readonly fetchImplementation: FetchImplementation
  /**
   * `false` (the default for a preview client) disables the cache entirely, so
   * an editor sees their draft on the very next request.
   */
  readonly cache: boolean
  /** Optional time-based ceiling on top of tag invalidation. */
  readonly revalidate?: number | false | undefined
}

export interface RequestSpec {
  /** Appended to `baseUrl`, leading slash included. */
  readonly path: string
  readonly search?: Readonly<Record<string, string | number | undefined>> | undefined
  /** Cache tags. Always at least the project tag. */
  readonly tags: readonly string[]
}

export function buildUrl(baseUrl: string, spec: RequestSpec): string {
  const url = new URL(`${baseUrl}${spec.path}`)
  for (const [name, value] of Object.entries(spec.search ?? {})) {
    if (value === undefined) continue
    url.searchParams.set(name, String(value))
  }
  return url.toString()
}

/** Path segments come from user input; a `/` or `?` in one must not re-route. */
export function encodeSegment(value: string): string {
  return encodeURIComponent(value)
}

/**
 * Built separately because `exactOptionalPropertyTypes` forbids writing
 * `revalidate: undefined` — the key has to be absent, not present-and-undefined.
 */
function nextOptions(
  tags: readonly string[],
  revalidate: number | false | undefined,
): NonNullable<CachedRequestInit['next']> {
  // Copied rather than passed through: callers hand us a readonly array, and
  // Next's own declaration wants a mutable one. A fresh array satisfies both
  // and hands out no reference the caller could still be holding.
  const mutable = [...tags]
  return revalidate === undefined ? { tags: mutable } : { tags: mutable, revalidate }
}

async function readErrorEnvelope(
  response: Response,
  url: string,
): Promise<ApiResponseError> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }

  const parsed = wireErrorSchema.safeParse(body)
  if (!parsed.success) {
    return new ApiResponseError({
      status: response.status,
      code: 'UNKNOWN',
      message: `The content API answered ${String(response.status)} without an error envelope.`,
      url,
    })
  }

  const { code, message } = parsed.data.error
  return new ApiResponseError({
    status: response.status,
    code: isApiErrorCode(code) ? code : 'UNKNOWN',
    message,
    url,
  })
}

/**
 * Performs one request and returns the parsed body.
 *
 * Throws `TransportError` when no response arrived, `ApiResponseError` for any
 * non-2xx, and `ContentValidationError` when a 200 does not match `schema`.
 */
export async function requestJson<T>(
  options: HttpOptions,
  spec: RequestSpec,
  schema: z.ZodType<T>,
): Promise<T> {
  const url = buildUrl(options.baseUrl, spec)

  const init: CachedRequestInit = {
    method: 'GET',
    headers: {
      authorization: `Bearer ${options.key}`,
      accept: 'application/json',
    },
    // `force-cache` is what makes the entry taggable in the first place; an
    // uncached request has nothing for `revalidateTag` to purge. The tags are
    // attached either way so that a preview response is still labelled.
    cache: options.cache ? 'force-cache' : 'no-store',
    next: nextOptions(spec.tags, options.revalidate),
  }

  let response: Response
  try {
    response = await options.fetchImplementation(url, init)
  } catch (error: unknown) {
    throw new TransportError(url, error)
  }

  if (!response.ok) throw await readErrorEnvelope(response, url)

  let body: unknown
  try {
    body = await response.json()
  } catch (error: unknown) {
    throw new TransportError(url, error)
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) throw toValidationError(url, parsed.error)
  return parsed.data
}

/** Flattens zod issues into the shape `ContentValidationError` reports. */
export function toValidationError(url: string, error: z.ZodError): ContentValidationError {
  return new ContentValidationError(
    url,
    error.issues.map((issue) => ({
      path: issue.path.map((segment) => String(segment)).join('.'),
      message: issue.message,
    })),
  )
}
