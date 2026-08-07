import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AGENTS_FILE, PRODUCT_SLUG, SDK_PACKAGE, TYPES_FILE } from '@product'
import { afterEach, describe, expect, it } from 'vitest'

import { CONTENT_TYPE_KEYS } from '../../sdk/src/definitions'
import { MARKER_BEGIN, MARKER_END, agentsBlock, mergeAgentsFile } from '../src/agents-file'
import { detectNextApp, findProjectRoot, resolveRoot } from '../src/detect'
import { EXIT, isCliError } from '../src/exit'
import { claimStatus, daysUntil } from '../src/format'
import { ensureIgnored } from '../src/gitignore'
import { readLocalConfig, writeLocalConfig } from '../src/local-config'
import { revalidateRoutePath, revalidateRouteSource } from '../src/scaffold'

const scratchDirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-files-'))
  scratchDirs.push(dir)
  return dir
}

/** The minimum shape `detectNextApp` accepts. */
export function makeNextApp(options?: { readonly src?: boolean; readonly name?: string }): string {
  const root = scratch()
  const appDir = options?.src === true ? join(root, 'src', 'app') : join(root, 'app')
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(appDir, 'layout.tsx'), 'export default function L() { return null }\n')
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: options?.name ?? 'demo', dependencies: { next: '^16.3.0' } }, null, 2)}\n`,
  )
  return root
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

/* ── §11: detect an App Router project, or exit 2 ─────────────────────────── */

describe('detectNextApp', () => {
  it('accepts app/ with a root layout', () => {
    const root = makeNextApp({ name: '@acme/site' })
    const app = detectNextApp(root)
    expect(app.appDirLabel).toBe('app')
    expect(app.packageName).toBe('@acme/site')
    expect(app.packageManager).toBe('npm')
  })

  it('accepts src/app/ with a root layout', () => {
    expect(detectNextApp(makeNextApp({ src: true })).appDirLabel).toBe('src/app')
  })

  it('accepts a next.config file in place of the dependency', () => {
    const root = makeNextApp()
    writeFileSync(join(root, 'package.json'), '{ "name": "demo" }\n')
    writeFileSync(join(root, 'next.config.mjs'), 'export default {}\n')
    expect(detectNextApp(root).appDirLabel).toBe('app')
  })

  it('detects the package manager from the lockfile', () => {
    const root = makeNextApp()
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    expect(detectNextApp(root).packageManager).toBe('pnpm')
  })

  it('exits 2 and names every probe when there is no package.json', () => {
    const root = scratch()
    try {
      detectNextApp(root)
      expect.unreachable('detectNextApp should have thrown')
    } catch (error) {
      expect(isCliError(error)).toBe(true)
      if (!isCliError(error)) return
      expect(error.exitCode).toBe(EXIT.unsupportedEnvironment)
      expect(error.hint).toContain('package.json — MISSING')
    }
  })

  it('exits 2 when the project is not Next.js, listing what was looked for', () => {
    const root = scratch()
    writeFileSync(join(root, 'package.json'), '{ "name": "not-next" }\n')
    try {
      detectNextApp(root)
      expect.unreachable('detectNextApp should have thrown')
    } catch (error) {
      if (!isCliError(error)) throw error
      expect(error.exitCode).toBe(EXIT.unsupportedEnvironment)
      expect(error.hint).toContain('"next" in dependencies or devDependencies — MISSING')
      expect(error.hint).toContain('next.config')
      expect(error.hint).toContain('app or src/app')
    }
  })

  it('exits 2 when Next.js is present but the App Router is not', () => {
    const root = scratch()
    writeFileSync(join(root, 'package.json'), '{ "dependencies": { "next": "16" } }\n')
    mkdirSync(join(root, 'pages'), { recursive: true })
    try {
      detectNextApp(root)
      expect.unreachable('detectNextApp should have thrown')
    } catch (error) {
      if (!isCliError(error)) throw error
      expect(error.exitCode).toBe(EXIT.unsupportedEnvironment)
      expect(error.hint).toContain('layout.tsx')
    }
  })
})

describe('root discovery', () => {
  it('walks up to the nearest package.json', () => {
    const root = makeNextApp()
    const nested = join(root, 'app', 'deep', 'deeper')
    mkdirSync(nested, { recursive: true })
    expect(findProjectRoot(nested)).toBe(root)
  })

  it('resolves --cwd relative to where the command was run', () => {
    const root = makeNextApp()
    expect(resolveRoot(root, 'app')).toBe(root)
    expect(resolveRoot(join(root, 'app'), undefined)).toBe(root)
  })
})

/* ── §11: add .env.local to .gitignore if missing ─────────────────────────── */

describe('ensureIgnored', () => {
  it('creates .gitignore when there is none', () => {
    const root = scratch()
    const result = ensureIgnored(root, ['.env.local'])
    expect(result.created).toBe(true)
    expect(readFileSync(result.path, 'utf8')).toContain('.env.local')
  })

  it('appends without touching what is already there', () => {
    const root = scratch()
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n.next/\n')
    const result = ensureIgnored(root, ['.env.local'])
    const text = readFileSync(result.path, 'utf8')

    expect(result.added).toEqual(['.env.local'])
    expect(text.startsWith('node_modules/\n.next/\n')).toBe(true)
  })

  it('adds nothing on a second run', () => {
    const root = scratch()
    ensureIgnored(root, ['.env.local', `.${PRODUCT_SLUG}/`])
    const before = readFileSync(join(root, '.gitignore'), 'utf8')
    const again = ensureIgnored(root, ['.env.local', `.${PRODUCT_SLUG}/`])

    expect(again.added).toEqual([])
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(before)
  })

  it('honours a wildcard the customer already wrote', () => {
    const root = scratch()
    writeFileSync(join(root, '.gitignore'), '.env*\n')
    expect(ensureIgnored(root, ['.env.local']).added).toEqual([])
  })
})

/* ── §11: AGENTS.md, which is the customer's file, not ours ───────────────── */

describe('AGENTS.md', () => {
  const block = agentsBlock({
    projectId: 'project-1',
    projectName: 'Demo',
    apiBaseUrl: 'https://example.test/v1',
    appDirLabel: 'app',
  })

  it('documents every content type and its fields', () => {
    for (const key of CONTENT_TYPE_KEYS) expect(block).toContain(`\`${key}\``)
    for (const field of ['title', 'slug', 'sections', 'excerpt', 'price', 'currency', 'items']) {
      expect(block).toContain(`| \`${field}\` |`)
    }
    expect(block).toContain(SDK_PACKAGE)
    expect(block).toContain(TYPES_FILE)
  })

  it('escapes the pipes inside union types so the tables stay tables', () => {
    // `'ILS' | 'USD'` unescaped would split its row into extra columns.
    expect(block).toContain("`'ILS' \\| 'USD'`")
    const rows = block.split('\n').filter((entry) => entry.startsWith('| `'))
    for (const row of rows) {
      expect(row.replace(/\\\|/g, '').split('|').length).toBe(5)
    }
  })

  it('is byte-identical when generated twice', () => {
    expect(
      agentsBlock({
        projectId: 'project-1',
        projectName: 'Demo',
        apiBaseUrl: 'https://example.test/v1',
        appDirLabel: 'app',
      }),
    ).toBe(block)
  })

  it('creates the whole file when there is none', () => {
    const merged = mergeAgentsFile(undefined, block)
    expect(merged.mode).toBe('created')
    expect(merged.text).toContain(MARKER_BEGIN)
    expect(merged.text).toContain(MARKER_END)
  })

  it('appends to a file the customer already wrote, preserving it', () => {
    const existing = '# My rules\n\nAlways run the linter.\n'
    const merged = mergeAgentsFile(existing, block)

    expect(merged.mode).toBe('appended')
    expect(merged.text.startsWith('# My rules\n\nAlways run the linter.')).toBe(true)
    expect(merged.text).toContain(MARKER_BEGIN)
  })

  it('replaces only the managed block on a later run', () => {
    const withOurs = mergeAgentsFile('# My rules\n\nAlways run the linter.\n', block).text
    const next = agentsBlock({
      projectId: 'project-2',
      projectName: 'Renamed',
      apiBaseUrl: 'https://example.test/v1',
      appDirLabel: 'src/app',
    })

    const merged = mergeAgentsFile(withOurs, next)

    expect(merged.mode).toBe('replaced')
    expect(merged.text).toContain('Always run the linter.')
    expect(merged.text).toContain('project-2')
    expect(merged.text).not.toContain('project-1')
    expect(merged.text.split(MARKER_BEGIN).length - 1).toBe(1)
  })

  it('is stable: merging the same block twice changes nothing', () => {
    const once = mergeAgentsFile('# Mine\n', block).text
    expect(mergeAgentsFile(once, block).text).toBe(once)
  })

  it('is named by the product configuration, not by this test', () => {
    expect(AGENTS_FILE.endsWith('.md')).toBe(true)
  })
})

