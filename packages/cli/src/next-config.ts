import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PRODUCT_NAME } from '@product'

/**
 * M21.1 — `htmlLimitedBots` in the customer's `next.config.*`.
 *
 * WHAT IS ACTUALLY BROKEN
 * -----------------------
 * Next streams `generateMetadata` output on a dynamically-rendered page: the
 * body goes out first and the `<head>` tags are injected later, when the promise
 * resolves. It turns that off only for user agents matching a built-in regex of
 * parsers known to read the `<head>` and stop.
 *
 * Measured on an isolated probe app: for GPTBot, ClaudeBot, PerplexityBot and
 * OAI-SearchBot the `<title>` landed at byte 4537 with the body already at 707 —
 * after the body. Bingbot, which IS in the built-in list, got it at byte 549,
 * inside the `<head>`. None of those four execute JavaScript, so what they read
 * is what they get: a page with no title, no description and no canonical.
 *
 * THE TRAP THIS FILE EXISTS TO AVOID
 * ----------------------------------
 * `htmlLimitedBots` REPLACES the built-in list. It does not extend it. From
 * `next/dist/server/lib/streaming-metadata.js` in 16.3.1:
 *
 *     const pattern = htmlLimitedBots || HTML_LIMITED_BOT_UA_RE_STRING
 *
 * A plain `||`. So the obvious fix — setting the option to a regex of the four
 * AI crawlers — silently turns streaming metadata back ON for Bingbot,
 * Twitterbot, facebookexternalhit, LinkedInBot, Slackbot, Discordbot and
 * WhatsApp. It would fix four crawlers nobody was watching and break every
 * social preview card, which is the failure people DO notice. The value written
 * here is therefore the union: the built-in list first, then the AI crawlers.
 *
 * Next's own docs describe the option as "override", which is the accurate word
 * and the one the spec for this milestone got wrong.
 */

/**
 * Next's built-in list, copied verbatim from
 * `next/dist/shared/lib/router/utils/html-bots.js` at 16.3.1.
 *
 * VENDORED, NOT IMPORTED, and the reasons are worth recording because importing
 * it looks obviously better:
 *
 *   · That path is private. A deep import into `dist` is a dependency on a file
 *     Next may move in a patch release, and `next.config.*` is the earliest
 *     thing loaded in every build — a throw there takes the whole app down, not
 *     one page.
 *   · The value has to be written into a file the CUSTOMER owns and edits. A
 *     literal they can read, understand and extend is the point; an opaque
 *     `htmlLimitedBots: someImportedHelper()` hides the exact thing that was
 *     wrong here.
 *
 * The cost is staleness: a bot Next adds later is missed until `init` runs
 * again. That is a degradation and not a regression — a superset is always
 * safe, and this copy is the newest known list, so a project on an older Next
 * simply gets a few patterns its own version had not learned yet.
 *
 * Note that plain `Googlebot` is deliberately absent, in Next's list and so in
 * ours: it executes JavaScript, so streamed metadata reaches it fine.
 */
const NEXT_BUILT_IN_BOTS =
  '[\\w-]+-Google|Google-[\\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|' +
  'yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|' +
  'Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|' +
  'LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight'

/**
 * The crawlers that feed AI answers, none of which run JavaScript.
 *
 * `Applebot-Extended` is already covered by the built-in `applebot` under the
 * case-insensitive flag. It is listed anyway: this half of the regex is read as
 * a statement of which AI crawlers the site intends to serve, and a reader
 * should not have to know Next's list to check that Apple's is handled.
 */
const AI_CRAWLER_BOTS =
  'GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|Claude-Web|Claude-User|' +
  'PerplexityBot|Perplexity-User|Bytespider|Meta-ExternalAgent|Amazonbot|' +
  'Applebot-Extended|cohere-ai|Diffbot|CCBot'

/** The union, as it is written into the customer's config. */
export const HTML_LIMITED_BOTS_SOURCE = `${NEXT_BUILT_IN_BOTS}|${AI_CRAWLER_BOTS}`

export const HTML_LIMITED_BOTS_KEY = 'htmlLimitedBots'

/** The single line `init` adds, and the line a human is told to paste. */
export function htmlLimitedBotsLine(indent = '  '): string {
  return `${indent}${HTML_LIMITED_BOTS_KEY}: /${HTML_LIMITED_BOTS_SOURCE}/i,`
}

/* ── creating a config that does not exist yet ────────────────────────────── */

const CREATED_COMMENT = [
  '/**',
  ` * ${HTML_LIMITED_BOTS_KEY} — added by \`{cli} init\`.`,
  ' *',
  ' * Next streams metadata after the body on dynamic pages, except for user',
  ' * agents matching this regex. The first half is Next’s own built-in list,',
  ' * repeated because this option REPLACES that list rather than extending it;',
  ' * the second half is the AI crawlers, which do not run JavaScript and so read',
  ' * an empty <head> without it.',
  ' */',
]

function createdSource(typescript: boolean, cliBin: string): string {
  const comment = CREATED_COMMENT.map((row) => row.replace('{cli}', cliBin))
  const body = [
    ...comment,
    typescript ? 'const nextConfig: NextConfig = {' : '/** @type {import(\'next\').NextConfig} */',
    ...(typescript ? [] : ['const nextConfig = {']),
    htmlLimitedBotsLine(),
    '}',
    '',
    'export default nextConfig',
    '',
  ]
  return typescript ? `import type { NextConfig } from 'next'\n\n${body.join('\n')}` : body.join('\n')
}

