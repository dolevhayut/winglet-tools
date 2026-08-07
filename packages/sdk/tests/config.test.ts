import { API_BASE_URL, ENV } from '@product'
import { describe, expect, it } from 'vitest'

import { normaliseBaseUrl, readClientConfig, requirePreviewKey } from '../src/config'
import { MissingConfigError, isContentError } from '../src/errors'

/**
 * PRD §11 — the SDK reads exactly the variables `init` writes, and nothing else.
 *
 * Every case passes its own environment map rather than mutating `process.env`,
 * so these tests are order-independent and safe to run in parallel.
 */

const complete: Readonly<Record<string, string>> = {
  [ENV.apiUrl]: 'http://127.0.0.1:3001/v1',
  [ENV.projectId]: '11111111-2222-4333-8444-555555555555',
  [ENV.readKey]: 'read-key',
  [ENV.writeKey]: 'write-key-that-must-never-be-read',
  [ENV.previewKey]: 'preview-key',
  [ENV.revalidateSecret]: 'secret',
}

function without(name: string): Record<string, string | undefined> {
  const copy: Record<string, string | undefined> = { ...complete }
  delete copy[name]
  return copy
}

describe('readClientConfig', () => {
  it('reads the URL, project and read key', () => {
    const config = readClientConfig(complete)
    expect(config.apiBaseUrl).toBe('http://127.0.0.1:3001/v1')
    expect(config.projectId).toBe(complete[ENV.projectId])
    expect(config.readKey).toBe('read-key')
  })

  it('NEVER reads the write key', () => {
    // The whole point of a read key is that a compromised front end cannot
    // write. A config object that carried the write key would be one
    // `console.log` away from undoing that.
    const config = readClientConfig(complete)
    expect(JSON.stringify(config)).not.toContain('write-key-that-must-never-be-read')
    expect(Object.values(config)).not.toContain('write-key-that-must-never-be-read')
  })

  it('falls back to the hosted API when no URL is configured', () => {
    expect(readClientConfig(without(ENV.apiUrl)).apiBaseUrl).toBe(API_BASE_URL)
  })

  it('treats an empty or whitespace value as absent', () => {
    expect(() => readClientConfig({ ...complete, [ENV.readKey]: '   ' })).toThrow(
      MissingConfigError,
    )
    expect(readClientConfig({ ...complete, [ENV.previewKey]: '' }).previewKey).toBeUndefined()
  })

  it.each([
    ['project id', ENV.projectId],
    ['read key', ENV.readKey],
  ])('throws a typed error naming the missing %s', (_label, variable) => {
    try {
      readClientConfig(without(variable))
      expect.unreachable('should have thrown')
    } catch (error: unknown) {
      expect(isContentError(error)).toBe(true)
      expect(error).toBeInstanceOf(MissingConfigError)
      expect(error).toMatchObject({ variable })
      expect((error as MissingConfigError).message).toContain(variable)
    }
  })

  it('leaves the optional keys undefined rather than empty strings', () => {
    const config = readClientConfig(without(ENV.previewKey))
    expect(config.previewKey).toBeUndefined()
    expect(config.revalidateSecret).toBe('secret')
  })
})

describe('requirePreviewKey', () => {
  it('returns the key when configured', () => {
    expect(requirePreviewKey(readClientConfig(complete))).toBe('preview-key')
  })

  it('names the variable to set when it is not', () => {
    expect(() => requirePreviewKey(readClientConfig(without(ENV.previewKey)))).toThrow(
      ENV.previewKey,
    )
  })
})

describe('normaliseBaseUrl', () => {
  it('strips trailing slashes so path joining is a plain concatenation', () => {
    expect(normaliseBaseUrl('http://localhost:3001/v1/')).toBe('http://localhost:3001/v1')
    expect(normaliseBaseUrl('http://localhost:3001/v1///')).toBe('http://localhost:3001/v1')
    expect(normaliseBaseUrl('http://localhost:3001/v1')).toBe('http://localhost:3001/v1')
  })
})

describe('the environment variable names', () => {
  it('are all derived from the product identity, never spelled out', () => {
    // A rename must not leave a stale `…_READ_KEY` behind in a customer's env.
    for (const name of Object.values(ENV)) {
      expect(name.startsWith(ENV.apiUrl.split('API_URL')[0] ?? '')).toBe(true)
    }
  })
})
