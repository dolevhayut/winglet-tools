import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `.env.local`, edited in place.
 *
 * §11: "כותב `.env.local`" — and the customer's file is very rarely empty. A
 * site already carries database URLs, analytics ids and third-party secrets, so
 * a generator that rewrites the whole file is a data-loss bug waiting to
 * happen. Every function here preserves byte-for-byte everything it did not
 * explicitly set: unrelated keys, comments, blank lines and ordering.
 */

export const ENV_FILE = '.env.local'

export function envFilePath(root: string): string {
  return join(root, ENV_FILE)
}

export function readEnvFileText(root: string): string | undefined {
  const path = envFilePath(root)
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

/* ── parsing ──────────────────────────────────────────────────────────────── */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `KEY=`, tolerating leading whitespace and dotenv's optional `export `. */
function assignmentPattern(key: string): RegExp {
  return new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=`)
}

function unquote(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2) {
    const first = value.charAt(0)
    const last = value.charAt(value.length - 1)
    if ((first === '"' || first === "'") && first === last) {
      const inner = value.slice(1, -1)
      return first === '"' ? inner.replace(/\\n/g, '\n').replace(/\\"/g, '"') : inner
    }
  }
  return value
}

/** Every assignment in the file. Later assignments win, as dotenv does. */
export function parseEnvFile(text: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const rawLine of text.split('\n')) {
    const trimmed = rawLine.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice('export '.length) : trimmed
    const eq = withoutExport.indexOf('=')
    if (eq <= 0) continue
    const key = withoutExport.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    values.set(key, unquote(withoutExport.slice(eq + 1)))
  }
  return values
}

export function readEnvValues(root: string): Map<string, string> {
  const text = readEnvFileText(root)
  return text === undefined ? new Map<string, string>() : parseEnvFile(text)
}

/* ── writing ──────────────────────────────────────────────────────────────── */

/** Bare when it is safe to be bare; double-quoted the moment it is not. */
function format(value: string): string {
  return /^[A-Za-z0-9_./:@+=-]*$/.test(value) ? value : JSON.stringify(value)
}

export interface EnvWriteResult {
  readonly text: string
  /** Keys whose value the write changed or introduced. */
  readonly changed: readonly string[]
}

/**
 * Upserts `updates` into `text`. An existing assignment is rewritten where it
 * stands — keeping its position and its `export ` prefix if it had one — and a
 * missing one is appended under a single comment header. A key already holding
 * the requested value is left completely untouched, so an idempotent second run
 * produces an identical file and no diff.
 */
export function upsertEnv(
  text: string,
  updates: ReadonlyMap<string, string>,
  header: string,
): EnvWriteResult {
  const lines = text.length === 0 ? [] : text.split('\n')
  const written = new Set<string>()
  const changed: string[] = []

  const patterns = [...updates.keys()].map((key) => [key, assignmentPattern(key)] as const)

  const next = lines.map((currentLine) => {
    for (const [key, pattern] of patterns) {
      if (written.has(key) || !pattern.test(currentLine)) continue
      written.add(key)
      const value = updates.get(key)
      if (value === undefined) continue
      const existing = parseEnvFile(currentLine).get(key)
      if (existing === value) return currentLine
      changed.push(key)
      const usesExport = /^\s*export\s+/.test(currentLine)
      return `${usesExport ? 'export ' : ''}${key}=${format(value)}`
    }
    return currentLine
  })

  const missing = [...updates.entries()].filter(([key]) => !written.has(key))
  if (missing.length > 0) {
    // Exactly one blank line between the customer's content and ours.
    while (next.length > 0 && (next[next.length - 1] ?? '').trim() === '') next.pop()
    if (next.length > 0) next.push('')
    next.push(header)
    for (const [key, value] of missing) {
      next.push(`${key}=${format(value)}`)
      changed.push(key)
    }
  }

  while (next.length > 0 && (next[next.length - 1] ?? '').trim() === '') next.pop()
  return { text: `${next.join('\n')}\n`, changed }
}

export interface EnvFileWrite extends EnvWriteResult {
  readonly path: string
  readonly created: boolean
}

export function writeEnvFile(
  root: string,
  updates: ReadonlyMap<string, string>,
  header: string,
): EnvFileWrite {
  const path = envFilePath(root)
  const existing = readEnvFileText(root)
  const result = upsertEnv(existing ?? '', updates, header)
  if (existing !== result.text) writeFileSync(path, result.text, 'utf8')
  return { ...result, path, created: existing === undefined }
}