/* ── merging into a config the customer owns ──────────────────────────────── */

/**
 * Where a property may be inserted, or `null` when nothing here is safe to edit.
 *
 * Returns the index just past the `{` that opens the config object literal.
 *
 * THE RULE, AND WHY IT IS NARROW
 * ------------------------------
 * A `next.config.*` is small but its shapes are not: bare object, named const,
 * `module.exports`, and any number of plugin wrappers (`withMDX`, `withSentry`,
 * `withNextIntl`). Guessing wrong does not throw — it inserts a key into some
 * plugin's OPTIONS object, where Next never looks. That is a silent failure of
 * the whole fix, so this resolves the default export to a declaration it can
 * actually see rather than taking the first `{` it finds.
 *
 * `export default withMDX(nextConfig)` therefore works: the identifiers in the
 * export expression are tried in order and `nextConfig` is the one with an
 * object-literal declaration. `export default withMDX({ … })` does NOT, because
 * that object could equally be the plugin's options — and for that shape the
 * caller prints the line instead of rewriting a file it does not understand.
 */
function insertionPoint(source: string): number | null {
  const declaration = (name: string): number | null => {
    const pattern = new RegExp(
      `^\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\b[^=\\n]*=\\s*\\{`,
      'm',
    )
    const match = pattern.exec(source)
    return match === null ? null : match.index + match[0].length
  }

  // `export default <expr>` / `module.exports = <expr>`: try every identifier in
  // the expression, in source order, and take the first that names an object
  // literal. The wrapper function never does, so the config wins.
  const named = /^(?:export\s+default|module\.exports\s*=)\s+([^\n;]+)/m.exec(source)
  if (named !== null) {
    const expression = named[1] ?? ''
    if (!expression.trimStart().startsWith('{')) {
      for (const identifier of expression.match(/[A-Za-z_$][\w$]*/g) ?? []) {
        const at = declaration(identifier)
        if (at !== null) return at
      }
    }
  }

  // The inline shapes, which are unambiguous.
  const inline = /^(?:export\s+default|module\.exports\s*=)\s*\{/m.exec(source)
  return inline === null ? null : inline.index + inline[0].length
}

export type NextConfigOutcome = 'created' | 'updated' | 'unchanged' | 'kept'

export interface NextConfigResult {
  readonly path: string
  readonly label: string
  readonly outcome: NextConfigOutcome
  /**
   * Set only when the merge was refused. Carries the exact line to paste, so an
   * unrecognised config shape ends in an instruction rather than in silence.
   */
  readonly manual?: string | undefined
}

/** The extensions Next accepts, in the order `init` prefers to find them. */
export const NEXT_CONFIG_FILES = [
  'next.config.ts',
  'next.config.mjs',
  'next.config.js',
  'next.config.cjs',
] as const

export interface NextConfigInput {
  readonly root: string
  readonly cliBin: string
  /** Printing helper, so this module does not depend on path presentation. */
  readonly display: (absolute: string) => string
}

/**
 * Adds `htmlLimitedBots` to the project's Next config, or explains how to.
 *
 * Never overwrites and never reformats. A config that already mentions the key
 * is left exactly as it is, including one the customer tuned themselves — the
 * same contract `scaffoldRevalidateRoute` keeps for an edited route handler.
 */
export function ensureHtmlLimitedBots(input: NextConfigInput): NextConfigResult {
  const existingName = NEXT_CONFIG_FILES.find((name) => existsSync(join(input.root, name)))

  if (existingName === undefined) {
    const typescript = existsSync(join(input.root, 'tsconfig.json'))
    const name = typescript ? NEXT_CONFIG_FILES[0] : NEXT_CONFIG_FILES[1]
    const path = join(input.root, name)
    writeFileSync(path, createdSource(typescript, input.cliBin), 'utf8')
    return { path, label: input.display(path), outcome: 'created' }
  }

  const path = join(input.root, existingName)
  const label = input.display(path)
  const source = readFileSync(path, 'utf8')

  // Already handled — by us on an earlier run, or by someone who read the same
  // Next release note. Either way it is theirs now.
  if (source.includes(HTML_LIMITED_BOTS_KEY)) {
    return { path, label, outcome: 'unchanged' }
  }

  const at = insertionPoint(source)
  if (at === null) {
    return { path, label, outcome: 'kept', manual: htmlLimitedBotsLine() }
  }

  // A one-line config (`const config: NextConfig = { reactStrictMode: true }`)
  // is common and would otherwise end up with our line and theirs sharing a
  // row. Whatever followed the brace moves onto its own line instead — the only
  // reformatting this function ever does, and only to text it just displaced.
  const rest = source.slice(at)
  const openEndsLine = /^[ \t]*\r?\n/.test(rest)
  const merged =
    `${source.slice(0, at)}\n${htmlLimitedBotsLine()}` +
    (openEndsLine ? rest : `\n${rest.replace(/^[ \t]+/, '  ')}`)

  writeFileSync(path, merged, 'utf8')
  return { path, label, outcome: 'updated' }
}

/** What `init` prints when it could not merge. Names the product, not the file. */
export function manualInstruction(result: NextConfigResult): string | undefined {
  if (result.manual === undefined) return undefined
  return [
    `${PRODUCT_NAME} could not safely edit ${result.label}.`,
    'Add this line inside your Next config object so AI crawlers get metadata in the <head>:',
    '',
    result.manual,
  ].join('\n')
}
