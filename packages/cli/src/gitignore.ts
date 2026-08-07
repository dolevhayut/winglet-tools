import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PRODUCT_NAME } from '@product'

/**
 * §11: "מוסיף ל־`.gitignore` אם חסר".
 *
 * Appends only; an existing `.gitignore` is never reordered or rewritten. A
 * pattern already covered — literally, or by a `.env*` style wildcard the
 * customer wrote — counts as present, so re-running adds nothing.
 */

export const GITIGNORE_FILE = '.gitignore'

const HEADER = `# ${PRODUCT_NAME}`

function normalise(pattern: string): string {
  return pattern.trim().replace(/^\/+/, '').replace(/\/+$/, '')
}

/** Does an existing line already ignore `pattern`? */
function covers(existingLine: string, pattern: string): boolean {
  const line = existingLine.trim()
  if (line.length === 0 || line.startsWith('#')) return false

  const candidate = normalise(pattern)
  const existing = normalise(line.startsWith('!') ? line.slice(1) : line)
  if (existing === candidate) return true

  // A trailing wildcard the customer already wrote, e.g. `.env*` for `.env.local`.
  const star = existing.indexOf('*')
  if (star >= 0 && existing.indexOf('*', star + 1) === -1 && existing.endsWith('*')) {
    return candidate.startsWith(existing.slice(0, star))
  }
  return false
}

export interface GitignoreResult {
  readonly path: string
  readonly created: boolean
  /** Patterns this call appended. Empty when everything was already ignored. */
  readonly added: readonly string[]
}

export function ensureIgnored(root: string, patterns: readonly string[]): GitignoreResult {
  const path = join(root, GITIGNORE_FILE)
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  const lines = existing === undefined ? [] : existing.split('\n')

  const missing = patterns.filter((pattern) => !lines.some((line) => covers(line, pattern)))
  if (missing.length === 0) {
    return { path, created: false, added: [] }
  }

  const next = [...lines]
  while (next.length > 0 && (next[next.length - 1] ?? '').trim() === '') next.pop()
  if (next.length > 0) next.push('')
  if (!next.includes(HEADER)) next.push(HEADER)
  next.push(...missing)

  writeFileSync(path, `${next.join('\n')}\n`, 'utf8')
  return { path, created: existing === undefined, added: missing }
}
