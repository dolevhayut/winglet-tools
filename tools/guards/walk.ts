import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** Directories that are generated, vendored, or otherwise not ours to police. */
const PRUNED = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.supabase',
  'dist',
  'build',
  'coverage',
  'out',
])

export interface SourceFile {
  /** Path relative to the repo root, always with forward slashes. */
  readonly path: string
  readonly text: string
}

function collect(absDir: string, exts: ReadonlySet<string>, into: string[]): void {
  let entries
  try {
    entries = readdirSync(absDir, { withFileTypes: true })
  } catch {
    return // directory does not exist yet — a milestone hasn't created it
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue
    const abs = join(absDir, entry.name)
    if (entry.isDirectory()) {
      if (!PRUNED.has(entry.name)) collect(abs, exts, into)
      continue
    }
    const dot = entry.name.lastIndexOf('.')
    if (dot > 0 && exts.has(entry.name.slice(dot))) into.push(abs)
  }
}

/**
 * Reads every file under `roots` whose extension is in `extensions`.
 * Missing roots are skipped rather than throwing, so guards stay green
 * for milestones that have not landed yet.
 */
export function readSources(
  roots: readonly string[],
  extensions: readonly string[],
): SourceFile[] {
  const exts = new Set(extensions)
  const absolute: string[] = []
  for (const root of roots) collect(join(REPO_ROOT, root), exts, absolute)
  return absolute
    .map((abs) => ({
      path: relative(REPO_ROOT, abs).split('\\').join('/'),
      text: readFileSync(abs, 'utf8'),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/** 1-indexed line numbers of every regex match, for actionable failure messages. */
export function matchingLines(text: string, pattern: RegExp): number[] {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  const hits: number[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    re.lastIndex = 0
    if (re.test(lines[i] ?? '')) hits.push(i + 1)
  }
  return hits
}
