import { describe, expect, it } from 'vitest'

import { readSources } from './walk.js'

/**
 * PRD + build constraints: "TypeScript strict. אפס `any` בממשק ציבורי.
 * אפס `@ts-ignore`."
 *
 * `strict` is enforced by tsconfig; these two escape hatches are not, because
 * they are comments and casts that silently opt out of it. So they are banned
 * textually.
 */

const SCANNED_ROOTS = ['packages', 'tools']
const TS_EXTENSIONS = ['.ts', '.tsx']

const SELF = 'tools/guards/type-safety.test.ts'

/** A line that is purely a comment — prose may legitimately mention these. */
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/

interface Offence {
  readonly location: string
  readonly line: string
}

/**
 * `skipComments` must be false for anything that *is* a comment — suppression
 * directives only ever appear inside one, so filtering comments out first would
 * make the guard silently vacuous.
 */
function scan(pattern: RegExp, skipComments: boolean): Offence[] {
  const offences: Offence[] = []
  for (const file of readSources(SCANNED_ROOTS, TS_EXTENSIONS)) {
    if (file.path === SELF) continue
    const lines = file.text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? ''
      if (skipComments && COMMENT_LINE.test(line)) continue
      if (pattern.test(line)) {
        offences.push({ location: `${file.path}:${i + 1}`, line: line.trim() })
      }
    }
  }
  return offences
}

function report(offences: readonly Offence[]): string {
  return offences.map((o) => `  ${o.location}\n    ${o.line}`).join('\n')
}

describe('no type-system escape hatches', () => {
  it('bans @ts-ignore and @ts-nocheck', () => {
    // Note: the expect-error directive is deliberately NOT banned — it fails the
    // build once the underlying error goes away, so it cannot rot the way an
    // ignore directive does.
    const offences = scan(/@ts-(ignore|nocheck)/, false)
    expect(offences, `Suppressed type errors:\n${report(offences)}`).toEqual([])
  })

  it('bans the `any` type in every form', () => {
    const offences = scan(/(?::\s*any\b|\bas\s+any\b|[<,]\s*any\s*[>,]|\bany\[\])/, true)
    expect(offences, `\`any\` found — use \`unknown\` and narrow:\n${report(offences)}`).toEqual([])
  })
})
