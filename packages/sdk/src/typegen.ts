import { SDK_PACKAGE, TYPES_FILE } from '@product'

import type {
  BlockDefinition,
  ContentTypeDefinition,
  FieldDefinition,
  FieldKind,
  ObjectDefinition,
} from './definitions'
import { BLOCK_LIST, CONTENT_TYPE_LIST, OBJECT_LIST } from './definitions'

/**
 * PRD §10/§11 — the generator behind the types file `init` writes and
 * `types` refreshes.
 *
 * PURE BY CONSTRUCTION. Definitions in, string out: no filesystem, no clock, no
 * network, no `process`. The CLI does the writing; the tests assert on the
 * returned text. Running it twice with the same input yields byte-identical
 * output, so a refresh that changed nothing produces no diff and no rebuild.
 */

export interface TypegenInput {
  readonly contentTypes: readonly ContentTypeDefinition[]
  readonly blocks: readonly BlockDefinition[]
  /**
   * The project's object registry (M10). Optional so that a caller written
   * before M10 — or a fixture that has no objects — still compiles; an `object`
   * field whose key is not in here degrades to `Record<string, unknown>` rather
   * than emitting a reference to an interface that was never written.
   */
  readonly objects?: readonly ObjectDefinition[] | undefined
}

/** What `init` generates when nothing is customised: §8, exactly. */
export const DEFAULT_TYPEGEN_INPUT: TypegenInput = {
  contentTypes: CONTENT_TYPE_LIST,
  blocks: BLOCK_LIST,
  objects: OBJECT_LIST,
}

/* ── naming ───────────────────────────────────────────────────────────────── */

function pascal(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('')
}

/** `page` → `Page`. */
export function typeNameFor(key: string): string {
  return pascal(key)
}

/** `hero` → `HeroBlock`. */
export function blockNameFor(kind: string): string {
  return `${pascal(kind)}Block`
}

/**
 * `galleryImage` → `GalleryImageObject`.
 *
 * The suffix is not decoration. Content type keys and object keys are separate
 * namespaces on the server, so a project may hold both a `galleryImage` type
 * and a `galleryImage` object; without it the generated file would declare the
 * same interface twice and fail to compile for a reason the customer never
 * caused. `blockNameFor` carries a suffix for exactly the same reason.
 */
export function objectNameFor(key: string): string {
  return `${pascal(key)}Object`
}

/* ── field kind → TypeScript ──────────────────────────────────────────────── */

const SCALARS: Readonly<Record<Exclude<FieldKind, 'select' | 'blocks' | 'object'>, string>> = {
  string: 'string',
  text: 'string',
  richtext: 'RichText',
  number: 'number',
  boolean: 'boolean',
  // ISO-8601 on the wire. `Date` would be a lie: JSON has no date type and the
  // API never revives one.
  date: 'string',
  image: 'ImageRef',
  gallery: 'ImageRef',
  reference: 'Reference',
  url: 'string',
  seo: 'SeoFields',
  stringList: 'string',
  custom: 'CustomFields',
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "\\'")}'`
}

/**
 * A `reference` is emitted UNNARROWED, and `to` is deliberately not used.
 *
 * Narrowing it — `to: ['page']` becoming `Reference<Page>` — was built and taken
 * back out. `typegen-compiles` asserts the SDK's own `Collection` is assignable
 * to the generated one, so the SDK's `items` would have to narrow in step; and
 * it cannot, because its zod schema validates `_doc` as `unknown`. That is not a
 * gap in the schema but the same honesty `client.get` already documents: this
 * package does not compile the target's schema and so cannot check its shape.
 *
 * Emitting a narrowed type the runtime does not verify would be the worse half
 * of both — a promise in the editor with nothing behind it. `_doc` is therefore
 * `unknown` and the consumer narrows, which at least makes the cast visible.
 */

