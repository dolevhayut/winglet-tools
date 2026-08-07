import { CLI_BIN } from '@product'

import { getDocument, updateDocumentData } from '../api'
import { readJsonObject } from '../data-input'
import { CliError, EXIT } from '../exit'
import { MARK, line } from '../io'
import type { Io } from '../io'
import { applySets, opsFromDataObject, parseSetFlag } from '../patch'
import type { SetOp } from '../patch'
import type { CommonOptions } from './context'
import { emitJson, loadProjectContext, requireWriteKey } from './context'

/**
 * `edit <id>` — change specific fields in the draft. See `patch.ts` for why
 * this reads the current document before it writes: the API's PATCH replaces
 * `data` wholesale, and a caller that PATCHed only the fields it meant to
 * change would erase everything else the document held.
 */
export interface EditOptions extends CommonOptions {
  readonly set?: readonly string[] | undefined
  readonly data?: string | undefined
}

export async function editCommand(io: Io, id: string, options: EditOptions): Promise<void> {
  const context = loadProjectContext(io, options)
  const writeKey = requireWriteKey(context)

  const ops: SetOp[] = (options.set ?? []).map(parseSetFlag)
  if (options.data !== undefined) {
    ops.push(...opsFromDataObject(readJsonObject(context.root, options.data, '--data')))
  }

  if (ops.length === 0) {
    throw new CliError(
      'Nothing to change.',
      EXIT.error,
      'Pass --set field=value (repeatable), e.g. --set price=42 --set seo.title=Hello, ' +
        'or --data \'{"path.to.field": value}\'.',
    )
  }

  const client = { baseUrl: context.apiBaseUrl, writeKey }
  const current = await getDocument(client, id)
  const merged = applySets(current.data, ops)
  const updated = await updateDocumentData(client, id, merged)

  if (options.json === true) {
    emitJson(io, {
      ok: true,
      command: 'edit',
      changed: ops.map((op) => op.path.join('.')),
      document: updated,
    })
    return
  }

  io.write(line(MARK.done, `Updated ${updated.type}/${updated.slug} — ${updated.id} (draft)`))
  for (const op of ops) io.write(line(MARK.info, op.path.join('.')))
  io.write(`\nStill a draft. Run \`${CLI_BIN} publish ${updated.id}\` to put it live.\n`)
}
