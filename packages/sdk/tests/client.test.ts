import { ENV, cacheTag, projectCacheTag } from '@product'
import { describe, expect, it } from 'vitest'

import { createClient, previewClient } from '../src/client'
import type { CachedRequestInit } from '../src/http'
import {
  ApiResponseError,
  ContentValidationError,
  MissingConfigError,
  TransportError,
} from '../src/errors'

/**
 * The client's contract, exercised against a recording fetch.
 *
 * The live suite (`live.test.ts`) proves the SDK talks to the real API; this one
 * proves the things a live call cannot show — which cache tags were attached,
 * what happens when the socket dies, and that a 404 is a `null` rather than a
 * throw.
 */

const PROJECT = '11111111-2222-4333-8444-555555555555'

const ENVIRONMENT: Readonly<Record<string, string>> = {
  [ENV.apiUrl]: 'https://api.test/v1',
  [ENV.projectId]: PROJECT,
  [ENV.readKey]: 'read-key',
  [ENV.previewKey]: 'preview-key',
}

interface Call {
  readonly url: string
  readonly init: CachedRequestInit
}

interface Recorder {
  readonly calls: Call[]
  readonly fetchImplementation: (url: string, init: CachedRequestInit) => Promise<Response>
}

function recorder(respond: (url: string) => Response): Recorder {
  const calls: Call[] = []
  return {
    calls,
    fetchImplementation: (url, init) => {
      calls.push({ url, init })
      return Promise.resolve(respond(url))
    },
  }
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function failure(status: number, code: string, message = 'nope'): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const HOME = {
  id: 'doc-1',
  type: 'page',
  slug: 'home',
  status: 'published',
  locale: 'he',
  updated_at: '2026-08-07T12:00:00.000Z',
  data: {
    title: 'Home',
    slug: 'home',
    sections: [{ _type: 'hero', heading: 'Hello' }],
    seo: { title: 'Home' },
    custom: {},
  },
}

function firstCall(calls: readonly Call[]): Call {
  const call = calls[0]
  if (call === undefined) throw new Error('no request was made')
  return call
}

/* ── cache tags ───────────────────────────────────────────────────────────── */

describe('every read is tagged for revalidateTag', () => {
  it('carries the project tag and the type tag, and asks Next to cache it', async () => {
    const spy = recorder(() => ok({ document: HOME }))
    const client = createClient({ env: ENVIRONMENT, fetchImplementation: spy.fetchImplementation })

    await client.getPage('home')

    const { init } = firstCall(spy.calls)
    expect(init.next?.tags).toEqual([projectCacheTag(PROJECT), cacheTag(PROJECT, 'page')])
    expect(init.cache).toBe('force-cache')
  })

  it('tags a list read the same way', async () => {
    const spy = recorder(() =>
      ok({ type: 'post', documents: [], pagination: { limit: 20, offset: 0, total: 0 } }),
    )
    const client = createClient({ env: ENVIRONMENT, fetchImplementation: spy.fetchImplementation })

    await client.getPosts()

    expect(firstCall(spy.calls).init.next?.tags).toEqual([
      projectCacheTag(PROJECT),
      cacheTag(PROJECT, 'post'),
    ])
  })

  it('tags the build payload with every type, so one publish can purge it', async () => {
    const spy = recorder(() =>
      ok({
        project_id: PROJECT,
        content_version: 3,
        types: ['page', 'post', 'product', 'collection'],
        documents: { page: [HOME], post: [], product: [], collection: [] },
        total: 1,
        truncated: false,
      }),
    )
    const client = createClient({ env: ENVIRONMENT, fetchImplementation: spy.fetchImplementation })

    const payload = await client.getAll()

    expect(firstCall(spy.calls).init.next?.tags).toEqual([
      projectCacheTag(PROJECT),
      cacheTag(PROJECT, 'page'),
      cacheTag(PROJECT, 'post'),
      cacheTag(PROJECT, 'product'),
      cacheTag(PROJECT, 'collection'),
    ])
    expect(payload.contentVersion).toBe(3)
    expect(payload.documents.page[0]?._id).toBe('doc-1')
    expect(payload.documents.post).toEqual([])
  })

  it('exposes the tags a caller would need to purge by hand', () => {
    const spy = recorder(() => ok({}))
    const client = createClient({ env: ENVIRONMENT, fetchImplementation: spy.fetchImplementation })

    expect(client.tags()).toEqual([projectCacheTag(PROJECT)])
    expect(client.tags('product')).toEqual([
      projectCacheTag(PROJECT),
      cacheTag(PROJECT, 'product'),
    ])
  })
})

/* ── request shape ────────────────────────────────────────────────────────── */

describe('the requests it builds', () => {
  it('sends the read key as a bearer token', async () => {
    const spy = recorder(() => ok({ document: HOME }))
    const client = createClient({ env: ENVIRONMENT, fetchImplementation: spy.fetchImplementation })

    await client.getPage('home')

    const headers = firstCall(spy.calls).init.headers
    expect(headers).toMatchObject({ authorization: 'Bearer read-key' })
  })

  it('passes limit, offset, tag and locale through as query parameters', async () => {
    const spy = recorder(() =>
      ok({ type: 'post', documents: [], pagination: { limit: 10, offset: 5, total: 0 } }),
    )
    const client = createClient({ env: ENVIRONMENT, fetchImplementation: spy.fetchImplementation })

    await client.getPosts({ limit: 10, offset: 5, tag: 'ai', locale: 'he' })

    const url = new URL(firstCall(spy.calls).url)
    expect(url.pathname).toBe('/v1/content/post')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '10',
      offset: '5',
      tag: 'ai',
      locale: 'he',
    })
  })

  it('omits parameters the caller did not set, so the API applies its defaults', async () => {
    const spy = recorder(() =>
      ok({ type: 'post', documents: [], pagination: { limit: 20, offset: 0, total: 0 } }),
    )
    const client = createClient({ env: ENVIRONMENT, fetchImplementation: spy.fetchImplementation })

    await client.getPosts()

    expect(new URL(firstCall(spy.calls).url).search).toBe('')
  })

  it('escapes a slug so it cannot escape its path segment', async () => {
    const spy = recorder(() => failure(404, 'PROJECT_NOT_FOUND'))
    const client = createClient({ env: ENVIRONMENT, fetchImplementation: spy.fetchImplementation })

    await client.getPage('../../projects/anonymous')

    expect(firstCall(spy.calls).url).toContain('/v1/content/page/..%2F..%2Fprojects%2Fanonymous')
  })
})

