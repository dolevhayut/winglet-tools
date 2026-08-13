import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { MAX_OBJECT_DEPTH } from '../../../sdk/src/definitions'
import type { ModelFieldDefinition, ModelObjectDefinition } from '../api'
import { CliError, EXIT } from '../exit'

/**
 * M17 (PRD-v2 §10) — reading a Sanity export and working out what its content
 * model is.
 *
 * WHY THE MODEL IS INFERRED FROM THE DOCUMENTS AND NOT READ FROM A SCHEMA
 * -----------------------------------------------------------------------
 * Sanity's schema lives in TypeScript inside the customer's studio repository.
 * An importer that required it would only work for someone who still has that
 * repository, still has it building, and is willing to hand it over — which
 * describes almost nobody who wants to leave. A `dataset export` is one command,
 * needs no code, and is what a person actually arrives with.
 *
 * So the model is derived from the data. That is less precise in exactly one
 * way — a field that is null in every document has no observable kind — and the
 * report says so rather than guessing.
 *
 * WHAT AN EXPORT LOOKS LIKE
 * -------------------------
 *   data.ndjson    one JSON document per line
 *   assets.json    the asset records
 *   images/        the actual bytes, named `<hash>-<width>x<height>.<ext>`
 *
 * Inside `data.ndjson`, `sanity dataset export` has already rewritten every
 * asset reference to `_sanityAsset: "image@file://./images/<file>"`, which is
 * what makes an offline import possible at all.
 */

/* ── reading ──────────────────────────────────────────────────────────────── */

export interface SanityDocument {
  readonly _id: string
  readonly _type: string
  readonly [key: string]: unknown
}

export interface SanityExport {
  readonly root: string
  readonly documents: readonly SanityDocument[]
}

/**
 * Sanity's own bookkeeping. Present in a live dataset, filtered out of an
 * export — but a caller may hand us either, so both are excluded here.
 */
function isSystemDocument(type: string): boolean {
  return type.startsWith('sanity.') || type.startsWith('system.')
}

/** Drafts are a Sanity concept with no equivalent here; the published doc wins. */
function isDraft(id: string): boolean {
  return id.startsWith('drafts.')
}

export function readSanityExport(path: string): SanityExport {
  if (!existsSync(path)) {
    throw new CliError(`No such path: ${path}`, EXIT.error)
  }

  if (statSync(path).isFile()) {
    throw new CliError(
      'Point this at the EXTRACTED export directory, not the archive.',
      EXIT.error,
      `tar xzf ${path}\n` +
        'then pass the directory it created. Unpacking here would mean shipping a\n' +
        'tar implementation to save one command.',
    )
  }

  const dataPath = join(path, 'data.ndjson')
  if (!existsSync(dataPath)) {
    throw new CliError(
      `${path} does not look like a Sanity export.`,
      EXIT.error,
      'Expected a `data.ndjson` inside it. Produce one with:\n' +
        '  npx sanity dataset export <dataset> export.tar.gz',
    )
  }

  const documents: SanityDocument[] = []
  for (const [index, line] of readFileSync(dataPath, 'utf8').split('\n').entries()) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw new CliError(
        `data.ndjson line ${String(index + 1)} is not valid JSON.`,
        EXIT.error,
      )
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue

    const document = parsed as SanityDocument
    if (typeof document._id !== 'string' || typeof document._type !== 'string') continue
    if (isDraft(document._id) || isSystemDocument(document._type)) continue

    documents.push(document)
  }

  return { root: path, documents }
}

/* ── recognising Sanity's own shapes ──────────────────────────────────────── */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isSlug(value: unknown): value is { current: string } {
  return isPlainObject(value) && typeof value['current'] === 'string'
}

/**
 * `_type` values that are not names.
 *
 * Sanity writes `_type: 'object'` for an inline anonymous object, so taking it
 * as the object's name produced a registered shape literally called `object` —
 * which would then collect every unrelated inline shape in the project into one
 * definition. Anonymous is anonymous; those are named for where they were found.
 */
const ANONYMOUS_TYPES = new Set(['object', 'block', 'span', 'image', 'file'])

function shapeName(value: unknown): string | null {
  if (!isPlainObject(value)) return null
  const type = value['_type']
  if (typeof type !== 'string' || ANONYMOUS_TYPES.has(type)) return null
  return type
}

/**
 * An image reference, in either form an export can produce.
 *
 * `_sanityAsset` is what `dataset export` rewrites references to, and it carries
 * the file path. `asset._ref` is the live form, which resolves through
 * `assets.json`. Both appear in the wild; a document exported once and edited
 * since can hold either.
 */
