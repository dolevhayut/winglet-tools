import { describe, expect, it } from 'vitest'

import {
  createProjectObject,
  deleteProjectObject,
  fetchProjectModel,
  listProjectObjects,
  updateProjectObject,
} from '../src/api'
import { isCliError } from '../src/exit'

/**
 * The content-model client (M10), against a fake `fetch`.
 *
 * What is checked is the same pair as `api-documents.test.ts`: the request this
 * package sends, and the shape it parses back. A dropped `of` or a lost
 * `repeated` would typecheck perfectly and only surface as a generated types
 * file that silently disagrees with the server.
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
const READ_KEY = 'read-key-test'
const WRITE_KEY = 'write-key-test'

const FAQ = {
  key: 'faq',
  title: 'Question and answer',
  fields: [
    { name: 'question', kind: 'string', required: true },
    { name: 'answer', kind: 'text', required: true },
  ],
}

describe('fetchProjectModel', () => {
  it('reads types and objects from one call, preserving `of` and `repeated`', async () => {
    let seenUrl = ''
    let seenAuth: string | undefined
    const fetchImpl = fakeFetch((url, init) => {
      seenUrl = url
      seenAuth = (init.headers as Record<string, string> | undefined)?.['authorization']
      return {
        status: 200,
        body: {
          types: [
            {
              key: 'page',
              title: 'Page',
              titleField: 'title',
              slugField: 'slug',
              fields: [
                { name: 'title', kind: 'string', required: true },
                { name: 'faq', kind: 'object', required: false, repeated: true, of: 'faq' },
              ],
            },
          ],
          objects: [FAQ],
        },
      }
    })

    const model = await fetchProjectModel({ baseUrl: BASE, key: READ_KEY, fetchImpl })

    // The READ key: the model is not a secret, and `types` has to work in a
    // build-only checkout that was linked with `--read-key` alone.
    expect(seenUrl).toBe(`${BASE}/types`)
    expect(seenAuth).toBe(`Bearer ${READ_KEY}`)

    expect(model.types[0]?.fields[1]).toEqual({
      name: 'faq',
      kind: 'object',
      required: false,
      repeated: true,
      of: 'faq',
    })
    expect(model.objects[0]?.key).toBe('faq')
  })

  it('skips a malformed entry rather than failing the whole model', async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 200,
      body: { types: [{ noKey: true }, { key: 'page', fields: [] }], objects: ['nope'] },
    }))

    const model = await fetchProjectModel({ baseUrl: BASE, key: READ_KEY, fetchImpl })
    expect(model.types.map((type) => type.key)).toEqual(['page'])
    expect(model.objects).toEqual([])
  })

  it('defaults titleField and slugField when the server omits them', async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 200,
      body: { types: [{ key: 'page', fields: [] }], objects: [] },
    }))
    const model = await fetchProjectModel({ baseUrl: BASE, key: READ_KEY, fetchImpl })
    expect(model.types[0]).toMatchObject({ titleField: 'title', slugField: 'slug' })
  })

  it('turns a §9 error envelope into a CliError carrying the code', async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 401,
      body: { error: { code: 'INVALID_KEY', message: 'Missing or invalid API key.' } },
    }))

    await expect(
      fetchProjectModel({ baseUrl: BASE, key: 'bad', fetchImpl }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!isCliError(error)) return false
      return error.message.includes('invalid API key') && (error.hint ?? '').includes('INVALID_KEY')
    })
  })
})

describe('listProjectObjects', () => {
  it('reads the registry', async () => {
    let seenUrl = ''
    const fetchImpl = fakeFetch((url) => {
      seenUrl = url
      return { status: 200, body: { objects: [FAQ] } }
    })

    const objects = await listProjectObjects({ baseUrl: BASE, key: READ_KEY, fetchImpl })
    expect(seenUrl).toBe(`${BASE}/objects`)
    expect(objects).toEqual([FAQ])
  })

  it('fails loudly on a payload that is not a list', async () => {
    const fetchImpl = fakeFetch(() => ({ status: 200, body: { objects: 'faq' } }))
    await expect(
      listProjectObjects({ baseUrl: BASE, key: READ_KEY, fetchImpl }),
    ).rejects.toThrow('unexpected object list')
  })
})

describe('createProjectObject', () => {
  it('POSTs the definition with the write key', async () => {
    let seenBody: unknown
    let seenMethod: string | undefined
    let seenAuth: string | undefined
    const fetchImpl = fakeFetch((_url, init) => {
      seenMethod = init.method
      seenAuth = (init.headers as Record<string, string> | undefined)?.['authorization']
      seenBody = JSON.parse(String(init.body))
      return { status: 201, body: { object: FAQ } }
    })

    const created = await createProjectObject({ baseUrl: BASE, key: WRITE_KEY, fetchImpl }, FAQ)

    expect(seenMethod).toBe('POST')
    expect(seenAuth).toBe(`Bearer ${WRITE_KEY}`)
    expect(seenBody).toEqual({ key: 'faq', title: 'Question and answer', fields: FAQ.fields })
    expect(created.key).toBe('faq')
  })

  it('surfaces a 409 as an error the agent can read', async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 409,
      body: {
        error: { code: 'VALIDATION_FAILED', message: 'An object named "faq" already exists.' },
      },
    }))

    await expect(
      createProjectObject({ baseUrl: BASE, key: WRITE_KEY, fetchImpl }, FAQ),
    ).rejects.toThrow('already exists')
  })
})

describe('updateProjectObject', () => {
  it('sends only what was passed', async () => {
    let seenBody: unknown
    const fetchImpl = fakeFetch((_url, init) => {
      seenBody = JSON.parse(String(init.body))
      return { status: 200, body: { object: FAQ } }
    })

    await updateProjectObject({ baseUrl: BASE, key: WRITE_KEY, fetchImpl }, 'faq', {
      title: 'שאלות',
    })
    expect(seenBody).toEqual({ title: 'שאלות' })
  })

  it('escapes the key in the URL', async () => {
    let seenUrl = ''
    const fetchImpl = fakeFetch((url) => {
      seenUrl = url
      return { status: 200, body: { object: FAQ } }
    })
    await updateProjectObject({ baseUrl: BASE, key: WRITE_KEY, fetchImpl }, 'a b', { title: 'x' })
    expect(seenUrl).toBe(`${BASE}/objects/a%20b`)
  })
})

describe('deleteProjectObject', () => {
  it('reports the deletion', async () => {
    const fetchImpl = fakeFetch(() => ({ status: 200, body: { deleted: true, key: 'priceRow' } }))
    await expect(
      deleteProjectObject({ baseUrl: BASE, key: WRITE_KEY, fetchImpl }, 'priceRow'),
    ).resolves.toBe(true)
  })

  it('raises the in-use conflict rather than reporting a silent failure', async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 409,
      body: {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Object "faq" is still used by 1 field(s) and was not deleted.',
        },
      },
    }))

    await expect(
      deleteProjectObject({ baseUrl: BASE, key: WRITE_KEY, fetchImpl }, 'faq'),
    ).rejects.toThrow('still used by')
  })
})