/* ── decoding ─────────────────────────────────────────────────────────────── */

describe('the documents it returns', () => {
  it('merges the metadata into the content under reserved names', async () => {
    const spy = recorder(() => ok({ document: HOME }))
    const client = createClient({ env: ENVIRONMENT, fetchImplementation: spy.fetchImplementation })

    const page = await client.getPage('home')

    expect(page).not.toBeNull()
    expect(page?.title).toBe('Home')
    expect(page?._id).toBe('doc-1')
    expect(page?._type).toBe('page')
    expect(page?._status).toBe('published')
    expect(page?._locale).toBe('he')
    expect(page?._updatedAt).toBe('2026-08-07T12:00:00.000Z')
  })

  it('accepts a bare document as well as the wrapped form', async () => {
    const spy = recorder(() => ok(HOME))
    const client = createClient({ env: ENVIRONMENT, fetchImplementation: spy.fetchImplementation })

    expect((await client.getPage('home'))?.title).toBe('Home')
  })

  it('drops a content type the server knows and this version does not', async () => {
    const spy = recorder(() =>
      ok({
        project_id: PROJECT,
        content_version: 1,
        types: ['page', 'faq'],
        documents: { page: [], faq: [] },
        total: 0,
        truncated: false,
      }),
    )
    const client = createClient({ env: ENVIRONMENT, fetchImplementation: spy.fetchImplementation })

    expect((await client.getAll()).types).toEqual(['page'])
  })
})

/* ── failure behaviour ────────────────────────────────────────────────────── */

