import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { TYPES_FILE } from '@product'

import { CONTENT_TYPE_LIST } from '../../../sdk/src/definitions'
import { generateTypes } from '../../../sdk/src/typegen'
import { resolveRoot } from '../detect'
import { pluralise } from '../format'
import { MARK, line } from '../io'
import type { Io } from '../io'
import type { CommonOptions } from './context'
import { emitJson } from './context'

/**
 * `types` — §11's "רענון טייפים".
 *
 * Offline and deterministic. The generator is pure, so running this on an
 * unchanged project rewrites nothing and produces no diff; that is what makes
 * it safe to wire into a `postinstall` or a pre-commit hook. It also needs no
 * project configuration at all: types describe the schema this CLI version
 * ships, not the contents of any one project, so an agent can generate them
 * before the API has ever been contacted.
 */
export type TypesOptions = CommonOptions

export function typesCommand(io: Io, options: TypesOptions): void {
  const root = resolveRoot(io.cwd, options.cwd)
  const path = join(root, TYPES_FILE)
  const contents = generateTypes()

  const existed = existsSync(path)
  const unchanged = existed && readFileSync(path, 'utf8') === contents
  if (!unchanged) writeFileSync(path, contents, 'utf8')

  const keys = CONTENT_TYPE_LIST.map((definition) => definition.key)

  if (options.json === true) {
    emitJson(io, {
      ok: true,
      command: 'types',
      path,
      outcome: unchanged ? 'unchanged' : existed ? 'updated' : 'created',
      contentTypes: keys,
    })
    return
  }

  io.write(
    line(
      MARK.done,
      `${unchanged ? 'Types up to date' : 'Generated types'} → ${TYPES_FILE} ` +
        `(${pluralise(keys.length, 'type')}: ${keys.join(', ')})`,
    ),
  )
}
