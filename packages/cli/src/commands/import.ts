import { readFileSync, statSync } from 'node:fs'

import { CLI_BIN } from '@product'

import { readJsonValue } from '../data-input'
import { CliError, EXIT } from '../exit'
import { inferModel, readSanityExport } from '../import/sanity'
import type { ImportNote } from '../import/sanity'
import { runImport } from '../import/write'
import { pluralise } from '../format'
import { MARK, line } from '../io'
import type { Io } from '../io'
import type { CommonOptions } from './context'
import { emitJson, loadProjectContext, requireWriteKey } from './context'
import type { ProjectContext } from './context'

/**
 * M17 (PRD-v2 §10) — `import --from sanity <export-dir>`.
 *
 * "המיגרציה … לקחה סשן שלם" — a whole session of bespoke scripting, for one
 * site. This turns that into one command, and PRD-v2 is explicit about the bar:
 * the target is not completeness, it is that the content AND THE IMAGES arrive,
 * with a clear report of what needed a decision.
 *
 * The images are the part that is not optional. On the site this was built
 * against, they were skipped in the original migration and the owner uploaded
 * 85 of them by hand — the single largest friction in the whole move, and
 * entirely avoidable.
 */

export interface ImportOptions extends CommonOptions {
  readonly from?: string | undefined
  /** Print what would happen and change nothing. */
  readonly dryRun?: boolean | undefined
  /**
   * A JSON map of `{ typeKey: "שם בעברית" }`, or `@path` to a file.
   *
   * WHY THIS CANNOT BE INFERRED. Sanity keeps a type's human title in its schema
   * FILE — `title: 'מתחמי אירוח'` — and an export carries only documents. So the
   * studio would show `accommodation` and `stayRule` as section headings to a
   * business owner, which is exactly the jargon §13 forbids, and no amount of
   * looking at the data would reveal the Hebrew. Guessing a translation would be
   * worse than asking.
   *
   * Without it the import still succeeds and the report lists every type that
   * needs a name, with the command to give it one.
   */
  readonly titles?: string | undefined
}

const SOURCES = ['sanity'] as const

/**
 * A file bigger than the API accepts, resized before upload rather than
 * refused.
 *
 * The real export carried two images at 48MB and 40MB — 8187×6140, which is a
 * camera's raw output and roughly four times any dimension a browser will ever
 * display. Refusing them would mean the owner loses two photographs; uploading
 * them is impossible against a 25MB limit that exists to stop one request
 * eating an instance. Downscaling is the only answer that keeps the picture, and
 * it is exactly what the derivative pipeline would do on first request anyway.
 *
 * It is reported, never silent: altering someone's original is a decision, and
 * the report is where decisions go.
 */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const DOWNSCALE_TO = 4000

async function uploadImage(
  context: ProjectContext,
  writeKey: string,
  path: string,
  filename: string,
  alt: string,
  notes: ImportNote[],
): Promise<{ readonly id: string; readonly bytes: number } | null> {
  const file = readFileSync(path)
  let bytes: Uint8Array<ArrayBuffer> = new Uint8Array(
    file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
  )
  let name = filename

  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    const original = bytes.byteLength
    const resized = await downscale(bytes)
    if (resized === null) {
      notes.push({
        kind: 'oversized',
        where: filename,
        detail:
          `${sizeOf(original)} exceeds the ${sizeOf(MAX_UPLOAD_BYTES)} per-file limit and ` +
          'could not be resized. Not uploaded.',
      })
      return null
    }
    bytes = resized
    name = filename.replace(/\.[^.]+$/, '.jpg')
    notes.push({
      kind: 'oversized',
      where: filename,
      detail:
        `${sizeOf(original)} exceeded the ${sizeOf(MAX_UPLOAD_BYTES)} limit, so it was ` +
        `resized to ${String(DOWNSCALE_TO)}px on its long edge (${sizeOf(bytes.byteLength)}). ` +
        'Every rendition the site serves is smaller than that anyway.',
    })
  }

  const form = new FormData()
  form.set('file', new Blob([bytes], { type: mimeFor(name) }), name)
  if (alt.length > 0) form.set('alt', alt)

  const response = await fetch(`${context.apiBaseUrl}/assets/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${writeKey}` },
    body: form,
  })

  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: { message?: string } }).error.message ?? response.status)
        : `HTTP ${String(response.status)}`
    notes.push({ kind: 'dropped', where: filename, detail: message })
    return null
  }

  const asset = (body as { asset?: { id?: string; bytes?: number } } | undefined)?.asset
  if (asset?.id === undefined) return null
  return { id: asset.id, bytes: asset.bytes ?? bytes.byteLength }
}

/**
 * Resizes with sharp when it is available.
 *
 * Imported dynamically and optionally: the CLI runs on a customer's machine and
 * must not carry a native dependency for a case that affects two files in a
 * hundred. Without it the oversized image is reported and skipped, which is a
 * worse outcome but an honest one — and `npm i sharp` is in the message.
 */
async function downscale(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const { default: sharp } = await import('sharp')
    const out = await sharp(bytes)
      .rotate()
      .resize({ width: DOWNSCALE_TO, height: DOWNSCALE_TO, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer()
    // Copied out of the pooled Buffer: `Buffer` is a view onto a shared
    // allocation, and handing that straight to `Blob` can carry bytes from
    // whatever else Node put in the same pool.
    return new Uint8Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength))
  } catch {
    return null
  }
}