describe('failures', () => {
  it('returns null for a missing document instead of throwing', async () => {
    const spy = recorder(() => failure(404, 'PROJECT_NOT_FOUND'))
    const client = createClient({ env: ENVIRONMENT, fetchImplementation: spy.fetchImplementation })

    await expect(client.getPage('nope')).resolves.toBeNull()
    await expect(client.getPost('nope')).resolves.toBeNull()
    await expect(client.getProduct('nope')).resolves.toBeNull()
    await expect(client.getCollection('nope')).resolves.toBeNull()
  })

  it('throws a typed error when the key is rejected', async () => {
    const spy = recorder(() => failure(401, 'INVALID_KEY', 'Missing or invalid API key.'))
    const client = createClient({ env: ENVIRONMENT, fetchImplementation: spy.fetchImplementation })

    await expect(client.getPage('home')).rejects.toBeInstanceOf(ApiResponseError)
    await expect(client.getPage('home')).rejects.toMatchObject({
      code: 'INVALID_KEY',
      status: 401,
    })
  })

  it('does not swallow a 401 on a single-document read', async () => {
    // The `null` shortcut is for PROJECT_NOT_FOUND only. A bad key that came
    // back as `null` would render an empty site instead of failing the build.
    const spy = recorder(() => failure(401, 'INVALID_KEY'))
    const client = createClient({ env: ENVIRONMENT, fetchImplementation: spy.fetchImplementation })

    await expect(client.getPage('home')).rejects.toBeInstanceOf(ApiResponseError)
  })

  it('throws on an unknown content type in a list read', async () => {
    const spy = recorder(() => failure(404, 'PROJECT_NOT_FOUND'))
    const client = createClient({ env: ENVIRONMENT, fetchImplementation: spy.fetchImplementation })

    await expect(client.getPages()).rejects.toBeInstanceOf(ApiResponseError)
  })

  it('reports a dead network as a TransportError naming the URL', async () => {
    const client = createClient({
      env: ENVIRONMENT,
      fetchImplementation: () => Promise.reject(new Error('ECONNREFUSED')),
    })

    await expect(client.getPage('home')).rejects.toBeInstanceOf(TransportError)
    await expect(client.getPage('home')).rejects.toMatchObject({
      url: 'https://api.test/v1/content/page/home',
    })
  })

  it('reports a body that does not match §8 rather than silently dropping it', async () => {
    const spy = recorder(() =>
      ok({ document: { ...HOME, data: { title: 'Home', slug: 'home', sections: [{ _type: 'faq' }] } } }),
    )
    const client = createClient({ env: ENVIRONMENT, fetchImplementation: spy.fetchImplementation })

    await expect(client.getPage('home')).rejects.toBeInstanceOf(ContentValidationError)
  })

  it('handles a non-JSON failure body without masking the status', async () => {
    const spy = recorder(() => new Response('<html>502</html>', { status: 502 }))
    const client = createClient({ env: ENVIRONMENT, fetchImplementation: spy.fetchImplementation })

    await expect(client.getPage('home')).rejects.toMatchObject({ status: 502, code: 'UNKNOWN' })
  })

  it('fails at the first call, not at import, when nothing is configured', () => {
    expect(() => createClient({ env: {} })).toThrow(MissingConfigError)
  })
})

/* ── preview ──────────────────────────────────────────────────────────────── */

describe('the preview client', () => {
  it('uses the preview key, asks for drafts and refuses to be cached', async () => {
    const spy = recorder(() => ok({ document: { ...HOME, status: 'draft' } }))
    const client = previewClient({
      env: ENVIRONMENT,
      fetchImplementation: spy.fetchImplementation,
    })

    const page = await client.getPage('home')

    const call = firstCall(spy.calls)
    expect(call.init.headers).toMatchObject({ authorization: 'Bearer preview-key' })
    expect(new URL(call.url).searchParams.get('status')).toBe('all')
    expect(call.init.cache).toBe('no-store')
    expect(client.preview).toBe(true)
    expect(page?._status).toBe('draft')
  })

  it('asks for drafts on lists and on the build payload too', async () => {
    const spy = recorder((url) =>
      url.includes('_all')
        ? ok({
            project_id: PROJECT,
            content_version: 1,
            types: [],
            documents: {},
            total: 0,
            truncated: false,
          })
        : ok({ type: 'post', documents: [], pagination: { limit: 20, offset: 0, total: 0 } }),
    )
    const client = previewClient({
      env: ENVIRONMENT,
      fetchImplementation: spy.fetchImplementation,
    })

    await client.getPosts()
    await client.getAll()

    for (const call of spy.calls) {
      expect(new URL(call.url).searchParams.get('status')).toBe('all')
    }
  })

  it('names the variable to set when no preview key is configured', () => {
    const withoutPreview: Record<string, string | undefined> = { ...ENVIRONMENT }
    delete withoutPreview[ENV.previewKey]

    expect(() => previewClient({ env: withoutPreview })).toThrow(ENV.previewKey)
  })

  it('never sends the read key when previewing', async () => {
    const spy = recorder(() => ok({ document: HOME }))
    const client = previewClient({
      env: ENVIRONMENT,
      fetchImplementation: spy.fetchImplementation,
    })

    await client.getPage('home')

    expect(JSON.stringify(firstCall(spy.calls).init.headers)).not.toContain('read-key')
  })
})
