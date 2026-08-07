import { ENV, REVALIDATE_ROUTE, cacheTag, projectCacheTag } from '@product'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_REVALIDATION_PROFILE,
  SECRET_HEADER,
  createRevalidateRoute,
  presentedSecret,
  secretsMatch,
  tagsToPurge,
} from '../src/revalidate'

/**
 * PRD §11 — the route the CLI mounts so a publish can purge the customer's
 * cache.
 *
 * Note what this file does NOT import: `next/cache`. The handler resolves it
 * dynamically on the first authorised request, so every rejection path below is
 * testable in plain Node — which is exactly the property the separate entry
 * point exists to preserve.
 */

const PROJECT = '11111111-2222-4333-8444-555555555555'
const SECRET = 'a-shared-secret-value'

const ENVIRONMENT: Readonly<Record<string, string>> = {
  [ENV.projectId]: PROJECT,
  [ENV.readKey]: 'read-key',
  [ENV.revalidateSecret]: SECRET,
}

function collector(): { readonly tags: string[]; readonly revalidateTag: (tag: string) => void } {
  const tags: string[] = []
  return { tags, revalidateTag: (tag) => tags.push(tag) }
}

function post(headers: Record<string, string> = {}, body?: unknown): Request {
  return new Request(`https://customer.example${REVALIDATE_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function codeOf(response: Response): Promise<string> {
  const parsed: unknown = await response.json()
  const envelope = parsed as { error?: { code?: string } }
  return envelope.error?.code ?? ''
}

/* ── rejection ────────────────────────────────────────────────────────────── */

describe('an unsigned or wrongly signed request is rejected', () => {
  it('401s a request with no secret at all', async () => {
    const sink = collector()
    const route = createRevalidateRoute({ env: ENVIRONMENT, revalidateTag: sink.revalidateTag })

    const response = await route.POST(post())

    expect(response.status).toBe(401)
    expect(await codeOf(response)).toBe('INVALID_KEY')
    expect(sink.tags).toEqual([])
  })

  it('401s a request whose secret is wrong', async () => {
    const sink = collector()
    const route = createRevalidateRoute({ env: ENVIRONMENT, revalidateTag: sink.revalidateTag })

    const response = await route.POST(post({ [SECRET_HEADER]: 'not-the-secret' }))

    expect(response.status).toBe(401)
    expect(sink.tags).toEqual([])
  })

  it('401s a secret that is a prefix of the real one', async () => {
    const sink = collector()
    const route = createRevalidateRoute({ env: ENVIRONMENT, revalidateTag: sink.revalidateTag })

    const response = await route.POST(post({ [SECRET_HEADER]: SECRET.slice(0, -1) }))

    expect(response.status).toBe(401)
    expect(sink.tags).toEqual([])
  })

  it('401s when no secret is configured, rather than letting everyone in', async () => {
    const sink = collector()
    const route = createRevalidateRoute({
      env: { [ENV.projectId]: PROJECT, [ENV.readKey]: 'read-key' },
      revalidateTag: sink.revalidateTag,
    })

    const response = await route.POST(post({ [SECRET_HEADER]: 'anything' }))

    expect(response.status).toBe(401)
    expect(sink.tags).toEqual([])
  })

  it('gives the same answer for a missing and a wrong secret', async () => {
    const route = createRevalidateRoute({ env: ENVIRONMENT, revalidateTag: () => undefined })

    const missing = await route.POST(post())
    const wrong = await route.POST(post({ [SECRET_HEADER]: 'x' }))

    expect(missing.status).toBe(wrong.status)
    expect(await missing.text()).toBe(await wrong.text())
  })

  it('never lets a rejection be cached', async () => {
    const route = createRevalidateRoute({ env: ENVIRONMENT, revalidateTag: () => undefined })
    const response = await route.POST(post())
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})

/* ── acceptance ───────────────────────────────────────────────────────────── */

describe('a correctly signed request purges the cache', () => {
  it('accepts the dedicated header and purges the project tag', async () => {
    const sink = collector()
    const route = createRevalidateRoute({ env: ENVIRONMENT, revalidateTag: sink.revalidateTag })

    const response = await route.POST(post({ [SECRET_HEADER]: SECRET }))

    expect(response.status).toBe(200)
    expect(sink.tags).toEqual([projectCacheTag(PROJECT)])
  })

  it('accepts an Authorization: Bearer secret too', async () => {
    const sink = collector()
    const route = createRevalidateRoute({ env: ENVIRONMENT, revalidateTag: sink.revalidateTag })

    const response = await route.POST(post({ authorization: `Bearer ${SECRET}` }))

    expect(response.status).toBe(200)
    expect(sink.tags).toEqual([projectCacheTag(PROJECT)])
  })

  it('purges the named type tags on top of the project tag', async () => {
    const sink = collector()
    const route = createRevalidateRoute({ env: ENVIRONMENT, revalidateTag: sink.revalidateTag })

    const response = await route.POST(
      post({ [SECRET_HEADER]: SECRET }, { typeKeys: ['post', 'page'] }),
    )

    expect(response.status).toBe(200)
    expect(sink.tags).toEqual([
      projectCacheTag(PROJECT),
      cacheTag(PROJECT, 'post'),
      cacheTag(PROJECT, 'page'),
    ])
  })

  it('reports what it purged', async () => {
    const route = createRevalidateRoute({ env: ENVIRONMENT, revalidateTag: () => undefined })

    const response = await route.POST(post({ [SECRET_HEADER]: SECRET }, { typeKeys: ['product'] }))
    const body: unknown = await response.json()

    expect(body).toEqual({
      revalidated: true,
      tags: [projectCacheTag(PROJECT), cacheTag(PROJECT, 'product')],
    })
  })

  it('treats an empty body as "purge the whole project"', async () => {
    const sink = collector()
    const route = createRevalidateRoute({ env: ENVIRONMENT, revalidateTag: sink.revalidateTag })

    const response = await route.POST(
      new Request(`https://customer.example${REVALIDATE_ROUTE}`, {
        method: 'POST',
        headers: { [SECRET_HEADER]: SECRET },
      }),
    )

    expect(response.status).toBe(200)
    expect(sink.tags).toEqual([projectCacheTag(PROJECT)])
  })

  it('rejects a payload that is not shaped like a revalidation', async () => {
    const sink = collector()
    const route = createRevalidateRoute({ env: ENVIRONMENT, revalidateTag: sink.revalidateTag })

    const response = await route.POST(post({ [SECRET_HEADER]: SECRET }, { typeKeys: 'post' }))

    expect(response.status).toBe(422)
    expect(await codeOf(response)).toBe('VALIDATION_FAILED')
    expect(sink.tags).toEqual([])
  })
})

