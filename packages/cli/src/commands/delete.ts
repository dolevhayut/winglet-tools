import { deleteDocument } from '../api'
import { MARK, line } from '../io'
import type { Io } from '../io'
import type { CommonOptions } from './context'
import { emitJson, loadProjectContext, requireWriteKey } from './context'

/**
 * `delete <id>` — no confirmation prompt, matching §11: nothing in this
 * package is interactive. An agent that must not delete without a human's
 * go-ahead enforces that in its own conversation, not here.
 */
export type DeleteOptions = CommonOptions

export async function deleteCommand(io: Io, id: string, options: DeleteOptions): Promise<void> {
  const context = loadProjectContext(io, options)
  const writeKey = requireWriteKey(context)

  const result = await deleteDocument({ baseUrl: context.apiBaseUrl, writeKey }, id)

  if (options.json === true) {
    emitJson(io, {
      ok: true,
      command: 'delete',
      deleted: result.deleted,
      contentVersion: result.contentVersion ?? null,
    })
    return
  }

  io.write(line(MARK.done, `Deleted ${id}`))
}