export function imageFile(value: unknown): string | null {
  if (!isPlainObject(value)) return null

  const inlined = value['_sanityAsset']
  if (typeof inlined === 'string') {
    // `image@file://./images/<name>`
    const match = /file:\/\/\.?\/?(.+)$/.exec(inlined)
    if (match?.[1] !== undefined) return match[1]
  }

  const asset = value['asset']
  if (isPlainObject(asset) && typeof asset['_ref'] === 'string') {
    // `image-<hash>-<w>x<h>-<ext>` is Sanity's asset id grammar.
    const match = /^image-([0-9a-f]+)-(\d+x\d+)-(\w+)$/.exec(asset['_ref'])
    if (match !== null) return `images/${match[1]}-${match[2]}.${match[3]}`
  }
  return null
}

export function isReference(value: unknown): value is { _ref: string } {
  return isPlainObject(value) && typeof value['_ref'] === 'string' && value['_type'] === 'reference'
}

export function isPortableText(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => isPlainObject(entry) && entry['_type'] === 'block')
  )
}

/**
 * Content keys — everything NOT beginning with an underscore.
 *
 * A named list of Sanity's own keys was the first attempt and it was wrong on
 * the real export, which carries a `_system` object on several documents. That
 * became a field called `_system`, which this API refuses outright: the
 * underscore prefix is reserved here too, for `_key` and the `_id`/`_type`
 * family. Excluding the whole prefix is both correct and future-proof against
 * the next bookkeeping key Sanity adds.
 */
function contentKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => !key.startsWith('_'))
}

/* ── inference ────────────────────────────────────────────────────────────── */

/**
 * A note about something the import decided rather than copied.
 *
 * PRD-v2 §10: "היעד לא צריך להיות שלמות. היעד הוא שהתוכן והתמונות יעברו, עם דוח
 * ברור על מה שדרש הכרעה." Everything that is not a straight copy lands here, so
 * the operator reads a list instead of discovering it in the studio a week later.
 */
export interface ImportNote {
  readonly kind: 'flattened' | 'unknown-kind' | 'renamed' | 'dropped' | 'oversized' | 'reference'
  readonly where: string
  readonly detail: string
}

export interface InferredModel {
  readonly types: readonly InferredType[]
  readonly objects: readonly ModelObjectDefinition[]
  readonly notes: readonly ImportNote[]
}

export interface InferredType {
  readonly key: string
  readonly title: string
  readonly titleField: string
  readonly slugField: string
  readonly fields: readonly ModelFieldDefinition[]
  /** Which source key held the slug, so the importer can find it again. */
  readonly sourceSlugKey: string | null
  readonly sourceTitleKey: string | null
}

/** One observed value, reduced to what matters for choosing a field kind. */
type Observation =
  | { readonly kind: 'string' }
  | { readonly kind: 'text' }
  | { readonly kind: 'number' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'date' }
  | { readonly kind: 'url' }
  | { readonly kind: 'richtext' }
  | { readonly kind: 'image' }
  | { readonly kind: 'reference' }
  | { readonly kind: 'slug' }
  | { readonly kind: 'stringList' }
  | { readonly kind: 'object'; readonly shape: Record<string, unknown>[]; readonly name: string | null }
  | { readonly kind: 'objectList'; readonly shape: Record<string, unknown>[]; readonly name: string | null }
  | { readonly kind: 'custom' }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/

/**
 * A long or multi-line string becomes `text` so the studio renders a textarea.
 * 120 is where a single-line input stops being usable, not a rule about content.
 */
const TEXT_THRESHOLD = 120