function mimeFor(filename: string): string {
  if (/\.png$/i.test(filename)) return 'image/png'
  if (/\.webp$/i.test(filename)) return 'image/webp'
  if (/\.gif$/i.test(filename)) return 'image/gif'
  return 'image/jpeg'
}

/** Reads `--titles`, which may be inline JSON or `@path`. */
function readTitles(root: string, raw: string | undefined): Readonly<Record<string, string>> {
  if (raw === undefined) return {}
  const value = readJsonValue(root, raw, '--titles')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CliError('--titles must be a JSON object of { typeKey: title }.', EXIT.error)
  }
  const titles: Record<string, string> = {}
  for (const [key, title] of Object.entries(value)) {
    if (typeof title === 'string' && title.length > 0) titles[key] = title
  }
  return titles
}

function sizeOf(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${Math.round(bytes / 1024)}KB`
}

/* ── the command ──────────────────────────────────────────────────────────── */

export async function importCommand(
  io: Io,
  source: string,
  options: ImportOptions,
): Promise<void> {
  if (!(SOURCES as readonly string[]).includes(options.from ?? 'sanity')) {
    throw new CliError(
      `Unknown source "${options.from ?? ''}".`,
      EXIT.error,
      `Supported: ${SOURCES.join(', ')}.`,
    )
  }

  const context = loadProjectContext(io, options)
  const writeKey = requireWriteKey(context)

  const exported = readSanityExport(source)
  if (exported.documents.length === 0) {
    throw new CliError('That export contains no documents.', EXIT.error)
  }

  const titles = readTitles(context.root, options.titles)
  const inferred = inferModel(exported.documents)
  const model = {
    ...inferred,
    types: inferred.types.map((type) => ({ ...type, title: titles[type.key] ?? type.title })),
  }

  if (options.dryRun === true) {
    emitJson(io, {
      ok: true,
      command: 'import',
      dryRun: true,
      source,
      documents: exported.documents.length,
      types: model.types.map((type) => ({
        key: type.key,
        fields: type.fields.length,
        titleField: type.titleField,
      })),
      objects: model.objects.map((object) => ({ key: object.key, fields: object.fields.length })),
      notes: model.notes,
    })
    return
  }

  const notes: ImportNote[] = []
  const outcome = await runImport({
    root: exported.root,
    documents: exported.documents,
    model,
    clients: {
      baseUrl: context.apiBaseUrl,
      readKey: context.readKey,
      writeKey,
      uploadImage: (path, filename, alt) =>
        uploadImage(context, writeKey, path, filename, alt, notes),
    },
    onProgress: (message) => {
      if (options.json !== true) io.writeError(`  ${message}\n`)
    },
  })

  const allNotes = [...outcome.notes, ...notes]

  if (options.json === true) {
    emitJson(io, {
      ok: true,
      command: 'import',
      source,
      totals: outcome.totals,
      notes: allNotes,
    })
    return
  }

  const { totals } = outcome
  io.write(line(MARK.done, 'Imported'))
  io.write(
    `  ${pluralise(totals.types.created, 'content type')}, ` +
      `${pluralise(totals.objects.created, 'object')}\n`,
  )
  io.write(
    `  ${pluralise(totals.documents.created, 'document')}` +
      `${totals.documents.failed > 0 ? ` (${String(totals.documents.failed)} failed)` : ''}\n`,
  )
  io.write(
    `  ${pluralise(totals.images.uploaded, 'image')}, ${sizeOf(totals.images.bytes)}` +
      `${totals.images.failed > 0 ? ` (${String(totals.images.failed)} failed)` : ''}\n`,
  )
  if (totals.references.resolved > 0 || totals.references.unresolved > 0) {
    io.write(
      `  ${pluralise(totals.references.resolved, 'reference')} resolved` +
        `${totals.references.unresolved > 0 ? `, ${String(totals.references.unresolved)} cleared` : ''}\n`,
    )
  }

  // The report is the deliverable, not a footnote: PRD-v2 asks for the content
  // to arrive WITH a clear account of what needed a decision.
  if (allNotes.length > 0) {
    io.write(`\n  Decisions made during the import (${String(allNotes.length)}):\n`)
    for (const note of allNotes) {
      io.write(`   · [${note.kind}] ${note.where}\n     ${note.detail}\n`)
    }
  }

  // The studio shows a type's title as a section heading to a business owner.
  // A key like `stayRule` sitting there is the jargon §13 exists to keep out,
  // and it is the one thing an export cannot tell us — so it is asked for
  // plainly rather than guessed.
  const unnamed = model.types.filter((type) => type.title === type.key)
  if (unnamed.length > 0) {
    io.write(`\n  ${String(unnamed.length)} type(s) still carry their key as a name in the studio:\n`)
    for (const type of unnamed) {
      io.write(`   ${CLI_BIN} types set ${type.key} --rename "<שם בעברית>"\n`)
    }
    io.write(`  Or re-run with --titles '{"${unnamed[0]?.key ?? ''}":"…"}'.\n`)
  }

  io.write(`\n  Run \`${CLI_BIN} types\` to generate the type definitions for this model.\n`)
}

/** Kept for the dry-run path, which reads the export without a project. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
