import type { ProjectModel } from '../api'
import { hasLetter } from './text'
import type {
  DocumentIndex,
  ImageValue,
  LinkValue,
  LintDocument,
  NumberValue,
  ReferenceValue,
  TextValue,
} from './types'

/**
 * Turning the Content API's payload into something the checks can walk.
 *
 * WHY THE SNAPSHOT AND NOT THE MANAGEMENT LIST
 * --------------------------------------------
 * `/content/_all` is one request for the whole site, read-key only, and it
 * returns exactly what visitors are being served right now. Both halves matter.
 * Consistency is a property of a site, not of a document, so a check that could
 * only see one document at a time would be able to answer almost none of these
 * questions; and the reference site's contradiction was a problem precisely
 * because it was PUBLISHED. A draft that disagrees with itself is someone
 * mid-edit, and interrupting them would be the wrong instinct.
 *
 * The consequence to keep in mind while reading the checks: a reference to a
 * document that exists but is still a draft looks, from here, exactly like a
 * reference to nothing. `broken-links` words itself accordingly.
 */

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Reads `documents` out of a snapshot, keyed by type, into a flat list.
 *
 * Anything that does not parse is dropped rather than throwing: a lint run over
 * a site with one malformed row should report on the other five hundred, and
 * a malformed row is the API's problem to report, not this command's.
 */
export function toLintDocuments(
  documentsByType: Readonly<Record<string, readonly unknown[]>>,
  model: ProjectModel,
): LintDocument[] {
  const titleFields = new Map<string, string>()
  for (const type of model.types) titleFields.set(type.key, type.titleField)

  const documents: LintDocument[] = []
  for (const [typeKey, list] of Object.entries(documentsByType)) {
    for (const entry of list) {
      const record = asRecord(entry)
      if (record === undefined) continue
      const id = stringField(record, 'id')
      if (id === undefined) continue
      const data = asRecord(record['data']) ?? {}
      const type = stringField(record, 'type') ?? typeKey
      const titleField = titleFields.get(type) ?? 'title'
      documents.push({
        id,
        type,
        slug: stringField(record, 'slug') ?? '',
        title: stringField(data, titleField),
        data,
      })
    }
  }
  return documents
}

/* ── recognising the shapes that carry meaning ────────────────────────────── */

/**
 * The complete key set of an image reference, per the SDK's `ImageRef`, plus
 * the three keys an editor commonly stores beside one.
 *
 * The set is used as a CLOSED test — a record with any other key is not an
 * image — because the alternative was flagging every `{ url, label }` call to
 * action as an image with no alt text. That is the difference between a check
 * that gets fixed and a check that gets ignored.
 */
const IMAGE_KEYS: ReadonlySet<string> = new Set([
  'assetId',
  'url',
  'alt',
  'width',
  'height',
  'lqip',
  'hotspot',
  'caption',
  'credit',
  '_key',
  '_type',
])

