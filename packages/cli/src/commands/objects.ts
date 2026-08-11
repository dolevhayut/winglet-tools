import { CLI_BIN } from '@product'

import {
  createProjectObject,
  deleteProjectObject,
  fetchProjectModel,
  listProjectObjects,
  updateProjectObject,
} from '../api'
import type { ModelFieldDefinition, ModelObjectDefinition } from '../api'
import { readJsonValue } from '../data-input'
import { CliError, EXIT } from '../exit'
import { formatFieldSpec, parseFieldSpec } from '../field-spec'
import { pluralise } from '../format'
import { MARK, line } from '../io'
import type { Io } from '../io'
import type { CommonOptions } from './context'
import { emitJson, loadProjectContext, requireWriteKey } from './context'
import type { ProjectContext } from './context'

/**
 * `objects` — the project's registry of reusable field shapes (M10).
 *
 * This is the command that makes the content model something an agent can
 * change. Everything the studio will render for an `array<object>` is defined
 * here first, from one line at a terminal, with no browser anywhere in the loop.
 *
 * `list` and `show` are always JSON, matching `list`/`get` for documents:
 * nothing about a schema dump reads better as prose, and an agent should not
 * have to remember a flag to parse it. `add`, `set` and `rm` print a sentence
 * and take `--json`, matching `create`/`publish`/`delete`.
 */

export interface ObjectsListOptions extends CommonOptions {
  /** Include the content types too, so one call answers "what is this project". */
  readonly types?: boolean | undefined
}

export interface ObjectsAddOptions extends CommonOptions {
  readonly title?: string | undefined
  readonly field: readonly string[]
  readonly fields?: string | undefined
}

export interface ObjectsSetOptions extends ObjectsAddOptions {
  readonly rename?: string | undefined
}

export type ObjectsRmOptions = CommonOptions

/* ── shared ───────────────────────────────────────────────────────────────── */

/** Reading the model takes the read key; changing it takes the write key. */
function readClient(context: ProjectContext): { baseUrl: string; key: string } {
  return { baseUrl: context.apiBaseUrl, key: context.readKey }
}

function writeClient(context: ProjectContext): { baseUrl: string; key: string } {
  return { baseUrl: context.apiBaseUrl, key: requireWriteKey(context) }
}

/**
 * Collects the field list from whichever flag was used.
 *
 * `--fields` wins outright rather than merging with `--field`: a caller who
 * passed both meant one of them, and quietly concatenating two sources would
 * produce a shape nobody wrote.
 */
function collectFields(
  root: string,
  options: ObjectsAddOptions,
): readonly ModelFieldDefinition[] | undefined {
  if (options.fields !== undefined) {
    const value = readJsonValue(root, options.fields, '--fields')
    if (!Array.isArray(value)) {
      throw new CliError('--fields must be a JSON array of field definitions.', EXIT.error)
    }
    return value.map((entry, index) => parseJsonField(entry, index))
  }
  if (options.field.length === 0) return undefined
  return options.field.map(parseFieldSpec)
}

function parseJsonField(entry: unknown, index: number): ModelFieldDefinition {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new CliError(`--fields[${String(index)}] is not an object.`, EXIT.error)
  }
  const record = entry as Record<string, unknown>
  const name = record['name']
  const kind = record['kind']
  if (typeof name !== 'string' || typeof kind !== 'string') {
    throw new CliError(`--fields[${String(index)}] needs a "name" and a "kind".`, EXIT.error)
  }
  return {
    name,
    kind,
    required: record['required'] === true,
    ...(record['repeated'] === true ? { repeated: true } : {}),
    ...(Array.isArray(record['options'])
      ? { options: record['options'].filter((o): o is string => typeof o === 'string') }
      : {}),
  }
}

function summarise(object: ModelObjectDefinition): string {
  return `${object.key} — ${object.fields.map(formatFieldSpec).join(', ')}`
}

/* ── list ─────────────────────────────────────────────────────────────────── */

export async function objectsListCommand(io: Io, options: ObjectsListOptions): Promise<void> {
  const context = loadProjectContext(io, options)

  if (options.types === true) {
    const model = await fetchProjectModel(readClient(context))
    emitJson(io, {
      ok: true,
      command: 'objects list',
      project: { id: context.projectId },
      types: model.types,
      objects: model.objects,
    })
    return
  }

  const objects = await listProjectObjects(readClient(context))
  emitJson(io, {
    ok: true,
    command: 'objects list',
    project: { id: context.projectId },
    total: objects.length,
    objects,
  })
}

/* ── add ──────────────────────────────────────────────────────────────────── */

export async function objectsAddCommand(
  io: Io,
  key: string,
  options: ObjectsAddOptions,
): Promise<void> {
  const context = loadProjectContext(io, options)
  const fields = collectFields(context.root, options)

  if (fields === undefined || fields.length === 0) {
    throw new CliError(
      `"${key}" needs at least one field.`,
      EXIT.error,
      `For example: ${CLI_BIN} objects add ${key} --field title:string! --field body:text`,
    )
  }

  const object = await createProjectObject(writeClient(context), {
    key,
    title: options.title ?? key,
    fields,
  })

  if (options.json === true) {
    emitJson(io, { ok: true, command: 'objects add', object })
    return
  }
  io.write(
    line(MARK.done, `Registered "${object.key}" (${pluralise(object.fields.length, 'field')})`),
  )
  io.write(`  ${summarise(object)}\n`)
}

/* ── set ──────────────────────────────────────────────────────────────────── */

export async function objectsSetCommand(
  io: Io,
  key: string,
  options: ObjectsSetOptions,
): Promise<void> {
  const context = loadProjectContext(io, options)
  const fields = collectFields(context.root, options)

  if (fields === undefined && options.rename === undefined) {
    throw new CliError(
      'Nothing to change.',
      EXIT.error,
      `Pass --rename <title>, or --field/--fields with the FULL field list.\n` +
        'Changes are additive: existing fields may be reordered but not removed,\n' +
        'retyped, or made required.',
    )
  }

  const object = await updateProjectObject(writeClient(context), key, {
    ...(options.rename === undefined ? {} : { title: options.rename }),
    ...(fields === undefined ? {} : { fields }),
  })

  if (options.json === true) {
    emitJson(io, { ok: true, command: 'objects set', object })
    return
  }
  io.write(line(MARK.done, `Updated "${object.key}"`))
  io.write(`  ${summarise(object)}\n`)
}

/* ── rm ───────────────────────────────────────────────────────────────────── */

export async function objectsRmCommand(
  io: Io,
  key: string,
  options: ObjectsRmOptions,
): Promise<void> {
  const context = loadProjectContext(io, options)
  const deleted = await deleteProjectObject(writeClient(context), key)

  if (options.json === true) {
    emitJson(io, { ok: true, command: 'objects rm', key, deleted })
    return
  }
  io.write(line(MARK.done, `Removed "${key}"`))
}