function observe(value: unknown): Observation | null {
  if (value === null || value === undefined) return null

  if (typeof value === 'boolean') return { kind: 'boolean' }
  if (typeof value === 'number') return { kind: 'number' }

  if (typeof value === 'string') {
    if (ISO_DATE.test(value)) return { kind: 'date' }
    if (/^https?:\/\//.test(value)) return { kind: 'url' }
    if (value.length > TEXT_THRESHOLD || value.includes('\n')) return { kind: 'text' }
    return { kind: 'string' }
  }

  if (Array.isArray(value)) {
    // An empty array is still evidence that the field is a LIST. Returning
    // "nothing observed" left the key undeclared, and a document that carried
    // it — `qualityFlags: []` on every migrated document of the real site — was
    // then rejected for an unknown key inside a registered object. A list of
    // nothing accepts a list of nothing.
    if (value.length === 0) return { kind: 'stringList' }
    if (isPortableText(value)) return { kind: 'richtext' }
    if (value.every((entry) => typeof entry === 'string')) return { kind: 'stringList' }
    if (value.every(isReference)) return { kind: 'reference' }

    const objects = value.filter(isPlainObject)
    if (objects.length === value.length) {
      const name = objects.map(shapeName).find((entry) => entry !== null) ?? null
      // An array of images is a gallery of bare image refs, not an object list.
      if (objects.every((entry) => imageFile(entry) !== null && contentKeys(entry).length === 0)) {
        return { kind: 'image' }
      }
      return { kind: 'objectList', shape: objects, name }
    }
    return { kind: 'custom' }
  }

  if (isPlainObject(value)) {
    if (isSlug(value)) return { kind: 'slug' }
    if (isReference(value)) return { kind: 'reference' }

    if (imageFile(value) !== null) {
      // AN ANNOTATED IMAGE IS A SHAPE, A PLAIN ONE IS A FIELD.
      //
      // Sanity models `galleryImage` as `type: 'image'` with extra fields on it,
      // so the picture and its caption are one value. We have no such thing: an
      // image field holds a reference, and anything travelling with it lives in
      // an object that CONTAINS the image. Inferring `image` for both produced a
      // `galleryImage` object of `{alt, category}` with the picture missing
      // entirely, and every gallery row was rejected for it.
      //
      // `alt` alone does not make a shape — that is what an image field already
      // carries. Anything more does.
      const extra = contentKeys(value).filter((key) => key !== 'alt')
      if (extra.length === 0) return { kind: 'image' }
      return { kind: 'object', shape: [value], name: shapeName(value) }
    }

    return { kind: 'object', shape: [value], name: shapeName(value) }
  }

  return { kind: 'custom' }
}

/**
 * Two observations of the same field, reconciled.
 *
 * Widening rather than picking the first: a field that is a short string in one
 * document and a paragraph in another is a `text` field, and choosing `string`
 * because document one came first would give the owner a single-line input for a
 * paragraph. Genuinely incompatible observations fall to `custom`, which stores
 * anything and loses nothing.
 */
function merge(a: Observation, b: Observation): Observation {
  if (a.kind === b.kind) {
    if (a.kind === 'object' && b.kind === 'object') {
      return { kind: 'object', shape: [...a.shape, ...b.shape], name: a.name ?? b.name }
    }
    if (a.kind === 'objectList' && b.kind === 'objectList') {
      return { kind: 'objectList', shape: [...a.shape, ...b.shape], name: a.name ?? b.name }
    }
    return a
  }

  const pair = new Set([a.kind, b.kind])
  const widen = (x: Observation['kind'], y: Observation['kind']): boolean => pair.has(x) && pair.has(y)

  if (widen('string', 'text')) return { kind: 'text' }
  if (widen('string', 'url')) return { kind: 'string' }
  if (widen('string', 'date')) return { kind: 'string' }
  if (widen('text', 'url')) return { kind: 'text' }
  if (widen('object', 'objectList')) {
    const shapes = [...(a.kind === 'object' || a.kind === 'objectList' ? a.shape : [])]
    const more = [...(b.kind === 'object' || b.kind === 'objectList' ? b.shape : [])]
    const name = (a.kind === 'object' || a.kind === 'objectList' ? a.name : null) ?? null
    return { kind: 'objectList', shape: [...shapes, ...more], name }
  }
  return { kind: 'custom' }
}

function pascal(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('')
}

function camel(value: string): string {
  const p = pascal(value)
  return `${p.charAt(0).toLowerCase()}${p.slice(1)}`
}

/** What the recursive inference needs to register shapes it discovers on the way. */
interface NestContext {
  readonly objects: Map<string, ModelObjectDefinition>
  readonly shapesByObject: Map<string, Record<string, unknown>[]>
  readonly notes: ImportNote[]
  /** How many object levels are already above this one. */
  readonly depth: number
}

/**
 * Turns the observed shapes of an object into a registered object definition.
 *
 * RECURSIVE SINCE M18. It used to return `null` the moment a sub-field was
 * itself an object, because objects were flat — and the caller degraded the
 * whole field to `custom`, which stored every byte and rendered nothing. On the
 * reference site that was the PRICE LIST: `groups[] → rows[]`, two levels, so
 * the owner could not edit their own prices in the studio at all.
 *
 * Now a nested shape is registered as its own object and referenced, deepest
 * first — the recursion writes a child into `objects` before its parent, so the
 * insertion order the writer replays is already a valid dependency order and
 * the API never sees a type pointing at a shape that does not exist yet.
 *
 * `null` still means "cannot be modelled", and the caller still degrades to
 * `custom`. What changed is how rarely that happens: only past `MAX_OBJECT_DEPTH`
 * or on a shape with no observable fields.
 */
function toObjectDefinition(
  key: string,
  shapes: readonly Record<string, unknown>[],
  context: NestContext,
): ModelObjectDefinition | null {
  const observations = new Map<string, Observation>()

  // An annotated image carries its picture in the value ITSELF, not under a
  // key. Our object needs somewhere to put it, so it gets one.
  const carriesImage = shapes.some((shape) => imageFile(shape) !== null)
  if (carriesImage) observations.set('image', { kind: 'image' })

  for (const shape of shapes) {
    for (const field of contentKeys(shape)) {
      const seen = observe(shape[field])
      if (seen === null) continue
      // `custom` is genuinely unmodellable — an array of mixed scalars, say —
      // and stays the escape hatch it always was.
      if (seen.kind === 'custom') continue
      const existing = observations.get(field)
      observations.set(field, existing === undefined ? seen : merge(existing, seen))
    }
  }

  if (observations.size === 0) return null

  const fields: ModelFieldDefinition[] = []

  for (const [name, seen] of observations) {
    if (seen.kind !== 'object' && seen.kind !== 'objectList') {
      fields.push({
        name,
        kind: seen.kind === 'slug' ? 'string' : seen.kind,
        required: false,
        ...(seen.kind === 'stringList' ? { repeated: true } : {}),
      })
      continue
    }

    /*
     * One level deeper. The cap is the API's, restated rather than guessed at:
     * writing a definition it would refuse turns a migration into a failure
     * halfway through, and the note below is a far better outcome than a 422.
     */
    if (context.depth + 1 >= MAX_OBJECT_DEPTH) {
      fields.push({ name, kind: 'custom', required: false })
      context.notes.push({
        kind: 'flattened',
        where: `${key}.${name}`,
        detail:
          `Nested deeper than ${String(MAX_OBJECT_DEPTH)} levels, so it is stored whole and ` +
          'is not editable field by field in the studio. No content was lost.',
      })
      continue
    }

    const nestedKey = seen.name !== null ? camel(seen.name) : camel(`${key} ${name}`)
    const nestedShapes = context.shapesByObject.get(nestedKey) ?? seen.shape
    const already = context.objects.get(nestedKey)
    const nested =
      already ??
      toObjectDefinition(nestedKey, nestedShapes, { ...context, depth: context.depth + 1 })

    if (nested === null) {
      fields.push({ name, kind: 'custom', required: false })
      context.notes.push({
        kind: 'flattened',
        where: `${key}.${name}`,
        detail: 'This shape could not be modelled, so it is stored whole. No content was lost.',
      })
      continue
    }

    // Child before parent: the writer replays this map in insertion order.
    if (already === undefined) context.objects.set(nestedKey, nested)

    fields.push({
      name,
      kind: 'object',
      of: nestedKey,
      required: false,
      ...(seen.kind === 'objectList' ? { repeated: true } : {}),
    })
  }

  return { key, title: key, fields }
}

/* ── the model ────────────────────────────────────────────────────────────── */

/**
 * Field names a document commonly uses for the thing a human reads first.
 *
 * Ordered by how title-like they are, and checked in that order rather than in
 * whatever order the keys happen to appear — `heading` should beat `author` on a
 * document that has both. `author` earns its place: a testimonial has no title
 * at all, and "Reli Av" is a far better row label in the studio than the slug
 * the import would otherwise fall back to.
 */
const TITLE_CANDIDATES = [
  'title',
  'headline',
  'heading',
  'name',
  'businessName',
  'label',
  'question',
  'author',
  'eyebrow',
]

export function inferModel(documents: readonly SanityDocument[]): InferredModel {
  const notes: ImportNote[] = []
  const objects = new Map<string, ModelObjectDefinition>()
  const byType = new Map<string, SanityDocument[]>()

  for (const document of documents) {
    const bucket = byType.get(document._type)
    if (bucket === undefined) byType.set(document._type, [document])
    else bucket.push(document)
  }

  // First pass: every shape ever seen for each object key, across every type.
  // See the note at the use site — a shared object defined from one type's view
  // of it is a definition that rejects the other types' documents.
  const shapesByObject = new Map<string, Record<string, unknown>[]>()
  const gather = (typeKey: string, field: string, seen: Observation): void => {
    if (seen.kind !== 'object' && seen.kind !== 'objectList') return
    const objectKey = seen.name !== null ? camel(seen.name) : camel(`${typeKey} ${field}`)
    const bucket = shapesByObject.get(objectKey)
    if (bucket === undefined) shapesByObject.set(objectKey, [...seen.shape])
    else bucket.push(...seen.shape)
  }

  for (const [typeKey, docs] of byType) {
    const seenHere = new Map<string, Observation>()
    for (const document of docs) {
      for (const field of contentKeys(document)) {
        const seen = observe(document[field])
        if (seen === null) continue
        const existing = seenHere.get(field)
        seenHere.set(field, existing === undefined ? seen : merge(existing, seen))
      }
    }
    for (const [field, seen] of seenHere) gather(typeKey, field, seen)
  }

  const types: InferredType[] = []

  for (const [typeKey, docs] of byType) {
    const observations = new Map<string, Observation>()
    for (const document of docs) {
      for (const field of contentKeys(document)) {
        const seen = observe(document[field])
        if (seen === null) continue
        const existing = observations.get(field)
        observations.set(field, existing === undefined ? seen : merge(existing, seen))
      }
    }

    const fields: ModelFieldDefinition[] = []
    let slugKey: string | null = null
    let titleKey: string | null = null

    for (const [name, seen] of observations) {
      if (seen.kind === 'slug') {
        // Sanity's slug is our `slug` COLUMN, not a field. Recorded so the
        // importer can find the value again, then skipped.
        slugKey = name
        continue
      }

      if (seen.kind === 'object' || seen.kind === 'objectList') {
        // Named after the source `_type` where there is one, so `galleryImage`
        // stays `galleryImage`. An anonymous inline object is named for where it
        // was found, which is the only honest name available.
        const objectKey = seen.name !== null ? camel(seen.name) : camel(`${typeKey} ${name}`)

        // EVERY shape of this object across the WHOLE export, not just this
        // type's. `migrationMetadata` appears on nine types and only some of
        // them carry `qualityFlags`; defining it from the first type that
        // happened to be processed left the key undeclared and rejected every
        // document that had it.
        const allShapes = shapesByObject.get(objectKey) ?? seen.shape
        const existing = objects.get(objectKey)
        const definition =
          existing ??
          toObjectDefinition(objectKey, allShapes, { objects, shapesByObject, notes, depth: 0 })

        if (definition === null) {
          fields.push({ name, kind: 'custom', required: false })
          notes.push({
            kind: 'flattened',
            where: `${typeKey}.${name}`,
            detail: 'This shape could not be modelled, so it is stored whole. No content was lost.',
          })
          continue
        }

        if (existing === undefined) {
          objects.set(objectKey, definition)
          if (seen.name === null) {
            notes.push({
              kind: 'renamed',
              where: `${typeKey}.${name}`,
              detail: `An unnamed shape; registered as the object "${objectKey}".`,
            })
          }
        }

        fields.push({
          name,
          kind: 'object',
          of: objectKey,
          required: false,
          ...(seen.kind === 'objectList' ? { repeated: true } : {}),
        })
        continue
      }

      if (seen.kind === 'custom') {
        notes.push({
          kind: 'unknown-kind',
          where: `${typeKey}.${name}`,
          detail: 'Values of more than one shape; stored as-is rather than guessed at.',
        })
      }

      fields.push({
        name,
        kind: seen.kind,
        required: false,
        ...(seen.kind === 'stringList' || seen.kind === 'reference' ? { repeated: true } : {}),
      })
    }

    // Chosen by CANDIDATE ORDER, not by key order: a document with both
    // `heading` and `author` should be labelled by its heading, and iterating
    // the observations would have picked whichever came first in the JSON.
    const present = new Set(
      fields.filter((field) => field.kind !== 'custom').map((field) => field.name),
    )
    titleKey = TITLE_CANDIDATES.find((candidate) => present.has(candidate)) ?? null

    // Both are guaranteed to exist as fields, because the API refuses a type
    // whose titleField or slugField is not one of its own.
    if (titleKey === null) {
      titleKey = 'title'
      if (!fields.some((field) => field.name === 'title')) {
        fields.unshift({ name: 'title', kind: 'string', required: false })
        notes.push({
          kind: 'renamed',
          where: typeKey,
          detail: 'No obvious title field; an empty `title` was added so the studio has a row label.',
        })
      }
    }

    fields.push({ name: 'slug', kind: 'string', required: false })

    types.push({
      key: typeKey,
      title: typeKey,
      titleField: titleKey,
      slugField: 'slug',
      fields: fields.filter((field, index, all) =>
        all.findIndex((other) => other.name === field.name) === index,
      ),
      sourceSlugKey: slugKey,
      sourceTitleKey: titleKey,
    })
  }

  return { types, objects: [...objects.values()], notes }
}
