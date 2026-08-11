import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CLI_BIN, ENV, TYPES_FILE } from '@product'

import { fetchProjectModel } from '../api'
import type {
  ModelContentTypeDefinition,
  ModelFieldDefinition,
  ModelObjectDefinition,
  ProjectModel,
} from '../api'
import type {
  BlockDefinition,
  ContentTypeDefinition,
  FieldDefinition,
  FieldKind,
  ObjectDefinition,
} from '../../../sdk/src/definitions'
import {
  BLOCK_LIST,
  CONTENT_TYPE_LIST,
  FIELD_KINDS,
  OBJECT_LIST,
} from '../../../sdk/src/definitions'
import { generateTypes } from '../../../sdk/src/typegen'
import type { TypegenInput } from '../../../sdk/src/typegen'
import { resolveRoot } from '../detect'
import { pluralise } from '../format'
import { MARK, line } from '../io'
import type { Io } from '../io'
import { loadPartialContext } from './context'
import type { CommonOptions } from './context'
import { emitJson } from './context'

/**
 * `types` — §11's "רענון טייפים".
 *
 * WHAT CHANGED IN M10, AND WHY IT HAD TO
 * --------------------------------------
 * This used to generate from the constants compiled into the CLI, on the
 * reasoning that "types describe the schema this CLI version ships, not the
 * contents of any one project". That reasoning died the moment a project could
 * register its own objects: two projects on the same CLI version now have
 * different models, and a generator that ignores the project would hand an agent
 * a types file describing a schema its own site does not have — the exact silent
 * mismatch typegen exists to prevent.
 *
 * So it asks the project first, and falls back to the compiled definitions when
 * there is no project configured or the API cannot be reached. The fallback is
 * not a nicety: `init` generates types before it has finished wiring anything,
 * and an agent scaffolding offline must still get a file it can compile against.
 * Which path was taken is always reported, never inferred.
 */
export interface TypesOptions extends CommonOptions {
  /** Skip the network entirely and generate from the compiled definitions. */
  readonly local?: boolean | undefined
}

/** How the definitions that produced the file were obtained. */
export type TypesSource = 'project' | 'built-in'

const KNOWN_KINDS: ReadonlySet<string> = new Set(FIELD_KINDS)

/**
 * Narrows a definition that came off the wire into the generator's input type.
 *
 * A kind this build has never heard of is dropped, with the field it is on: the
 * alternative is emitting a type referencing something the generator cannot
 * name, which fails to compile in the CUSTOMER's project. Dropping is visible
 * (the field is simply absent from their types) and recoverable (upgrade the
 * CLI); emitting garbage is neither.
 */
function toFieldDefinition(field: ModelFieldDefinition): FieldDefinition | undefined {
  if (!KNOWN_KINDS.has(field.kind)) return undefined
  return {
    name: field.name,
    kind: field.kind as FieldKind,
    required: field.required,
    ...(field.repeated === true ? { repeated: true } : {}),
    ...(field.options === undefined ? {} : { options: field.options }),
    ...(field.of === undefined ? {} : { of: field.of }),
    // `blocks` and `to` are not decoration. `elementType` builds the block union
    // from `blocks`, so dropping it generated `sections?: readonly never[]` —
    // a field the customer can read but can never assign to. It was invisible
    // while types came from the compiled constants and became reachable the
    // moment they started coming from the project.
    ...(field.blocks === undefined ? {} : { blocks: field.blocks }),
    ...(field.to === undefined ? {} : { to: field.to }),
    ...(field.deprecated === true ? { deprecated: true } : {}),
  }
}

function toObjectDefinition(object: ModelObjectDefinition): ObjectDefinition {
  return {
    key: object.key,
    title: object.title,
    fields: object.fields.flatMap((field) => {
      const parsed = toFieldDefinition(field)
      return parsed === undefined ? [] : [parsed]
    }),
  }
}

/**
 * Every type the project holds, whatever its key.
 *
 * This used to skip anything outside the four-key union, because that union was
 * the whole vocabulary and a stray key could only be corruption. Since M11 a
 * project defines its own types, and skipping them would mean the one command
 * whose entire job is "describe this project to the compiler" quietly omitted
 * most of the project.
 */
function toContentTypeDefinition(type: ModelContentTypeDefinition): ContentTypeDefinition {
  const base = toObjectDefinition(type)
  return {
    key: type.key,
    title: base.title,
    titleField: type.titleField,
    slugField: type.slugField,
    fields: base.fields,
  }
}

function toTypegenInput(model: ProjectModel, blocks: readonly BlockDefinition[]): TypegenInput {
  return {
    contentTypes: model.types.map(toContentTypeDefinition),
    blocks,
    objects: model.objects.map(toObjectDefinition),
  }
}

const BUILT_IN: TypegenInput = {
  contentTypes: CONTENT_TYPE_LIST,
  blocks: BLOCK_LIST,
  objects: OBJECT_LIST,
}

/**
 * Fetches the project's model, or returns `undefined` for every reason a
 * fallback is legitimate: no project yet, `--local`, or an unreachable API.
 *
 * A failure here is deliberately NOT fatal. `types` is the command an agent runs
 * to unblock its compiler, and turning a flaky network into "your build has no
 * types" would be the worst possible moment to be strict.
 */
async function fetchModel(io: Io, options: TypesOptions): Promise<ProjectModel | undefined> {
  if (options.local === true) return undefined

  const partial = loadPartialContext(io, options)
  const readKey = partial.value(ENV.readKey)
  if (readKey === undefined) return undefined

  try {
    return await fetchProjectModel({ baseUrl: partial.apiBaseUrl, key: readKey })
  } catch {
    return undefined
  }
}

export async function typesCommand(io: Io, options: TypesOptions): Promise<void> {
  const root = resolveRoot(io.cwd, options.cwd)
  const path = join(root, TYPES_FILE)

  const model = await fetchModel(io, options)
  const input = model === undefined ? BUILT_IN : toTypegenInput(model, BLOCK_LIST)
  const source: TypesSource = model === undefined ? 'built-in' : 'project'
  const contents = generateTypes(input)

  const existed = existsSync(path)
  const unchanged = existed && readFileSync(path, 'utf8') === contents
  if (!unchanged) writeFileSync(path, contents, 'utf8')

  const keys = input.contentTypes.map((definition) => definition.key)
  const objects = (input.objects ?? []).map((definition) => definition.key)
  const outcome = unchanged ? 'unchanged' : existed ? 'updated' : 'created'

  if (options.json === true) {
    emitJson(io, {
      ok: true,
      command: 'types',
      path,
      outcome,
      source,
      contentTypes: keys,
      objects,
    })
    return
  }

  io.write(
    line(
      MARK.done,
      `${unchanged ? 'Types up to date' : 'Generated types'} → ${TYPES_FILE} ` +
        `(${pluralise(keys.length, 'type')}: ${keys.join(', ')}` +
        `${objects.length === 0 ? '' : ` · ${pluralise(objects.length, 'object')}: ${objects.join(', ')}`})`,
    ),
  )

  if (source === 'built-in' && options.local !== true) {
    io.write(
      `  Generated from the built-in schema — this project’s own model was not read.\n` +
        `  Run \`${CLI_BIN} init\` or \`${CLI_BIN} link\` first if these types look wrong.\n`,
    )
  }
}
