import { listDocuments } from '../api'
import type { Io } from '../io'
import type { CommonOptions } from './context'
import { emitJson, loadProjectContext, requireWriteKey } from './context'

/**
 * `list` — the first half of the gap MCP's `list_documents` filled for a chat
 * agent but the CLI never did: finding out what exists before changing it.
 *
 * Always JSON, with no human-readable branch. Unlike `pull`/`usage`, this
 * command has no reason to be typed by a person at a terminal — it exists so a
 * script or an agent can pipe it straight into `jq`/`grep`/its own parser
 * without a `--json` flag to remember.
 */
export interface ListOptions extends CommonOptions {
  readonly type?: string | undefined
  readonly status?: string | undefined
}

export async function listCommand(io: Io, options: ListOptions): Promise<void> {
  const context = loadProjectContext(io, options)
  const writeKey = requireWriteKey(context)

  const documents = await listDocuments({ baseUrl: context.apiBaseUrl, writeKey }, options.type)
  const filtered =
    options.status === undefined ? documents : documents.filter((doc) => doc.status === options.status)

  emitJson(io, {
    ok: true,
    command: 'list',
    project: { id: context.projectId },
    total: filtered.length,
    documents: filtered,
  })
}