const IMAGE_EXTENSION = /\.(?:avif|gif|jpe?g|png|svg|webp)(?:$|[?#])/iu

/**
 * Named explicitly rather than inferred from "not an image extension": a
 * download, a video and an audio file all legitimately carry a URL and
 * dimensions, and none of them wants alt text from this check.
 */
const NON_IMAGE_EXTENSION =
  /\.(?:mp4|webm|mov|m4v|avi|mkv|mp3|wav|m4a|ogg|pdf|docx?|xlsx?|pptx?|zip|csv)(?:$|[?#])/iu

function asImageRef(record: Readonly<Record<string, unknown>>): { alt: unknown } | undefined {
  const marker = record['_type']
  if (typeof marker === 'string' && marker !== 'image') return undefined
  for (const key of Object.keys(record)) {
    if (!IMAGE_KEYS.has(key)) return undefined
  }

  // An `assetId` is conclusive: nothing else in this content model has one.
  if (typeof record['assetId'] === 'string' && record['assetId'].length > 0) {
    return { alt: record['alt'] }
  }

  /*
   * Without one, a bare `{ url }` is ambiguous and corroboration is required.
   *
   * DIMENSIONS ALONE ARE NOT CORROBORATION. They were, and a video record —
   * `{ url: '…/tour.mp4', width: 1920, height: 1080 }` — was reported as an
   * image published with no description. A video has a width and a height for
   * exactly the same reasons an image does, so the signal did not distinguish
   * them at all; it only looked like it did because the fixtures were images.
   *
   * What remains is either conclusive about our own pipeline (`lqip` and
   * `hotspot` are ours, and nothing else writes them) or conclusive about the
   * file (the extension). Dimensions now only corroborate ALONGSIDE a URL that
   * is not obviously something else, which is the honest weight for them.
   */
  const url = record['url']
  if (typeof url !== 'string') return undefined
  if (NON_IMAGE_EXTENSION.test(url)) return undefined

  const ours = typeof record['lqip'] === 'string' || record['hotspot'] !== undefined
  const named = IMAGE_EXTENSION.test(url)
  const sized = typeof record['width'] === 'number' || typeof record['height'] === 'number'

  // A sized URL with no extension at all (a CDN path, say) still counts — that
  // is the common case this check exists for. A sized URL that names a
  // non-image was already refused above.
  const extensionless = !/\.[a-z0-9]{2,5}(?:$|[?#])/iu.test(url)
  return ours || named || (sized && extensionless) ? { alt: record['alt'] } : undefined
}

function asReference(record: Readonly<Record<string, unknown>>): string | undefined {
  if (record['_type'] !== 'reference') return undefined
  const ref = record['_ref']
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/** Rich text: an array of portable-text blocks, which is prose and not a list. */
function asPortableText(list: readonly unknown[]): Readonly<Record<string, unknown>>[] | undefined {
  if (list.length === 0) return undefined
  const blocks: Readonly<Record<string, unknown>>[] = []
  for (const entry of list) {
    const record = asRecord(entry)
    if (record === undefined || record['_type'] !== 'block') return undefined
    if (!Array.isArray(record['children'])) return undefined
    blocks.push(record)
  }
  return blocks
}

/** The visible text of one portable-text block: its spans, in order. */
function blockText(block: Readonly<Record<string, unknown>>): string {
  const children = block['children']
  if (!Array.isArray(children)) return ''
  let text = ''
  for (const child of children) {
    const record = asRecord(child)
    const value = record?.['text']
    if (typeof value === 'string') text += value
  }
  return text
}

/**
 * An internal link — a value that starts with `/` and has no whitespace.
 *
 * Only internal ones are collected. An external URL cannot be checked without
 * making a request per link, which turns a local command into a crawler, and a
 * 404 on someone else's site is not this project's content problem.
 */
function asInternalLink(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed.startsWith('/') || trimmed.length < 2) return undefined
  if (trimmed.startsWith('//')) return undefined
  return /\s/u.test(trimmed) ? undefined : trimmed
}

/* ── the single walk every check reads from ───────────────────────────────── */

/** Deep enough for any real content model; a stop against a cyclic payload. */
const MAX_DEPTH = 24

interface Sink {
  readonly texts: TextValue[]
  readonly numbers: NumberValue[]
  readonly images: ImageValue[]
  readonly references: ReferenceValue[]
  readonly links: LinkValue[]
}

function pushText(sink: Sink, path: string, text: string, inList: boolean): void {
  const trimmed = text.trim()
  if (trimmed.length === 0 || !hasLetter(trimmed)) return
  sink.texts.push({ path, text: trimmed, inList })
}

function walk(value: unknown, path: string, inList: boolean, depth: number, sink: Sink): void {
  if (depth > MAX_DEPTH) return

  if (typeof value === 'string') {
    const link = asInternalLink(value)
    if (link !== undefined) {
      sink.links.push({ path, href: link })
      return
    }
    pushText(sink, path, value, inList)
    return
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    sink.numbers.push({ path, value, inList })
    return
  }

  if (Array.isArray(value)) {
    const blocks = asPortableText(value)
    if (blocks !== undefined) {
      // One entry per block, keeping the block's index in the path so a finding
      // points at the paragraph. `inList` stays false: this is prose.
      blocks.forEach((block, index) => {
        pushText(sink, `${path}[${index}]`, blockText(block), false)
        const marks = block['markDefs']
        if (Array.isArray(marks)) {
          marks.forEach((mark, markIndex) => {
            walk(mark, `${path}[${index}].markDefs[${markIndex}]`, false, depth + 1, sink)
          })
        }
      })
      return
    }
    value.forEach((entry, index) => {
      walk(entry, `${path}[${index}]`, true, depth + 1, sink)
    })
    return
  }

  const record = asRecord(value)
  if (record === undefined) return

  const image = asImageRef(record)
  if (image !== undefined) {
    const alt = image.alt
    sink.images.push({
      path,
      alt: typeof alt === 'string' && alt.trim().length > 0 ? alt.trim() : undefined,
    })
    return
  }

  const ref = asReference(record)
  if (ref !== undefined) {
    sink.references.push({ path, ref })
    return
  }

  for (const [key, child] of Object.entries(record)) {
    // `_doc` is a resolved reference the API attached; its content belongs to
    // the document it came from and would otherwise be linted twice.
    if (key === '_doc') continue
    walk(child, path.length === 0 ? key : `${path}.${key}`, inList, depth + 1, sink)
  }
}

export function indexDocument(document: LintDocument): DocumentIndex {
  const sink: Sink = { texts: [], numbers: [], images: [], references: [], links: [] }
  walk(document.data, '', false, 0, sink)
  return {
    document,
    texts: sink.texts,
    numbers: sink.numbers,
    images: sink.images,
    references: sink.references,
    links: sink.links,
  }
}