/** The element type, before `repeated` wraps it in an array. */
function elementType(
  field: FieldDefinition,
  knownObjects: ReadonlySet<string>,
  knownTypes: ReadonlySet<string> = new Set(),
): string {
  if (field.kind === 'select') {
    const options = field.options ?? []
    return options.length === 0 ? 'string' : options.map(quote).join(' | ')
  }
  if (field.kind === 'blocks') {
    const kinds = field.blocks ?? []
    return kinds.length === 0 ? 'never' : kinds.map(blockNameFor).join(' | ')
  }
  if (field.kind === 'object') {
    const key = field.of
    // A field pointing at an object this generation run has never seen degrades
    // to the open record rather than referencing an interface that was never
    // emitted. `never` would be more "correct" and would make the field
    // unusable; an unreadable-but-present value is the honest answer, and it
    // keeps a types file generatable while a registry fetch is stale.
    if (key === undefined || !knownObjects.has(key)) return 'Readonly<Record<string, unknown>>'
    return objectNameFor(key)
  }
  return SCALARS[field.kind]
}

/**
 * Whether `[]` would bind to only part of this type.
 *
 * A `|` INSIDE angle brackets does not need parentheses —
 * `readonly Reference<Page | Post>[]` is already unambiguous, and wrapping it
 * emits `(Reference<Page | Post>)[]`, which compiles and reads like a mistake.
 * The old rule tested for any `|` at all, which was correct until M14 gave
 * `Reference` a type argument that can itself be a union.
 */
function hasTopLevelUnion(type: string): boolean {
  let depth = 0
  for (let index = 0; index < type.length; index += 1) {
    const character = type[index]
    if (character === '<') depth += 1
    else if (character === '>') depth -= 1
    else if (character === '|' && depth === 0) return true
  }
  return false
}

export function fieldType(
  field: FieldDefinition,
  knownObjects: ReadonlySet<string> = new Set(),
  knownTypes: ReadonlySet<string> = new Set(),
): string {
  const element = elementType(field, knownObjects, knownTypes)
  if (field.repeated !== true) return element
  // A union element has to be parenthesised before `[]` binds to it.
  return hasTopLevelUnion(element) ? `readonly (${element})[]` : `readonly ${element}[]`
}

/**
 * WHY AN OPTIONAL FIELD IS EMITTED AS `?: T | undefined`
 * ------------------------------------------------------
 * Under `exactOptionalPropertyTypes` — which this repo compiles with, and which
 * a strict customer may well enable — a property declared `?: T` accepts absence
 * but not an explicit `undefined`. The SDK's own `Page` type spells the union
 * out, so without it here the two would not be mutually assignable and a
 * customer could not pass a value from one API to the other.
 *
 * With the flag off (the default) the two forms are identical, so this costs
 * nothing and buys interoperability under every tsconfig.
 */
/**
 * A retired field is EMITTED, carrying `@deprecated`.
 *
 * Omitting it would be the tidier-looking choice and the wrong one: the whole
 * point of deprecating rather than deleting is that a site still reading the
 * field keeps working, and a types file that drops it turns "still served" into
 * a compile error on the customer's next `types` run. With the tag, their editor
 * strikes it through and their build stays green — which is exactly the nudge
 * without the breakage.
 */
function fieldLine(
  field: FieldDefinition,
  knownObjects: ReadonlySet<string>,
  knownTypes: ReadonlySet<string> = new Set(),
): string {
  const type = fieldType(field, knownObjects, knownTypes)
  const declaration = field.required
    ? `  readonly ${field.name}: ${type}`
    : `  readonly ${field.name}?: ${type} | undefined`

  if (field.deprecated !== true) return declaration
  return `  /** @deprecated Retired in this project's content model. */\n${declaration}`
}

function interfaceBlock(name: string, extendsClause: string, fields: readonly string[]): string {
  const heritage = extendsClause === '' ? '' : ` extends ${extendsClause}`
  if (fields.length === 0) return `export interface ${name}${heritage} {}`
  return [`export interface ${name}${heritage} {`, ...fields, '}'].join('\n')
}

/* ── the fixed preamble ───────────────────────────────────────────────────── */

function header(): string {
  return [
    '/**',
    ` * ${TYPES_FILE} — GENERATED FILE, DO NOT EDIT.`,
    ' *',
    ` * Regenerate with the CLI's \`types\` command. Every edit here is lost on the`,
    ' * next run. The shapes below mirror the content types the API serves, so a',
    ` * document returned by \`${SDK_PACKAGE}\` type-checks against them exactly.`,
    ' */',
    '',
  ].join('\n')
}

