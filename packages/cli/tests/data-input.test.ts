import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { readJsonObject } from '../src/data-input'
import { isCliError } from '../src/exit'

const scratchDirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-data-input-'))
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('readJsonObject', () => {
  it('parses a literal JSON object', () => {
    expect(readJsonObject('/unused', '{"price":42}', '--data')).toEqual({ price: 42 })
  })

  it('reads from a file when given @path', () => {
    const root = scratch()
    writeFileSync(join(root, 'doc.json'), '{"title":"שלום"}', 'utf8')
    expect(readJsonObject(root, '@doc.json', '--data')).toEqual({ title: 'שלום' })
  })

  it('rejects invalid JSON with a CliError', () => {
    let threw: unknown
    try {
      readJsonObject('/unused', 'not json', '--data')
    } catch (error) {
      threw = error
    }
    expect(isCliError(threw)).toBe(true)
  })

  it('rejects a JSON array or scalar — only an object is valid', () => {
    expect(() => readJsonObject('/unused', '[1,2]', '--data')).toThrowError()
    expect(() => readJsonObject('/unused', '42', '--data')).toThrowError()
    expect(() => readJsonObject('/unused', 'null', '--data')).toThrowError()
  })

  it('reports a missing file clearly', () => {
    let threw: unknown
    try {
      readJsonObject(scratch(), '@nope.json', '--data')
    } catch (error) {
      threw = error
    }
    expect(isCliError(threw)).toBe(true)
  })
})
