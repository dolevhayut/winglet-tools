import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { fetchContentSnapshot } from '../api'
import { displayPath } from '../detect'
import { MARK, line } from '../io'
import type { Io } from '../io'
import { CONFIG_DIR, CONTENT_DIR } from '../local-config'
import { pluralise } from '../format'
import type { CommonOptions } from './context'
import { emitJson, loadProjectContext } from './context'

/**
 * `pull` — §11's "משיכת תוכן ל-JSON מקומי (build offline)".
 *
 * One request to `/content/_all`, written out as one JSON file per content type
 * plus a whole-project snapshot. Two reasons this exists:
 *
 *   · A build that must not depend on the network — CI without egress, or a
 *     deploy target that pins its content to a commit.
 *   · An agent that wants to *read* the real content while it writes components,
 *     without an API key in its own context.
 *
 * The default destination is inside the CLI's already-git-ignored directory, so
 * a pull never adds noise to the customer's diff. `--out` overrides it for the
 * "commit the content" workflow, where that is the whole point.
 */

export interface PullOptions extends CommonOptions {
  readonly out?: string | undefined
}

const SNAPSHOT_FILE = '_all.json'

export async function pullCommand(io: Io, options: PullOptions): Promise<void> {
  const context = loadProjectContext(io, options)

  const outDir =
    options.out === undefined
      ? join(context.root, CONFIG_DIR, CONTENT_DIR)
      : isAbsolute(options.out)
        ? options.out
        : join(context.root, options.out)

  const snapshot = await fetchContentSnapshot(context.apiBaseUrl, context.readKey)

  mkdirSync(outDir, { recursive: true })

  const written: { path: string; typeKey: string; count: number }[] = []
  for (const typeKey of [...snapshot.types].sort()) {
    const documents = snapshot.documents[typeKey] ?? []
    const path = join(outDir, `${typeKey}.json`)
    writeFileSync(path, `${JSON.stringify(documents, null, 2)}\n`, 'utf8')
    written.push({ path, typeKey, count: documents.length })
  }

  const snapshotPath = join(outDir, SNAPSHOT_FILE)
  writeFileSync(
    snapshotPath,
    `${JSON.stringify(
      {
        project_id: snapshot.projectId,
        content_version: snapshot.contentVersion,
        types: snapshot.types,
        documents: snapshot.documents,
        total: snapshot.total,
        pulled_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  if (options.json === true) {
    emitJson(io, {
      ok: true,
      command: 'pull',
      project: { id: snapshot.projectId },
      contentVersion: snapshot.contentVersion ?? null,
      total: snapshot.total,
      truncated: snapshot.truncated,
      outDir,
      files: [
        { path: snapshotPath, typeKey: null, count: snapshot.total },
        ...written.map((entry) => ({ path: entry.path, typeKey: entry.typeKey, count: entry.count })),
      ],
    })
    return
  }

  io.write(
    line(
      MARK.done,
      `Pulled ${pluralise(snapshot.total, 'document')} from project ${snapshot.projectId}`,
    ),
  )
  for (const entry of written) {
    io.write(
      line(MARK.info, `${displayPath(context.root, entry.path)} — ${pluralise(entry.count, 'document')}`),
    )
  }
  io.write(line(MARK.info, displayPath(context.root, snapshotPath)))
  if (snapshot.truncated) {
    io.write(
      line(MARK.warn, 'The API truncated this snapshot. Some documents were not returned.'),
    )
  }
}
