import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ENV } from '@product'
import { afterEach, describe, expect, it } from 'vitest'

import { ENV_FILE, parseEnvFile, readEnvValues, upsertEnv, writeEnvFile } from '../src/env-file'

/**
 * §11: "כותב `.env.local`".
 *
 * The requirement that actually matters is the one the sentence does not say:
 * **never clobber unrelated keys**. A real site's `.env.local` holds database
 * URLs and third-party secrets that exist nowhere else, and an `init` that
 * rewrote the file wholesale would destroy them silently. Every test below is
 * about that.
 */

const HEADER = '# managed'

const scratchDirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-env-'))
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe('parseEnvFile', () => {
  it('reads bare, quoted and exported assignments and skips comments', () => {
    const values = parseEnvFile(
      [
        '# a comment',
        'BARE=one',
        'DOUBLE="two three"',
        "SINGLE='four'",
        'export EXPORTED=five',
        '   SPACED   =  six  ',
        'not an assignment',
        '=novalue',
      ].join('\n'),
    )

    expect(Object.fromEntries(values)).toEqual({
      BARE: 'one',
      DOUBLE: 'two three',
      SINGLE: 'four',
      EXPORTED: 'five',
      SPACED: 'six',
    })
  })

  it('lets a later assignment win, as dotenv does', () => {
    expect(parseEnvFile('KEY=first\nKEY=second').get('KEY')).toBe('second')
  })
})

describe('upsertEnv', () => {
  it('appends under one header when the file has none of the keys', () => {
    const result = upsertEnv(
      'DATABASE_URL=postgres://local\n# keep me\n',
      new Map([
        [ENV.projectId, 'p1'],
        [ENV.readKey, 'k1'],
      ]),
      HEADER,
    )

    expect(result.text).toBe(
      ['DATABASE_URL=postgres://local', '# keep me', '', HEADER, `${ENV.projectId}=p1`, `${ENV.readKey}=k1`, ''].join(
        '\n',
      ),
    )
    expect(result.changed).toEqual([ENV.projectId, ENV.readKey])
  })

  it('rewrites an existing assignment where it stands, keeping everything around it', () => {
    const before = [
      '# top',
      `${ENV.projectId}=old`,
      'DATABASE_URL=postgres://local',
      '',
      '# bottom',
      'SENTRY_DSN=abc',
    ].join('\n')

    const result = upsertEnv(before, new Map([[ENV.projectId, 'new']]), HEADER)

    expect(result.text).toBe(
      ['# top', `${ENV.projectId}=new`, 'DATABASE_URL=postgres://local', '', '# bottom', 'SENTRY_DSN=abc', ''].join(
        '\n',
      ),
    )
    expect(result.changed).toEqual([ENV.projectId])
  })

  it('keeps a dotenv `export` prefix the customer wrote', () => {
    const result = upsertEnv(`export ${ENV.readKey}=old`, new Map([[ENV.readKey, 'new']]), HEADER)
    expect(result.text).toBe(`export ${ENV.readKey}=new\n`)
  })

  it('reports nothing changed and returns identical text when values already match', () => {
    const before = `${ENV.projectId}=p1\n${ENV.readKey}=k1\n`
    const result = upsertEnv(
      before,
      new Map([
        [ENV.projectId, 'p1'],
        [ENV.readKey, 'k1'],
      ]),
      HEADER,
    )

    expect(result.text).toBe(before)
    expect(result.changed).toEqual([])
  })

  it('quotes a value that would not survive being written bare', () => {
    const result = upsertEnv('', new Map([['SOME_KEY', 'has spaces # and a hash']]), HEADER)
    expect(result.text).toContain('SOME_KEY="has spaces # and a hash"')
    expect(parseEnvFile(result.text).get('SOME_KEY')).toBe('has spaces # and a hash')
  })

  it('never leaves a key duplicated, even across repeated writes', () => {
    let text = ''
    for (const value of ['a', 'b', 'c']) {
      text = upsertEnv(text, new Map([[ENV.readKey, value]]), HEADER).text
    }
    const occurrences = text.split('\n').filter((entry) => entry.startsWith(`${ENV.readKey}=`))
    expect(occurrences).toEqual([`${ENV.readKey}=c`])
  })
})

describe('writeEnvFile', () => {
  it('creates the file when it is absent and reports it as created', () => {
    const root = scratch()
    const written = writeEnvFile(root, new Map([[ENV.projectId, 'p1']]), HEADER)

    expect(written.created).toBe(true)
    expect(written.path).toBe(join(root, ENV_FILE))
    expect(readFileSync(written.path, 'utf8')).toBe(`${HEADER}\n${ENV.projectId}=p1\n`)
  })

  it('leaves the file byte-identical when nothing changed', () => {
    const root = scratch()
    const updates = new Map([[ENV.projectId, 'p1']])
    const first = writeEnvFile(root, updates, HEADER)
    const before = readFileSync(first.path, 'utf8')

    const second = writeEnvFile(root, updates, HEADER)

    expect(second.created).toBe(false)
    expect(second.changed).toEqual([])
    expect(readFileSync(second.path, 'utf8')).toBe(before)
  })

  it('reads back what it wrote, including through a subdirectory root', () => {
    const root = scratch()
    mkdirSync(join(root, 'nested'), { recursive: true })
    writeFileSync(join(root, 'nested', ENV_FILE), `${ENV.readKey}=nested-key\n`, 'utf8')

    expect(readEnvValues(join(root, 'nested')).get(ENV.readKey)).toBe('nested-key')
    expect(readEnvValues(root).size).toBe(0)
  })
})
