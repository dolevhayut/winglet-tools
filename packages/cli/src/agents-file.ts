import {
  CLI_BIN,
  ENV,
  PRODUCT_NAME,
  PRODUCT_SLUG,
  REVALIDATE_ROUTE,
  SDK_PACKAGE,
  STUDIO_ORIGIN,
  TYPES_FILE,
  cacheTag,
  projectCacheTag,
} from '@product'

import type {
  BlockDefinition,
  ContentTypeDefinition,
  FieldDefinition,
  ObjectDefinition,
} from '../../sdk/src/definitions'
import { BLOCK_LIST, CONTENT_TYPE_LIST, OBJECT_LIST } from '../../sdk/src/definitions'
import { fieldType, objectNameFor } from '../../sdk/src/typegen'

/**
 * §11: "`AGENTS.md` — נוצר אוטומטית בשורש הפרויקט, מסביר לסוכן איך לצרוך תוכן,
 * אילו טיפוסים קיימים ומה השדות."
 *
 * WHY THE SDK IS IMPORTED BY RELATIVE PATH
 * ----------------------------------------
 * The repo forbids typing the product name — and therefore the SDK's package
 * name — as a literal anywhere in `.ts`. A static `import … from '<pkg>'` is
 * exactly that literal, so the CLI reaches the shared definitions and the
 * shared field-to-TypeScript mapping through the workspace path instead. Both
 * packages ship bundled, so nothing about this leaks into either published
 * artifact, and the alternative (restating §8's fields here) is precisely the
 * drift `definitions.snapshot.json` and the private repo's
 * `tools/guards/definitions-sync.test.ts` exist to prevent.
 *
 * WHY THIS FILE IS MERGED AND NEVER OVERWRITTEN
 * ---------------------------------------------
 * `AGENTS.md` is the customer's file. A site may already carry instructions for
 * its own agents, and destroying them to make room for ours would be a far
 * worse bug than not writing anything at all. Our contribution lives between
 * two HTML-comment markers and is replaced in place on every run.
 */

export const MARKER_BEGIN = `<!-- ${PRODUCT_SLUG}:begin -->`
export const MARKER_END = `<!-- ${PRODUCT_SLUG}:end -->`

export interface AgentsFileInput {
  readonly projectId: string
  readonly projectName: string | undefined
  readonly apiBaseUrl: string
  readonly appDirLabel: string
  readonly contentTypes?: readonly ContentTypeDefinition[]
  readonly blocks?: readonly BlockDefinition[]
  readonly objects?: readonly ObjectDefinition[]
}

/* ── field rendering ──────────────────────────────────────────────────────── */

function fieldNotes(field: FieldDefinition): string {
  const notes: string[] = [field.required ? 'required' : 'optional']
  if (field.options !== undefined) notes.push(`one of ${field.options.join(', ')}`)
  if (field.to !== undefined) notes.push(`references ${field.to.join(', ')}`)
  if (field.blocks !== undefined) notes.push(`blocks: ${field.blocks.join(', ')}`)
  if (field.of !== undefined) notes.push(`object \`${field.of}\``)
  return notes.join('; ')
}

/**
 * A union type contains `|`, which is also the cell separator. Unescaped, a
 * field like `'ILS' | 'USD'` silently splits into three columns and the table
 * an agent is meant to read stops being a table.
 */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|')
}

function fieldRows(fields: readonly FieldDefinition[]): string[] {
  return fields.map(
    (field) => `| \`${field.name}\` | \`${cell(fieldType(field))}\` | ${fieldNotes(field)} |`,
  )
}

function typeSection(definition: ContentTypeDefinition): string[] {
  const typeName = definition.title.replace(/\s+/g, '')
  return [
    `#### ${definition.title} — \`${definition.key}\``,
    '',
    `TypeScript type \`${typeName}\` in \`${TYPES_FILE}\`. ` +
      `Identified by \`${definition.slugField}\`, titled by \`${definition.titleField}\`.`,
    '',
    '| Field | Type | Notes |',
    '| --- | --- | --- |',
    ...fieldRows(definition.fields),
    '',
  ]
}

