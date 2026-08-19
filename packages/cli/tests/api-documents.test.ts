import { describe, expect, it } from 'vitest'

import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  publishDocument,
  updateDocumentData,
} from '../src/api'
import { isCliError } from '../src/exit'

/**
 * The Management API client functions `list`/`get`/`create`/`edit`/`publish`/
 * `delete` share — exercised against a fake `fetch` so no network or database
 * is required. Each test checks the request this package sends AND the shape
 * it parses back, since a silently-wrong URL or a silently-dropped field would
 * pass a typecheck without ever failing until a real project.
 */

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const { status, body } = handler(url, init ?? {})
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

const BASE = 'https://api.example.co.il/v1'
const WRITE_KEY = 'write-key-test'

const RAW_DOCUMENT = {
  id: 'doc-1',
  type_key: 'post',
  slug: 'hello',
  status: 'draft',
  locale: 'he',
  data: { title: 'שלום' },
  published_data: null,
  updated_at: '2026-08-01T00:00:00.000Z',
}

describe('listDocuments', () => {
  it('sends the write key and an optional type filter', async () => {
    let seenUrl = ''
    let seenAuth: string | undefined
    const fetchImpl = fakeFetch((url, init) => {
      seenUrl = url
      seenAuth = (init.headers as Record<string, string> | undefined)?.['authorization']
      return { status: 200, body: { documents: [RAW_DOCUMENT] } }
    })

    const result = await listDocuments({ baseUrl: BASE, writeKey: WRITE_KEY, fetchImpl }, 'post')

    expect(seenUrl).toBe(`${BASE}/documents?type=post`)
    expect(seenAuth).toBe(`Bearer ${WRITE_KEY}`)
    expect(result).toEqual([{ id: 'doc-1', type: 'post', slug: 'hello', status: 'draft' }])
  })

  it('omits the query string when no type is given', async () => {
    let seenUrl = ''
    const fetchImpl = fakeFetch((url) => {
      seenUrl = url
      return { status: 200, body: { documents: [] } }
    })
    await listDocuments({ baseUrl: BASE, writeKey: WRITE_KEY, fetchImpl })
    expect(seenUrl).toBe(`${BASE}/documents`)
  })
})

describe('getDocument', () => {
  it('parses the full document, including data and published_data', async () => {
    const fetchImpl = fakeFetch(() => ({ status: 200, body: { document: RAW_DOCUMENT } }))
    const doc = await getDocument({ baseUrl: BASE, writeKey: WRITE_KEY, fetchImpl }, 'doc-1')
    expect(doc).toEqual({
      id: 'doc-1',
      type: 'post',
      slug: 'hello',
      status: 'draft',
      locale: 'he',
      data: { title: 'שלום' },
      publishedData: undefined,
      updatedAt: '2026-08-01T00:00:00.000Z',
    })
  })

  it('surfaces a 404 as a CliError, not a thrown TypeError', async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'No such document.' } },
    }))
    let threw: unknown
    try {
      await getDocument({ baseUrl: BASE, writeKey: WRITE_KEY, fetchImpl }, 'missing')
    } catch (error) {
      threw = error
    }
    expect(isCliError(threw)).toBe(true)
  })
})

describe('createDocument', () => {
  it('POSTs type_key/slug/data and parses the created document', async () => {
    let sentBody: unknown
    let seenMethod = ''
    const fetchImpl = fakeFetch((_url, init) => {
      seenMethod = init.method ?? ''
      sentBody = JSON.parse(String(init.body))
      return { status: 201, body: { document: RAW_DOCUMENT } }
    })

    const doc = await createDocument(
      { baseUrl: BASE, writeKey: WRITE_KEY, fetchImpl },
      { type: 'post', slug: 'hello', data: { title: 'שלום' } },
    )

    expect(seenMethod).toBe('POST')
    expect(sentBody).toEqual({ type_key: 'post', slug: 'hello', data: { title: 'שלום' } })
    expect(doc.id).toBe('doc-1')
  })
})

describe('updateDocumentData', () => {
  it('PATCHes the whole data object to the document’s own id', async () => {
    let seenUrl = ''
    let seenMethod = ''
    let sentBody: unknown
    const fetchImpl = fakeFetch((url, init) => {
      seenUrl = url
      seenMethod = init.method ?? ''
      sentBody = JSON.parse(String(init.body))
      return { status: 200, body: { document: RAW_DOCUMENT } }
    })

    await updateDocumentData({ baseUrl: BASE, writeKey: WRITE_KEY, fetchImpl }, 'doc-1', {
      title: 'שלום',
      price: 42,
    })

    expect(seenUrl).toBe(`${BASE}/documents/doc-1`)
    expect(seenMethod).toBe('PATCH')
    expect(sentBody).toEqual({ data: { title: 'שלום', price: 42 } })
  })
})

describe('publishDocument', () => {
  it('POSTs to the publish endpoint and parses the result', async () => {
    let seenUrl = ''
    const fetchImpl = fakeFetch((url) => {
      seenUrl = url
      return { status: 200, body: { published: true, document_id: 'doc-1', content_version: 7 } }
    })
    const result = await publishDocument({ baseUrl: BASE, writeKey: WRITE_KEY, fetchImpl }, 'doc-1')
    expect(seenUrl).toBe(`${BASE}/documents/doc-1/publish`)
    expect(result).toEqual({ documentId: 'doc-1', contentVersion: 7 })
  })
})

describe('deleteDocument', () => {
  it('sends DELETE and parses the result', async () => {
    let seenMethod = ''
    const fetchImpl = fakeFetch((_url, init) => {
      seenMethod = init.method ?? ''
      return { status: 200, body: { deleted: true, content_version: 8 } }
    })
    const result = await deleteDocument({ baseUrl: BASE, writeKey: WRITE_KEY, fetchImpl }, 'doc-1')
    expect(seenMethod).toBe('DELETE')
    expect(result).toEqual({ deleted: true, contentVersion: 8 })
  })
})