function primitives(contentTypeKeys: readonly string[]): string {
  const keyUnion =
    contentTypeKeys.length === 0 ? 'never' : contentTypeKeys.map(quote).join(' | ')

  return [
    `export type ContentTypeKey = ${keyUnion}`,
    '',
    "export type DocumentStatus = 'draft' | 'published'",
    '',
    '/** Metadata every document carries, alongside its content fields. */',
    'export interface DocumentMeta<TType extends ContentTypeKey = ContentTypeKey> {',
    '  readonly _id: string',
    '  readonly _type: TType',
    '  readonly _status: DocumentStatus',
    '  readonly _locale: string',
    '  /** ISO-8601, UTC. */',
    '  readonly _updatedAt: string',
    '}',
    '',
    '/** An `image` field: a reference to an asset in the media library. */',
    'export interface ImageRef {',
    '  readonly assetId?: string | undefined',
    '  readonly url?: string | undefined',
    '  readonly alt?: string | undefined',
    '  readonly width?: number | undefined',
    '  readonly height?: number | undefined',
    '}',
    '',
    '/**',
    ' * A `reference` field: a pointer to another document in this project.',
    ' *',
    ' * `_doc` is filled in only when the read asked for it —',
    " * `{ expand: ['featured'] }`. The reference is never replaced: `_ref` stays",
    ' * where it was, so a field has one shape whether or not it was expanded.',
    ' *',
    ' * `TDoc` is narrowed by the field: a reference declared `to: [...]` gets the',
    ' * interface it points at, so `_doc.title` is checked rather than guessed.',
    ' */',
    'export interface Reference<TDoc = unknown> {',
    "  readonly _type: 'reference'",
    '  readonly _ref: string',
    '  readonly type?: ContentTypeKey | undefined',
    '  /** Present only after `expand`; absent if the target was not found. */',
    '  readonly _doc?: TDoc | undefined',
    '}',
    '',
    'export interface SeoFields {',
    '  readonly title?: string | undefined',
    '  readonly description?: string | undefined',
    '  readonly image?: ImageRef | undefined',
    '}',
    '',
    '/** The untyped key-value escape hatch every content type carries. */',
    'export type CustomFields = Readonly<Record<string, unknown>>',
    '',
    '/* richtext — portable-text-like */',
    '',
    'export interface PortableTextSpan {',
    "  readonly _type: 'span'",
    '  readonly text: string',
    '  readonly marks?: readonly string[] | undefined',
    '  readonly _key?: string | undefined',
    '}',
    '',
    'export interface PortableTextBlock {',
    "  readonly _type: 'block'",
    '  readonly style?: string | undefined',
    '  readonly children: readonly PortableTextSpan[]',
    '  /** A `mark` on a span is a key INTO this array — where a link’s href lives. */',
    '  readonly markDefs?: readonly unknown[] | undefined',
    '  readonly listItem?: string | undefined',
    '  readonly level?: number | undefined',
    '  readonly _key?: string | undefined',
    '}',
    '',
    'export type RichText = readonly PortableTextBlock[]',
    '',
  ].join('\n')
}

/* ── the generator ────────────────────────────────────────────────────────── */

/**
 * One interface per registered object, plus the `_key` every array element
 * carries.
 *
 * `_key` is OPTIONAL in the generated type even though the server always stamps
 * it, because a document written before M10 — or restored from a snapshot that
 * predates it — has items without one. A required `_key` would make the
 * customer's own content fail to type-check against their own generated types.
 */
function objectSection(objects: readonly ObjectDefinition[], known: ReadonlySet<string>): string {
  if (objects.length === 0) return ''

  const parts: string[] = [
    '/* objects — reusable field shapes, registered per project */',
    '',
    '/** Stable identity for one element of an `array<object>`, minted by the server. */',
    'export interface ObjectItemMeta {',
    '  readonly _key?: string | undefined',
    '}',
    '',
  ]

  for (const object of objects) {
    parts.push(
      interfaceBlock(
        objectNameFor(object.key),
        'ObjectItemMeta',
        object.fields.map((field) => fieldLine(field, known)),
      ),
      '',
    )
  }

  return parts.join('\n')
}

