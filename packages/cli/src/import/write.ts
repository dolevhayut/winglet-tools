import { readFileSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'

import type { ModelFieldDefinition } from '../api'
import {
  createProjectContentType,
  createProjectObject,
  createDocument,
  fetchProjectModel,
  updateDocumentData,
  updateProjectContentType,
  updateProjectObject,
} from '../api'
import { imageFile, isPortableText, isReference, isSlug } from './sanity'
import type { ImportNote, InferredModel, InferredType, SanityDocument } from './sanity'

/**
 * M17 — writing an inferred model and its content into a project.
 *
 * ORDER MATTERS AND IS NOT ARBITRARY
 * ----------------------------------
 *   objects → types → images → documents → references
 *
 * A type whose field points at an unregistered object is refused by the API
 * (correctly). A document referring to an image that has not been uploaded would
 * store a dangling id. And a reference can only be resolved once BOTH documents
 * exist, which is why it is a second pass rather than a lookup.
 *
 * IDEMPOTENT BY SKIPPING. Everything already present is left exactly as it is
 * and counted as skipped. A migration is run more than once — the first time to
 * see what happens, then again after fixing something — and the run that
 * silently overwrote the fixes would be the one that cost a day.
 */

export interface ImportTotals {
  readonly objects: { created: number; skipped: number }
  readonly types: { created: number; skipped: number }
  readonly images: { uploaded: number; skipped: number; failed: number; bytes: number }
  readonly documents: { created: number; skipped: number; failed: number }
  readonly references: { resolved: number; unresolved: number }
}

export interface ImportOutcome {
  readonly totals: ImportTotals
  readonly notes: readonly ImportNote[]
}

export interface WriteClients {
  readonly baseUrl: string
  readonly readKey: string
  readonly writeKey: string
  readonly uploadImage: (
    path: string,
    filename: string,
    alt: string,
  ) => Promise<{ readonly id: string; readonly bytes: number } | null>
}

/* ── slugs ────────────────────────────────────────────────────────────────── */

/**
 * A slug our API will accept: lowercase, digits, hyphens.
 *
 * Hebrew titles produce nothing usable here — every character is stripped — so
 * a document titled "בקתת הצפון" falls through to its source id, which is
 * stable, unique, and already meaningful to anyone looking at the old system.
 * Inventing a transliteration would produce URLs nobody chose.
 */
export function toSlug(value: string, fallback: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  if (cleaned.length > 0) return cleaned

  const fromId = fallback
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return fromId.length > 0 ? fromId : 'item'
}

function slugFor(document: SanityDocument, type: InferredType, taken: Set<string>): string {
  const source = type.sourceSlugKey === null ? undefined : document[type.sourceSlugKey]
  const fromSlug = isSlug(source) ? source.current : ''
  const titleValue = document[type.titleField]
  const fromTitle = typeof titleValue === 'string' ? titleValue : ''

  const base = toSlug(fromSlug.length > 0 ? fromSlug : fromTitle, document._id)
  if (!taken.has(base)) {
    taken.add(base)
    return base
  }

  // A collision is real: `unique (project_id, type_key, slug, locale)`. Suffixed
  // rather than failed, because losing a document to a duplicate slug is a far
  // worse outcome than a document addressed `villa-2`.
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${String(n)}`
    if (!taken.has(candidate)) {
      taken.add(candidate)
      return candidate
    }
  }
  taken.add(document._id)
  return toSlug('', document._id)
}

/* ── value mapping ────────────────────────────────────────────────────────── */

interface MapContext {
  readonly images: ReadonlyMap<string, string>
  readonly notes: ImportNote[]
  readonly where: string
  /** Filled in as references are found; resolved in the second pass. */
  readonly pendingReferences: Set<string>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Rewrites one value from Sanity's shapes into ours.
 *
 * Underscore-prefixed keys are dropped everywhere EXCEPT `_key`, `_type` and
 * `_ref`, which our own formats use. That is not tidiness: our API rejects a
 * field name beginning with an underscore, so a `_sanityAsset` left inside an
 * object would fail the whole document.
 */
function mapValue(value: unknown, context: MapContext): unknown {
  if (value === null || value === undefined) return value
  if (typeof value !== 'object') return value

  if (Array.isArray(value)) {
    // Portable text passes through whole: it is the format we cloned, `markDefs`
    // and all, and rewriting it would only lose links.
    if (isPortableText(value)) return value
    return value.map((entry) => mapValue(entry, context))
  }

  if (isSlug(value)) return value.current

  const file = imageFile(value)
  if (file !== null) {
    const assetId = context.images.get(basename(file))
    const record = value as Record<string, unknown>
    const alt = record['alt']

    if (assetId === undefined) {
      context.notes.push({
        kind: 'dropped',
        where: context.where,
        detail: `Image "${basename(file)}" was not in the export; the reference was dropped.`,
      })
      return null
    }

    const reference = {
      assetId,
      ...(typeof alt === 'string' && alt.length > 0 ? { alt } : {}),
    }

    // The other half of the annotated-image rule in `sanity.ts`: a Sanity image
    // carrying more than alt text was inferred as an OBJECT with an `image`
    // field, so the value has to be nested to match. Emitting the bare
    // reference here is what produced `gallery.0.assetId is not a field of
    // galleryImage` on every row of every gallery.
    const extra = Object.keys(record).filter(
      (key) => !key.startsWith('_') && key !== 'alt',
    )
    if (extra.length === 0) return reference

    const wrapped: Record<string, unknown> = { image: reference }
    if (typeof alt === 'string') wrapped['alt'] = alt
    for (const key of extra) wrapped[key] = mapValue(record[key], context)
    const itemKey = record['_key']
    if (typeof itemKey === 'string') wrapped['_key'] = itemKey
    return wrapped
  }

  if (isReference(value)) {
    context.pendingReferences.add(value._ref)
    // Left as the SOURCE id and rewritten in the second pass, once the document
    // it points at exists and has an id of ours.
    return { _type: 'reference', _ref: value._ref }
  }

  const mapped: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    if (key.startsWith('_') && key !== '_key') continue
    mapped[key] = mapValue(nested, context)
  }
  return mapped
}