/* ── the revalidate route the CLI mounts ──────────────────────────────────── */

describe('revalidate route', () => {
  it('mounts under the detected app directory', () => {
    const root = makeNextApp({ src: true })
    const path = revalidateRoutePath(detectNextApp(root))
    expect(path.startsWith(join(root, 'src', 'app'))).toBe(true)
    expect(path.endsWith(join('revalidate', 'route.ts'))).toBe(true)
  })

  it('is the two-line handler the SDK documents', () => {
    const source = revalidateRouteSource()
    expect(source).toContain(`from '${SDK_PACKAGE}/revalidate'`)
    expect(source).toContain('export const { POST } = createRevalidateRoute()')
  })
})

/* ── the local config that makes `claim` possible ─────────────────────────── */

describe('local config', () => {
  it('round-trips a project with its claim token', () => {
    const root = scratch()
    writeLocalConfig(root, {
      projectId: 'p1',
      slug: 'demo',
      name: 'Demo',
      apiUrl: 'https://example.test/v1',
      claim: { url: 'https://example.test/claim/abc', token: 'abc', expiresAt: '2026-09-01T00:00:00.000Z' },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    })

    const read = readLocalConfig(root)
    expect(read?.projectId).toBe('p1')
    expect(read?.claim?.token).toBe('abc')
  })

  it('is absent, not empty, before init has run', () => {
    expect(readLocalConfig(scratch())).toBeUndefined()
  })

  it('refuses to treat a corrupt config as "no project"', () => {
    const root = scratch()
    mkdirSync(join(root, `.${PRODUCT_SLUG}`), { recursive: true })
    writeFileSync(join(root, `.${PRODUCT_SLUG}`, 'config.json'), '{ not json', 'utf8')
    expect(() => readLocalConfig(root)).toThrowError(/not valid JSON/)
  })
})

/* ── §4 prints "expires in 14 days", so it had better say 14 ──────────────── */

describe('claim expiry wording', () => {
  const now = new Date('2026-08-07T12:00:00.000Z')

  it('rounds up, so a token minted a moment ago still reads as its full term', () => {
    const claim = { url: 'u', token: 't', expiresAt: '2026-08-21T11:59:59.000Z' }
    expect(daysUntil(claim.expiresAt, now)).toBe(14)
    expect(claimStatus(claim, now)).toBe('expires in 14 days, 2026-08-21')
  })

  it('says so out loud once it has passed', () => {
    const claim = { url: 'u', token: 't', expiresAt: '2026-08-06T12:00:00.000Z' }
    expect(daysUntil(claim.expiresAt, now)).toBe(-1)
    expect(claimStatus(claim, now)).toContain('EXPIRED')
  })
})
