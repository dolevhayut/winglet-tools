import { getDocument } from '../api'
import type { Io } from '../io'
import type { CommonOptions } from './context'
import { emitJson, loadProjectContext, requireWriteKey } from './context'

/** `get <id>` — one document in full, including the draft AND published data. */
export type GetOptions = CommonOptions

export async function getCommand(io: Io, id: string, options: GetOptions): Promise<void> {
  const context = loadProjectContext(io, options)
  const writeKey = requireWriteKey(context)

  const document = await getDocument({ baseUrl: context.apiBaseUrl, writeKey }, id)
  emitJson(io, { ok: true, command: 'get', document })
}
