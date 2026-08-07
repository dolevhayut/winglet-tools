import { createHash, timingSafeEqual } from 'node:crypto'

import { PRODUCT_SLUG, cacheTag, projectCacheTag } from '@product'
import { z } from 'zod'

import type { EnvSource } from './config'
import { readClientConfig, requireRevalidateSecret } from './config'
import { isContentTypeKey } from './definitions'

/**
 * PRD §11 — the route handler the CLI mounts in the customer's app, and the
 * publish webhook calls.
 *
 * WHY THIS IS A SEPARATE ENTRY POINT
 * ----------------------------------
 * `revalidateTag` only exists inside a Next runtime. Importing it from the
 * package's main entry would make the SDK unimportable in a plain Node test or
 * a build script. It lives behind the `./revalidate` subpath instead, and even
 * there the import is dynamic and happens on the first successful request — so
 * this module can be imported, and its rejection paths tested, with no Next at
 * all.
 */

/** The header the webhook signs with. Derived, so a rename carries it along. */
export const SECRET_HEADER = `x-${PRODUCT_SLUG}-secret`

const bodySchema = z.object({
  /** Which content types changed. Omitted means "the whole project". */
  typeKeys: z.array(z.string()).optional(),
  /** Explicit tags, accepted only inside this project's namespace. */
  tags: z.array(z.string()).optional(),
})

export type RevalidateBody = z.infer<typeof bodySchema>

export type TagRevalidator = (tag: string) => void | Promise<void>

/**
 * The `cacheLife` profile passed as `revalidateTag`'s second argument.
 *
 * NEXT 15 vs NEXT 16 — verified against the installed Next 16.3 declaration
 * (`revalidateTag(tag: string, profile: string | { expire?: number })`) and its
 * docs. Next 15 takes one argument; the extra one is simply ignored there, so
 * always passing two is compatible with the whole `>=15` peer range.
 *
 * The default is `{ expire: 0 }`, not the docs' recommended `'max'`. `'max'` is
 * stale-while-revalidate: the first visitor after a publish still sees the old
 * page. For a CMS that promises the change is live within the minute, expiring
 * the entry outright — the same thing Next 15's single-argument form does — is
 * the honest behaviour. Pass `'max'` explicitly to trade freshness for latency.
 */
export type RevalidationProfile = string | { readonly expire?: number }

export const DEFAULT_REVALIDATION_PROFILE: RevalidationProfile = { expire: 0 }

export interface RevalidateRouteOptions {
  /** Overrides the secret from the environment. */
  readonly secret?: string | undefined
  /** Overrides the project id from the environment. */
  readonly projectId?: string | undefined
  readonly env?: EnvSource | undefined
  /**
   * Injected for tests. Defaults to a lazily imported `revalidateTag`, so
   * nothing in this module reaches for a Next runtime until it has to.
   */
  readonly revalidateTag?: TagRevalidator | undefined
  /** `cacheLife` profile for the purge. See `RevalidationProfile`. */
  readonly profile?: RevalidationProfile | undefined
}

export interface RevalidateRoute {
  readonly POST: (request: Request) => Promise<Response>
}

/* ── secret comparison ────────────────────────────────────────────────────── */

/**
 * Constant time, and length-safe: both sides are hashed to a fixed 32 bytes
 * first, so `timingSafeEqual` never throws on a length mismatch and the
 * comparison cannot leak the secret's length either.
 */
export function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/** `x-…-secret`, or an `Authorization: Bearer …` for callers that prefer it. */
export function presentedSecret(request: Request): string | undefined {
  const header = request.headers.get(SECRET_HEADER)
  if (header !== null && header.trim().length > 0) return header.trim()

  const authorization = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  const bearer = match?.[1]?.trim() ?? ''
  return bearer.length > 0 ? bearer : undefined
}

/* ── responses (§9's envelope, so a caller parses one shape everywhere) ───── */

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function unauthorized(): Response {
  // Deliberately identical for "no secret" and "wrong secret": a distinct
  // message would confirm to an attacker that a header name was right.
  return json(401, {
    error: { code: 'INVALID_KEY', message: 'Missing or invalid revalidation secret.' },
  })
}

/* ── the factory ──────────────────────────────────────────────────────────── */

function defaultRevalidator(profile: RevalidationProfile): TagRevalidator {
  return async (tag: string): Promise<void> => {
    // Dynamic on purpose: this module must stay importable — and its 401 path
    // testable — without a Next runtime anywhere in sight.
    const { revalidateTag } = await import('next/cache')
    revalidateTag(tag, profile)
  }
}

/**
 * Builds the handler. Mount it as the route's `POST` export:
 *
 *   export const { POST } = createRevalidateRoute()
 *
 * The secret and project id are read from the environment at request time, not
 * at module load, so a missing variable surfaces as a 401 rather than crashing
 * the customer's entire app at boot.
 */
export function createRevalidateRoute(
  options: RevalidateRouteOptions = {},
): RevalidateRoute {
  const revalidate =
    options.revalidateTag ??
    defaultRevalidator(options.profile ?? DEFAULT_REVALIDATION_PROFILE)

  async function POST(request: Request): Promise<Response> {
    const env = options.env ?? process.env

    let expected: string
    try {
      expected = options.secret ?? requireRevalidateSecret(env)
    } catch {
      // No secret configured means no caller can ever be authentic.
      return unauthorized()
    }

    const presented = presentedSecret(request)
    if (presented === undefined || !secretsMatch(presented, expected)) return unauthorized()

    let projectId: string
    try {
      projectId = options.projectId ?? readClientConfig(env).projectId
    } catch {
      return json(500, {
        error: { code: 'INTERNAL', message: 'The project id is not configured.' },
      })
    }

    const parsed = bodySchema.safeParse(await safeJson(request))
    if (!parsed.success) {
      return json(422, {
        error: { code: 'VALIDATION_FAILED', message: 'Unexpected revalidation payload.' },
      })
    }

    const tags = tagsToPurge(projectId, parsed.data)
    for (const tag of tags) await revalidate(tag)

    return json(200, { revalidated: true, tags })
  }

  return { POST }
}

/** An empty or unparseable body is "revalidate everything", not an error. */
async function safeJson(request: Request): Promise<unknown> {
  try {
    const text = await request.text()
    if (text.trim().length === 0) return {}
    return JSON.parse(text) as unknown
  } catch {
    return {}
  }
}

/**
 * The project tag is always purged: every read this SDK performs carries it, so
 * one entry here guarantees no stale page survives a publish. Per-type tags are
 * added on top so a caller that wants a narrower purge still gets one.
 *
 * Explicit tags are filtered to this project's namespace. A webhook must not be
 * able to purge unrelated caches in the customer's own application.
 */
export function tagsToPurge(projectId: string, body: RevalidateBody): readonly string[] {
  const projectTag = projectCacheTag(projectId)
  const tags = new Set<string>([projectTag])

  for (const key of body.typeKeys ?? []) {
    if (isContentTypeKey(key)) tags.add(cacheTag(projectId, key))
  }

  for (const tag of body.tags ?? []) {
    if (tag === projectTag || tag.startsWith(`${projectTag}:`)) tags.add(tag)
  }

  return [...tags]
}
