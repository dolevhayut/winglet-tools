import { afterEach, describe, expect, it, vi } from 'vitest'

import { UploadRefused, sniffMime, uploadAsset } from './upload'

/**
 * M19 — the three-call transport, and the one decision it makes locally.
 *
 * `fetch` is stubbed rather than mocked at the module boundary because the
 * whole point of these tests is the SEQUENCE: what is sent, in what order, and
 * what is skipped. A recorded call list says that; a mocked module does not.
 */

const TARGET = { apiBaseUrl: 'https://api.example/v1', writeKey: 'wk_test' }

function png(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(32)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return bytes
}

function jpeg(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(32)
  bytes.set([0xff, 0xd8, 0xff, 0xe0])
  return bytes
}

interface Call {
  readonly url: string
  readonly method: string
  readonly body: unknown
}

function record(responses: readonly Response[]): { calls: Call[] } {
  const calls: Call[] = []
  let index = 0
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const raw = init.body
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: typeof raw === 'string' ? JSON.parse(raw) : raw,
    })
    const next = responses[index]
    index += 1
    if (next === undefined) throw new Error(`No stubbed response for call ${String(index)}`)
    return Promise.resolve(next)
  })
  return { calls }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sniffMime', () => {
  it('reads the four accepted formats out of their signatures', () => {
    expect(sniffMime(png())).toBe('image/png')
    expect(sniffMime(jpeg())).toBe('image/jpeg')

    const gif = new Uint8Array(16)
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    expect(sniffMime(gif)).toBe('image/gif')

    const webp = new Uint8Array(16)
    webp.set([0x52, 0x49, 0x46, 0x46])
    webp.set([0x57, 0x45, 0x42, 0x50], 8)
    expect(sniffMime(webp)).toBe('image/webp')
  })

  it('returns null for something that is not an image', () => {
    expect(sniffMime(new TextEncoder().encode('<!doctype html>'))).toBeNull()
    expect(sniffMime(new Uint8Array(0))).toBeNull()
  })
})

describe('uploadAsset', () => {
  it('sends nothing at all when the project already holds the bytes', async () => {
    // The reason the three-call protocol is not slower than the one-call one.
    // A second import of unchanged media must not move the file again.
    const { calls } = record([json({ asset: { id: 'asset-1', bytes: 32 } })])

    const result = await uploadAsset(TARGET, { bytes: png(), filename: 'a.png', alt: '' })

    expect(result).toEqual({ id: 'asset-1', bytes: 32, duplicate: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.example/v1/assets/uploads')
  })

  it('opens, PUTs the bytes to the ticket, then completes', async () => {
    const { calls } = record([
      json({ uploadId: 'up-1', uploadUrl: 'https://store.example/put?sig=x' }),
      new Response(null, { status: 200 }),
      json({ asset: { id: 'asset-2', bytes: 32 }, duplicate: false }),
    ])

    const result = await uploadAsset(TARGET, {
      bytes: png(),
      filename: 'photo.png',
      alt: 'a photograph',
    })

    expect(result).toEqual({ id: 'asset-2', bytes: 32, duplicate: false })
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST https://api.example/v1/assets/uploads',
      'PUT https://store.example/put?sig=x',
      'POST https://api.example/v1/assets/uploads/up-1/complete',
    ])
  })

  it('declares the type it read from the bytes, not the one in the name', async () => {
    /*
     * The failure this prevents: the server refuses a completion whose sniffed
     * type disagrees with the ticket, because the object already sits at a path
     * chosen from the declared type. Trusting `.jpg` on a file that is really a
     * PNG would spend the whole transfer before finding that out.
     */
    const { calls } = record([
      json({ uploadId: 'up-2', uploadUrl: 'https://store.example/put' }),
      new Response(null, { status: 200 }),
      json({ asset: { id: 'asset-3', bytes: 32 } }),
    ])

    await uploadAsset(TARGET, { bytes: png(), filename: 'mislabelled.jpg', alt: '' })

    expect(calls[0]?.body).toMatchObject({
      contentType: 'image/png',
      filename: 'mislabelled.png',
      bytes: 32,
    })
    // And the digest is over the bytes as sent, so it can be used for dedup.
    expect(calls[0]?.body).toHaveProperty('checksum', expect.stringMatching(/^[0-9a-f]{64}$/u))
  })

  it('sends alt only when there is some', async () => {
    const { calls } = record([
      json({ uploadId: 'up-3', uploadUrl: 'https://store.example/put' }),
      new Response(null, { status: 200 }),
      json({ asset: { id: 'asset-4', bytes: 32 } }),
    ])

    await uploadAsset(TARGET, { bytes: jpeg(), filename: 'x.jpg', alt: '' })

    expect(calls[2]?.body).toEqual({})
  })

  it('refuses a file that is not an image before opening a session', async () => {
    const { calls } = record([])

    await expect(
      uploadAsset(TARGET, {
        bytes: new TextEncoder().encode('not an image') as Uint8Array<ArrayBuffer>,
        filename: 'notes.txt',
        alt: '',
      }),
    ).rejects.toBeInstanceOf(UploadRefused)

    expect(calls).toHaveLength(0)
  })

  it("carries the server's own message rather than the status code", async () => {
    record([json({ error: { code: 'LIMIT_EXCEEDED', message: 'Out of storage.' } }, 403)])

    await expect(
      uploadAsset(TARGET, { bytes: png(), filename: 'a.png', alt: '' }),
    ).rejects.toThrow('Out of storage.')
  })

  it('says the ticket may have expired when storage refuses the PUT', async () => {
    // The one failure whose cause is invisible in the response: a signed URL
    // past its expiry is rejected by the store, not by us, with no envelope.
    record([
      json({ uploadId: 'up-4', uploadUrl: 'https://store.example/put' }),
      new Response(null, { status: 403 }),
    ])

    await expect(
      uploadAsset(TARGET, { bytes: png(), filename: 'a.png', alt: '' }),
    ).rejects.toThrow(/expired/u)
  })
})