/* ── the import ───────────────────────────────────────────────────────────── */

export interface ImportInput {
  readonly root: string
  readonly documents: readonly SanityDocument[]
  readonly model: InferredModel
  readonly clients: WriteClients
  readonly onProgress?: ((message: string) => void) | undefined
}

export async function runImport(input: ImportInput): Promise<ImportOutcome> {
  const notes: ImportNote[] = [...input.model.notes]
  const report = (message: string): void => {
    input.onProgress?.(message)
  }

  const modelClient = { baseUrl: input.clients.baseUrl, key: input.clients.readKey }
  const writeClient = { baseUrl: input.clients.baseUrl, key: input.clients.writeKey }
  // The documents API predates the model API and takes its key under a
  // different name. Two shapes for one credential, kept explicit rather than
  // widened, so neither client's contract has to bend for the other.
  const documentClient = { baseUrl: input.clients.baseUrl, writeKey: input.clients.writeKey }

  const existing = await fetchProjectModel(modelClient)
  const heldObjects = new Set(existing.objects.map((object) => object.key))
  const heldTypes = new Set(existing.types.map((type) => type.key))

  const totals: ImportTotals = {
    objects: { created: 0, skipped: 0 },
    types: { created: 0, skipped: 0 },
    images: { uploaded: 0, skipped: 0, failed: 0, bytes: 0 },
    documents: { created: 0, skipped: 0, failed: 0 },
    references: { resolved: 0, unresolved: 0 },
  }

  /* objects ─────────────────────────────────────────────────────────────── */

  for (const object of input.model.objects) {
    const already = existing.objects.find((held) => held.key === object.key)

    if (already !== undefined) {
      // Same collision as the seeded `page` type, and it bit just as hard: every
      // project is seeded with a `galleryImage` of `{image, alt, caption}`, and
      // the source's own `galleryImage` also carries `category`. Skipping left
      // that field undeclared and every gallery row in the export was rejected
      // for it. Extending is what additive-only is for.
      const held = new Set(already.fields.map((field) => field.name))
      const additions = object.fields.filter((field) => !held.has(field.name))

      if (additions.length > 0) {
        await updateProjectObject(writeClient, object.key, {
          fields: [...already.fields, ...additions] as readonly ModelFieldDefinition[],
        })
        notes.push({
          kind: 'renamed',
          where: object.key,
          detail:
            `Already existed in this project; extended with ${String(additions.length)} ` +
            `field(s) from the export (${additions.map((f) => f.name).join(', ')}).`,
        })
      }
      totals.objects.skipped += 1
      continue
    }

    await createProjectObject(writeClient, object)
    totals.objects.created += 1
  }
  report(`objects: ${String(totals.objects.created)} created, ${String(totals.objects.skipped)} already there`)

  /* types ───────────────────────────────────────────────────────────────── */

  for (const type of input.model.types) {
    const already = existing.types.find((held) => held.key === type.key)

    if (already !== undefined) {
      // THE COLLISION THAT MATTERS: every project is seeded with `page`, and a
      // real Sanity site has its own `page` with entirely different fields.
      // Skipping left those documents validated against OUR four-field page and
      // every one of them was rejected. Extending the existing type with the
      // fields the source needs is what additive-only is FOR — nothing is
      // removed, nothing is retyped, and the customer's own documents fit.
      const held = new Map(already.fields.map((field) => [field.name, field]))
      const additions = type.fields.filter((field) => {
        const seen = held.get(field.name)
        if (seen === undefined) return true
        // A name the seeded type already has, with a different meaning, cannot
        // be redefined. It is reported and the source value will be stored
        // under it as-is if the kinds happen to agree, or rejected loudly.
        if (seen.kind !== field.kind) {
          notes.push({
            kind: 'renamed',
            where: `${type.key}.${field.name}`,
            detail:
              `This project already defines "${field.name}" as ${seen.kind}; the export ` +
              `has it as ${field.kind}. The existing definition wins — a kind cannot change.`,
          })
        }
        return false
      })

      if (additions.length > 0) {
        await updateProjectContentType(writeClient, type.key, {
          fields: [...already.fields, ...additions] as readonly ModelFieldDefinition[],
        })
      }
      totals.types.skipped += 1
      notes.push({
        kind: 'renamed',
        where: type.key,
        detail:
          `Already existed in this project; extended with ${String(additions.length)} field(s) ` +
          'from the export rather than replaced.',
      })
      continue
    }

    await createProjectContentType(writeClient, {
      key: type.key,
      title: type.title,
      titleField: type.titleField,
      slugField: type.slugField,
      fields: type.fields as readonly ModelFieldDefinition[],
    })
    totals.types.created += 1
  }
  report(`types: ${String(totals.types.created)} created, ${String(totals.types.skipped)} already there`)

  /* images ──────────────────────────────────────────────────────────────── */

  // Every image the documents actually reference. The export ships assets that
  // nothing points at any more, and uploading those would spend the customer's
  // storage allowance on content their old site had already abandoned.
  const wanted = new Map<string, string>()
  const collectImages = (value: unknown, alt: string): void => {
    if (Array.isArray(value)) {
      for (const entry of value) collectImages(entry, alt)
      return
    }
    if (!isPlainObject(value)) return
    const file = imageFile(value)
    if (file !== null) {
      const own: unknown = value['alt']
      wanted.set(basename(file), typeof own === 'string' ? own : alt)
    }
    for (const nested of Object.values(value)) collectImages(nested, alt)
  }
  for (const document of input.documents) collectImages(document, '')

  const uploaded = new Map<string, string>()
  let index = 0
  for (const [file, alt] of wanted) {
    index += 1
    const path = join(input.root, 'images', file)
    if (!existsSync(path)) {
      totals.images.failed += 1
      notes.push({
        kind: 'dropped',
        where: file,
        detail: 'Referenced by a document but missing from the export.',
      })
      continue
    }

    report(`images: ${String(index)}/${String(wanted.size)} ${file}`)
    const result = await input.clients.uploadImage(path, file, alt)
    if (result === null) {
      totals.images.failed += 1
      continue
    }
    uploaded.set(file, result.id)
    totals.images.uploaded += 1
    totals.images.bytes += result.bytes
  }

  /* documents ───────────────────────────────────────────────────────────── */

  const typesByKey = new Map(input.model.types.map((type) => [type.key, type]))
  const slugsByType = new Map<string, Set<string>>()
  const idBySourceId = new Map<string, string>()
  const pendingReferences = new Set<string>()
  const documentsWithReferences: { id: string; data: Record<string, unknown> }[] = []

  for (const document of input.documents) {
    const type = typesByKey.get(document._type)
    if (type === undefined) {
      totals.documents.failed += 1
      continue
    }

    let taken = slugsByType.get(document._type)
    if (taken === undefined) {
      taken = new Set<string>()
      slugsByType.set(document._type, taken)
    }
    const slug = slugFor(document, type, taken)

    const context: MapContext = {
      images: uploaded,
      notes,
      where: `${document._type}/${slug}`,
      pendingReferences,
    }

    const data: Record<string, unknown> = { slug }
    let hasReference = false
    for (const [key, value] of Object.entries(document)) {
      if (key.startsWith('_')) continue
      if (key === type.sourceSlugKey) continue
      const before = pendingReferences.size
      data[key] = mapValue(value, context)
      if (pendingReferences.size > before) hasReference = true
    }
    if (typeof data[type.titleField] !== 'string') data[type.titleField] = slug

    try {
      const created = await createDocument(documentClient, {
        type: document._type,
        slug,
        data,
      })
      idBySourceId.set(document._id, created.id)
      totals.documents.created += 1
      if (hasReference) documentsWithReferences.push({ id: created.id, data })
    } catch (error: unknown) {
      // A slug that already exists means this document was imported before.
      // Skipping rather than failing is what makes a re-run useful: a migration
      // is run once to see what breaks and again after fixing it, and the
      // second run must not report thirty-four failures for work it already did.
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('already exists')) {
        totals.documents.skipped += 1
        continue
      }
      totals.documents.failed += 1
      // The hint carries the API's `issues`, which name the offending PATH.
      // Without them the report says "does not match the content type" and the
      // operator has to guess which of forty fields it meant.
      const detail =
        error instanceof Error
          ? `${error.message}${'hint' in error && typeof error.hint === 'string' ? `\n     ${error.hint}` : ''}`
          : String(error)
      notes.push({ kind: 'dropped', where: `${document._type}/${slug}`, detail })
    }
  }
  report(`documents: ${String(totals.documents.created)} created, ${String(totals.documents.failed)} failed`)

  /* references ──────────────────────────────────────────────────────────── */

  // A second pass, because a reference can only be rewritten once the document
  // it points at exists here and has an id of ours.
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite)
    if (!isPlainObject(value)) return value

    if (value['_type'] === 'reference' && typeof value['_ref'] === 'string') {
      const target = idBySourceId.get(value['_ref'])
      if (target === undefined) {
        totals.references.unresolved += 1
        return null
      }
      totals.references.resolved += 1
      return { _type: 'reference', _ref: target }
    }

    const mapped: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) mapped[key] = rewrite(nested)
    return mapped
  }

  for (const pending of documentsWithReferences) {
    const rewritten = rewrite(pending.data) as Record<string, unknown>
    try {
      await updateDocumentData(documentClient, pending.id, rewritten)
    } catch {
      totals.references.unresolved += 1
    }
  }

  if (totals.references.unresolved > 0) {
    notes.push({
      kind: 'reference',
      where: 'references',
      detail:
        `${String(totals.references.unresolved)} reference(s) pointed at documents that ` +
        'are not in this export — a draft, or something deleted after it was linked. ' +
        'They were cleared rather than left pointing at nothing.',
    })
  }

  return { totals, notes }
}
