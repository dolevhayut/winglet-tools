import { listDocuments, publishDocument } from '../api'
import { CliError, EXIT } from '../exit'
import { MARK, line } from '../io'
import type { Io } from '../io'
import { pluralise } from '../format'
import type { CommonOptions } from './context'
import { emitJson, loadProjectContext, requireWriteKey } from './context'

/** `publish` — the only command in this package that changes what a visitor sees. */
export interface PublishOptions extends CommonOptions {
  /** Publish every unpublished document instead of one named id. */
  readonly all?: boolean | undefined
  /** With `--all`, narrow to one content type. */
  readonly type?: string | undefined
}

/**
 * `publish --all` — the last mile of a migration.
 *
 * WHY THIS HAD TO EXIST
 * ---------------------
 * `import` brings a site over in one command and leaves every document a DRAFT,
 * which is right: nothing should reach a live site as a side effect of a
 * migration. But going live then meant `list`, reading forty ids, and forty
 * `publish` calls — so a feature PRD-v2 §10 calls "migration as a product"
 * ended in the least product-like step in the whole tool. Measured on the
 * reference site: 70 seconds to migrate, then forty commands.
 *
 * ONE AT A TIME, NOT ONE TRANSACTION. Each document is published by the same
 * endpoint a single `publish` uses, so a failure part-way leaves the successes
 * live and reports the rest. That is the honest behaviour for an operation whose
 * unit of meaning is the document: a partial publish is a site with some new
 * pages, which is recoverable by re-running, while a rollback would take pages
 * off a live site that the operator had just watched go up.
 *
 * Already-published documents are SKIPPED rather than republished. Publishing
 * copies the working draft over the live copy, so republishing an untouched
 * document is a no-op that still bumps `content_version` and invalidates every
 * cache in front of the site — forty times.
 */
export async function publishCommand(
  io: Io,
  id: string | undefined,
  options: PublishOptions,
): Promise<void> {
  const context = loadProjectContext(io, options)
  const writeKey = requireWriteKey(context)
  const client = { baseUrl: context.apiBaseUrl, writeKey }

  if (options.all !== true) {
    if (id === undefined) {
      throw new CliError(
        'Nothing to publish.',
        EXIT.error,
        'Pass a document id, or --all to publish every draft.',
      )
    }

    const result = await publishDocument(client, id)
    if (options.json === true) {
      emitJson(io, {
        ok: true,
        command: 'publish',
        documentId: result.documentId,
        contentVersion: result.contentVersion ?? null,
      })
      return
    }
    io.write(line(MARK.done, `Published ${result.documentId} — live`))
    return
  }

  if (id !== undefined) {
    throw new CliError(
      'Pass either an id or --all, not both.',
      EXIT.error,
      '--all publishes every draft in the project.',
    )
  }

  const documents = await listDocuments(client, options.type)
  const drafts = documents.filter((document) => document.status !== 'published')

  const published: string[] = []
  const failed: { id: string; reason: string }[] = []
  let contentVersion: number | null = null

  for (const document of drafts) {
    try {
      const result = await publishDocument(client, document.id)
      published.push(document.id)
      contentVersion = result.contentVersion ?? contentVersion
    } catch (error: unknown) {
      failed.push({
        id: document.id,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (options.json === true) {
    emitJson(io, {
      ok: failed.length === 0,
      command: 'publish --all',
      ...(options.type === undefined ? {} : { type: options.type }),
      published: published.length,
      skipped: documents.length - drafts.length,
      failed,
      contentVersion,
    })
    return
  }

  const scope = options.type === undefined ? '' : ` of type "${options.type}"`
  io.write(
    line(MARK.done, `Published ${pluralise(published.length, 'document')}${scope} — live`),
  )
  if (documents.length - drafts.length > 0) {
    io.write(`  ${String(documents.length - drafts.length)} already published, left alone\n`)
  }
  // Reported, never swallowed: a partial publish is a site in a state the
  // operator has to know about, and the ids are what they need to retry.
  for (const failure of failed) io.write(`  ! ${failure.id}: ${failure.reason}\n`)

  if (failed.length > 0) {
    throw new CliError(
      `${pluralise(failed.length, 'document')} could not be published.`,
      EXIT.error,
      'The rest are live. Re-run to retry only what is left.',
    )
  }
}