/* ── tag selection ────────────────────────────────────────────────────────── */

describe('tagsToPurge', () => {
  it('always includes the project tag, so nothing stale can survive', () => {
    expect(tagsToPurge(PROJECT, {})).toEqual([projectCacheTag(PROJECT)])
  })

  it('ignores a content type this version does not know', () => {
    expect(tagsToPurge(PROJECT, { typeKeys: ['faq', 'post'] })).toEqual([
      projectCacheTag(PROJECT),
      cacheTag(PROJECT, 'post'),
    ])
  })

  it('refuses to purge a tag outside this project namespace', () => {
    // The webhook is ours, but the route lives in the customer's app and shares
    // their cache. A compromised webhook must not be able to purge their own
    // unrelated tags, let alone another project's.
    const purged = tagsToPurge(PROJECT, {
      tags: ['user-session', projectCacheTag('other-project'), cacheTag(PROJECT, 'page')],
    })

    expect(purged).toEqual([projectCacheTag(PROJECT), cacheTag(PROJECT, 'page')])
  })

  it('deduplicates', () => {
    expect(
      tagsToPurge(PROJECT, { typeKeys: ['page', 'page'], tags: [cacheTag(PROJECT, 'page')] }),
    ).toEqual([projectCacheTag(PROJECT), cacheTag(PROJECT, 'page')])
  })
})

/* ── the primitives ───────────────────────────────────────────────────────── */

describe('secretsMatch', () => {
  it('is true only for an exact match', () => {
    expect(secretsMatch(SECRET, SECRET)).toBe(true)
    expect(secretsMatch(SECRET, `${SECRET} `)).toBe(false)
    expect(secretsMatch('', '')).toBe(true)
  })

  it('tolerates a length mismatch instead of throwing', () => {
    // `timingSafeEqual` throws on unequal buffer lengths; hashing both sides
    // first is what keeps that from becoming a 500 — and from leaking the
    // secret's length through the difference between a throw and a false.
    expect(secretsMatch('short', SECRET)).toBe(false)
    expect(secretsMatch(`${SECRET}${SECRET}${SECRET}`, SECRET)).toBe(false)
  })

  it('compares bytes, not a truncated digest', () => {
    expect(secretsMatch('a', 'b')).toBe(false)
  })
})

describe('presentedSecret', () => {
  it('prefers the dedicated header', () => {
    expect(
      presentedSecret(post({ [SECRET_HEADER]: 'from-header', authorization: 'Bearer other' })),
    ).toBe('from-header')
  })

  it('falls back to a bearer token, case-insensitively', () => {
    expect(presentedSecret(post({ authorization: 'bearer  spaced ' }))).toBe('spaced')
  })

  it('is undefined when neither is present or both are blank', () => {
    expect(presentedSecret(post())).toBeUndefined()
    expect(presentedSecret(post({ [SECRET_HEADER]: '   ' }))).toBeUndefined()
    expect(presentedSecret(post({ authorization: 'Bearer' }))).toBeUndefined()
  })
})

describe('the default revalidation profile', () => {
  it('expires the entry rather than serving it stale once more', () => {
    // Next 16 makes the second argument mandatory and recommends `'max'`, which
    // is stale-while-revalidate. A CMS that has just published must not serve
    // the old page to the next visitor, so the default expires outright.
    expect(DEFAULT_REVALIDATION_PROFILE).toEqual({ expire: 0 })
  })
})

describe('the header name', () => {
  it('is derived from the product identity', () => {
    expect(SECRET_HEADER.startsWith('x-')).toBe(true)
    expect(SECRET_HEADER.endsWith('-secret')).toBe(true)
  })
})
