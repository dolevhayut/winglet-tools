import { publishDocument } from '../api'
import { MARK, line } from '../io'
import type { Io } from '../io'
import type { CommonOptions } from './context'
import { emitJson, loadProjectContext, requireWriteKey } from './context'

/** `publish <id>` — the only command in this package that changes what a visitor sees. */
export type PublishOptions = CommonOptions

export async function publishCommand(io: Io, id: string, options: PublishOptions): Promise<void> {
  const context = loadProjectContext(io, options)
  const writeKey = requireWriteKey(context)

  const result = await publishDocument({ baseUrl: context.apiBaseUrl, writeKey }, id)

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
}