function blockSection(block: BlockDefinition): string[] {
  return [
    `#### \`${block.kind}\` — ${block.title}`,
    '',
    '| Field | Type | Notes |',
    '| --- | --- | --- |',
    ...fieldRows(block.fields),
    '',
  ]
}

function objectSection(object: ObjectDefinition): string[] {
  return [
    `#### \`${object.key}\` — ${object.title}`,
    '',
    `TypeScript type \`${objectNameFor(object.key)}\` in \`${TYPES_FILE}\`.`,
    '',
    '| Field | Type | Notes |',
    '| --- | --- | --- |',
    ...fieldRows(object.fields),
    '',
  ]
}

/* ── the managed block ────────────────────────────────────────────────────── */

/** The text between the markers. Pure: same input, same bytes, every run. */
export function agentsBlock(input: AgentsFileInput): string {
  const contentTypes = input.contentTypes ?? CONTENT_TYPE_LIST
  const blocks = input.blocks ?? BLOCK_LIST
  const objects = input.objects ?? OBJECT_LIST
  const keys = contentTypes.map((definition) => definition.key)
  const singular = keys.map((key) => `get${key.charAt(0).toUpperCase()}${key.slice(1)}`)
  const first = singular[0] ?? 'getPage'
  const secondList = `${singular[1] ?? 'getPost'}s`

  const lines: string[] = [
    MARKER_BEGIN,
    '',
    `## Content (${PRODUCT_NAME})`,
    '',
    `This site's editable content lives in ${PRODUCT_NAME}, not in the source. When you`,
    'need copy, images, prices or posts, read them through the SDK instead of hardcoding',
    'them — an editor changes them in the studio and the site updates without a code change.',
    '',
    `- Project id: \`${input.projectId}\``,
    ...(input.projectName === undefined ? [] : [`- Project name: ${input.projectName}`]),
    `- API: \`${input.apiBaseUrl}\``,
    `- Generated types: \`${TYPES_FILE}\` (regenerate with \`npx ${CLI_BIN} types\`)`,
    `- Studio: ${STUDIO_ORIGIN}`,
    '',
    '### Reading content',
    '',
    '```ts',
    `import { ${[first, secondList, 'getAll'].join(', ')} } from '${SDK_PACKAGE}'`,
    '',
    '// Server Components and route handlers only.',
    `const home = await ${first}('home')                  // one document, or null`,
    `const posts = await ${secondList}({ limit: 10, tag: 'ai' })  // a list`,
    'const all = await getAll()                           // everything, for a static build',
    '```',
    '',
    'Available functions, one pair per content type:',
    '',
    ...contentTypes.map((definition) => {
      const name = `${definition.key.charAt(0).toUpperCase()}${definition.key.slice(1)}`
      return `- \`get${name}(slug, { locale? })\` → \`${name} | null\` · ` +
        `\`get${name}s({ limit?, offset?, tag?, locale? })\` → \`readonly ${name}[]\``
    }),
    '- `getAll()` → every published document in one request',
    '',
    '### Rules',
    '',
    `1. **Server only.** These functions read \`${ENV.readKey}\` from the environment. Calling`,
    "   them from a `'use client'` module throws — that key must never reach a browser.",
    `2. **Never prefix the keys with \`NEXT_PUBLIC_\`.** ${ENV.writeKey} is not read by the SDK at`,
    '   all; only the studio and the CLI use it.',
    '3. **A missing document is `null`, not an exception.** Handle it — usually with',
    "   `notFound()` from `next/navigation`.",
    `4. **Do not edit \`${TYPES_FILE}\`.** It is generated; every edit is lost on the next run.`,
    '5. **Do not invent content types or fields.** The types below are fixed in this',
    '   version. Reusable OBJECT shapes are not — define them with the CLI (see Objects),',
    '   never by writing a shape the project has not registered.',
    '',
    '### Content types',
    '',
    ...contentTypes.flatMap(typeSection),
    'Every document also carries metadata alongside its fields:',
    '`_id`, `_type`, `_status` (`draft` | `published`), `_locale`, `_updatedAt`.',
    '',
    '### Blocks',
    '',
    'A `blocks` field is an array of discriminated-union members. Switch on `_type`:',
    '',
    '```ts',
    'for (const section of page.sections ?? []) {',
    '  switch (section._type) {',
    ...blocks.map((block) => `    case '${block.kind}': /* … */ break`),
    '  }',
    '}',
    '```',
    '',
    ...blocks.flatMap(blockSection),
    '### Objects',
    '',
    'A field of kind `object` carries a reusable shape this project defines. With',
    '`repeated` it is an array of them, and every element carries a `_key` the server',
    'minted — a stable id that survives reordering:',
    '',
    '```ts',
    'for (const item of page.faq ?? []) {',
    '  // item._key is stable; the array index is not',
    '}',
    '```',
    '',
    'Define your own from the command line; they appear in the studio as editable rows',
    'and in the generated types on the next `types` run:',
    '',
    '```bash',
    `npx ${CLI_BIN} objects list`,
    `npx ${CLI_BIN} objects add priceRow --title "Price row" \\`,
    '  --field label:string! --field price:number! --field suffix:string',
    '```',
    '',
    'Changes are **additive only**. A field may be added; none may be removed, renamed,',
    'retyped, or made required — documents already stored still carry the old shape, and',
    'that rule is what makes schema changes need no migration and no downtime.',
    '',
    ...objects.flatMap(objectSection),
    '### Caching and publishing',
    '',
    'Reads are tagged Next.js `fetch` caches, so a publish in the studio purges exactly the',
    'affected pages:',
    '',
    `- Project tag: \`${projectCacheTag(input.projectId)}\``,
    ...keys.map((key) => `- \`${key}\` tag: \`${cacheTag(input.projectId, key)}\``),
    '',
    `The webhook that purges them is mounted at \`${input.appDirLabel}${REVALIDATE_ROUTE}/route.ts\`.`,
    'Leave it in place; deleting it means published changes never appear on the site.',
    '',
    '### Drafts',
    '',
    '```ts',
    `import { previewClient } from '${SDK_PACKAGE}'`,
    '',
    'const draft = await previewClient().getPage(slug)  // includes unpublished documents',
    '```',
    '',
    `Requires \`${ENV.previewKey}\`. Use it only behind Next.js draft mode.`,
    '',
    '### CLI',
    '',
    '```bash',
    `npx ${CLI_BIN} types         # regenerate ${TYPES_FILE} from this project’s model`,
    `npx ${CLI_BIN} objects list  # the reusable shapes this project defines`,
    `npx ${CLI_BIN} pull          # write the content to local JSON`,
    `npx ${CLI_BIN} usage         # counters against plan limits`,
    `npx ${CLI_BIN} claim         # reprint the owner claim link`,
    '```',
    '',
    MARKER_END,
  ]

  return lines.join('\n')
}

/* ── merging ──────────────────────────────────────────────────────────────── */

export interface MergeResult {
  readonly text: string
  readonly mode: 'created' | 'replaced' | 'appended' | 'unchanged'
}

/**
 * Replaces the managed block in `existing`, appends it when the file has no
 * markers, or produces the whole file when there is none.
 */
export function mergeAgentsFile(existing: string | undefined, block: string): MergeResult {
  if (existing === undefined || existing.trim().length === 0) {
    return { text: `# Agent instructions\n\n${block}\n`, mode: 'created' }
  }

  const begin = existing.indexOf(MARKER_BEGIN)
  const end = existing.indexOf(MARKER_END)

  if (begin !== -1 && end > begin) {
    const text = `${existing.slice(0, begin)}${block}${existing.slice(end + MARKER_END.length)}`
    return { text, mode: text === existing ? 'unchanged' : 'replaced' }
  }

  const trimmed = existing.replace(/\s+$/, '')
  return { text: `${trimmed}\n\n${block}\n`, mode: 'appended' }
}
