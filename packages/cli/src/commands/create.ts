import { createDocument } from '../api'
import { readJsonObject } from '../data-input'
import { MARK, line } from '../io'
import type { Io } from '../io'
import type { CommonOptions } from './context'
import { emitJson, loadProjectContext, requireWriteKey } from './context'

/**
 * `create` — a new draft. It is never published by this command: §13's own
 * editor treats "save" and "publish" as two separate, deliberate actions, and
 * an agent creating content should get the same safety — nothing an agent
 * writes reaches a visitor until `publish` is called explicitly.
 */
export interface CreateOptions extends CommonOptions {
  readonly type: string
  readonly slug: string
  readonly data?: string | undefined
  readonly locale?: string | undefined
}

export async function createCommand(io: Io, options: CreateOptions): Promise<void> {
  const context = loadProjectContext(io, options)
  const writeKey = requireWriteKey(context)

  const data = options.data === undefined ? {} : readJsonObject(context.root, options.data, '--data')

  const document = await createDocument(
    { baseUrl: context.apiBaseUrl, writeKey },
    { type: options.type, slug: options.slug, data, locale: options.locale },
  )

  if (options.json === true) {
    emitJson(io, { ok: true, command: 'create', document })
    return
  }

  io.write(line(MARK.done, `Created ${document.type}/${document.slug} — ${document.id} (draft)`))
}