function blockSection(blocks: readonly BlockDefinition[], known: ReadonlySet<string>): string {
  const parts: string[] = ['/* blocks — the sections a page is composed of */', '']

  for (const block of blocks) {
    const fields = [
      `  readonly _type: ${quote(block.kind)}`,
      ...block.fields.map((field) => fieldLine(field, known)),
    ]
    parts.push(interfaceBlock(blockNameFor(block.kind), '', fields), '')
  }

  const union =
    blocks.length === 0 ? 'never' : blocks.map((block) => blockNameFor(block.kind)).join(' | ')
  parts.push('/** Discriminated on `_type`. */', `export type Block = ${union}`, '')

  return parts.join('\n')
}

function contentTypeSection(
  definitions: readonly ContentTypeDefinition[],
  known: ReadonlySet<string>,
  knownTypes: ReadonlySet<string>,
): string {
  const parts: string[] = ['/* content types */', '']

  for (const definition of definitions) {
    const name = typeNameFor(definition.key)
    parts.push(
      interfaceBlock(
        `${name}Fields`,
        '',
        definition.fields.map((field) => fieldLine(field, known, knownTypes)),
      ),
      '',
      interfaceBlock(name, `${name}Fields, DocumentMeta<${quote(definition.key)}>`, []),
      '',
    )
  }

  const entries = definitions.map(
    (definition) => `  readonly ${definition.key}: ${typeNameFor(definition.key)}`,
  )
  parts.push(
    '/** Maps a content type key to the document interface it produces. */',
    interfaceBlock('ContentTypeMap', '', entries),
    '',
    'export type AnyDocument = ContentTypeMap[ContentTypeKey]',
    '',
    augmentation(definitions),
  )

  return parts.join('\n')
}

/**
 * Teaches the SDK this project's types — M14 / PRD-v2 §6.
 *
 * §6 asks for exactly this: "מחבר אותם ל־SDK דרך module augmentation". Without
 * it the customer passes the interface by hand on every call, and — worse — the
 * hand-passed argument is unrelated to the key, so `get<Accommodation>('homePage',
 * slug)` compiles and checks the home page against a cabin's schema. The point of
 * generating types is that the compiler holds the agent to the schema the agent
 * chose; a check that can be aimed at the wrong schema does not do that.
 *
 * Keyed to the FIELDS interface rather than the document, because
 * `DynamicDocument` adds the `_id`/`_type`/… envelope itself.
 *
 * WHY THIS IS SAFE TO EMIT UNCONDITIONALLY. `ProjectContentTypes` is declared
 * empty in the SDK, so a project with no generated file has `keyof` = `never`
 * and every call behaves exactly as it did before M14. Augmenting is additive in
 * both directions: two projects in one monorepo each augment their own copy of
 * the module, and TypeScript merges per program.
 */
function augmentation(definitions: readonly ContentTypeDefinition[]): string {
  if (definitions.length === 0) return ''

  const entries = definitions.map(
    (definition) => `    readonly ${definition.key}: ${typeNameFor(definition.key)}Fields`,
  )

  return [
    '/* ── the SDK learns this project’s types ──────────────────────────────── */',
    '',
    `declare module ${quote(SDK_PACKAGE)} {`,
    '  interface ProjectContentTypes {',
    ...entries,
    '  }',
    '}',
    '',
  ].join('\n')
}

/**
 * Produces the entire contents of the generated types file.
 *
 * @param input the schema definitions to generate from. Defaults to §8's four
 *              content types and the three Phase 1 blocks.
 */
export function generateTypes(input: TypegenInput = DEFAULT_TYPEGEN_INPUT): string {
  const keys = input.contentTypes.map((definition) => definition.key)
  const objects = input.objects ?? []
  const known = new Set(objects.map((object) => object.key))

  return [
    header(),
    primitives(keys),
    objectSection(objects, known),
    blockSection(input.blocks, known),
    contentTypeSection(input.contentTypes, known, new Set(keys)),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
    .concat('\n')
}
