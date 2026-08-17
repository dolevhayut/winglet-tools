import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { PRODUCT_NAME } from '@product'

import { CliError, EXIT } from './exit'
// One list, because `init` both detects the config and writes to it. Two copies
// drifting would mean detecting a `.cjs` config and then scaffolding beside it.
import { NEXT_CONFIG_FILES } from './next-config'

/**
 * PRD §5: "אין תמיכה ב־Vue / Nuxt / Astro / WordPress ב־v1 — Next.js App
 * Router בלבד", and §11: a project that is not one exits `2` with a message
 * naming what was looked for.
 *
 * Detection is filesystem-only and deliberately does not require `node_modules`
 * to be populated: an agent that has just scaffolded a site and not installed
 * yet is a supported starting point, and `init` is the step that installs.
 */

/** Both layouts Next.js accepts for the App Router. */
const APP_DIR_CANDIDATES = ['app', join('src', 'app')] as const

/** A directory is the App Router only if it holds a root layout. */
const ROOT_LAYOUT_FILES = ['layout.tsx', 'layout.ts', 'layout.jsx', 'layout.js'] as const

export const PACKAGE_MANAGERS = ['pnpm', 'yarn', 'bun', 'npm'] as const
export type PackageManager = (typeof PACKAGE_MANAGERS)[number]

const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
]

export interface NextApp {
  /** Absolute path to the directory holding `package.json`. */
  readonly root: string
  /** Absolute path to the App Router directory. */
  readonly appDir: string
  /** `app` or `src/app`, with forward slashes, for printing. */
  readonly appDirLabel: string
  readonly packageManager: PackageManager
  /** `name` from `package.json`, when it has one — seeds the project name. */
  readonly packageName: string | undefined
}

/* ── package.json ─────────────────────────────────────────────────────────── */

interface PackageJson {
  readonly name: string | undefined
  readonly dependencies: Readonly<Record<string, unknown>>
  readonly devDependencies: Readonly<Record<string, unknown>>
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {}
}

function readPackageJson(root: string): PackageJson | undefined {
  const path = join(root, 'package.json')
  if (!existsSync(path)) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new CliError(
      `${path} is not valid JSON.`,
      EXIT.error,
      'Fix the manifest, then run the command again.',
    )
  }

  const record = asRecord(parsed)
  const name = record['name']
  return {
    name: typeof name === 'string' && name.length > 0 ? name : undefined,
    dependencies: asRecord(record['dependencies']),
    devDependencies: asRecord(record['devDependencies']),
  }
}

/* ── root discovery ───────────────────────────────────────────────────────── */

/**
 * The nearest ancestor holding a `package.json`, starting at `start`. Falls
 * back to `start` itself so an error message can still name a real directory.
 */
export function findProjectRoot(start: string): string {
  let current = resolve(start)
  for (;;) {
    if (existsSync(join(current, 'package.json'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(start)
    current = parent
  }
}

/** Resolves `--cwd` against the caller's working directory. */
export function resolveRoot(cwd: string, requested: string | undefined): string {
  const base = requested === undefined ? cwd : isAbsolute(requested) ? requested : join(cwd, requested)
  return findProjectRoot(base)
}

/* ── detection ────────────────────────────────────────────────────────────── */

function firstExisting(root: string, candidates: readonly string[]): string | undefined {
  return candidates.find((candidate) => existsSync(join(root, candidate)))
}

function detectPackageManager(root: string): PackageManager {
  for (const [lockfile, manager] of LOCKFILES) {
    if (existsSync(join(root, lockfile))) return manager
  }
  return 'npm'
}

function unsupported(root: string, findings: readonly string[]): CliError {
  return new CliError(
    `Not a Next.js App Router project: ${root}`,
    EXIT.unsupportedEnvironment,
    [
      'Looked for:',
      ...findings.map((finding) => `  ${finding}`),
      `${PRODUCT_NAME} supports Next.js App Router only.`,
      'Run this from your site’s root directory, or pass --cwd <dir>.',
    ].join('\n'),
  )
}

/**
 * Throws `CliError` with exit code 2 unless `root` looks like a Next.js App
 * Router project. The thrown hint lists every probe and whether it matched, so
 * the caller is told which half is missing rather than just "unsupported".
 */
export function detectNextApp(root: string): NextApp {
  const pkg = readPackageJson(root)
  if (pkg === undefined) {
    throw unsupported(root, ['package.json — MISSING'])
  }

  const hasNextDependency =
    Object.hasOwn(pkg.dependencies, 'next') || Object.hasOwn(pkg.devDependencies, 'next')
  const nextConfig = firstExisting(root, NEXT_CONFIG_FILES)
  const isNext = hasNextDependency || nextConfig !== undefined

  const appDirRelative = APP_DIR_CANDIDATES.find((candidate) => {
    const dir = join(root, candidate)
    return existsSync(dir) && firstExisting(dir, ROOT_LAYOUT_FILES) !== undefined
  })

  if (!isNext || appDirRelative === undefined) {
    throw unsupported(root, [
      `package.json — found`,
      `"next" in dependencies or devDependencies — ${hasNextDependency ? 'found' : 'MISSING'}`,
      `next.config.{ts,mjs,js,cjs} — ${nextConfig ?? 'MISSING'}`,
      `${APP_DIR_CANDIDATES.join(' or ')} containing ${ROOT_LAYOUT_FILES.join('/')} — ${
        appDirRelative ?? 'MISSING'
      }`,
    ])
  }

  return {
    root,
    appDir: join(root, appDirRelative),
    appDirLabel: appDirRelative.split(sep).join('/'),
    packageManager: detectPackageManager(root),
    packageName: pkg.name,
  }
}

/** A path relative to the project root, with forward slashes, for printing. */
export function displayPath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/')
}

/** Whether the SDK is already resolvable from the customer's project. */
export function isPackageInstalled(root: string, packageName: string): boolean {
  return existsSync(join(root, 'node_modules', packageName, 'package.json'))
}
