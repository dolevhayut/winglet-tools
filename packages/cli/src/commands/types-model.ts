import { CLI_BIN } from '@product'

import {
  createProjectContentType,
  createProjectObject,
  deleteProjectContentType,
  fetchProjectModel,
  updateProjectContentType,
} from '../api'
import type { ModelContentTypeDefinition, ModelFieldDefinition } from '../api'
import { readJsonValue } from '../data-input'
import { CliError, EXIT } from '../exit'
import { formatFieldSpec, parseFieldSpec } from '../field-spec'
import { pluralise } from '../format'
import { MARK, line } from '../io'
import type { Io } from '../io'
import { TEMPLATE_NAMES, templateNamed } from '../templates'
import type { CommonOptions } from './context'
import { emitJson, loadProjectContext, requireWriteKey } from './context'
import type { ProjectContext } from './context'

/**
 * `types` (the model half) and `templates` — M11.
 *
 * The command that made the content model something an agent can change without
 * a browser. `objects` (M10) shapes the pieces; this shapes what a document IS.
 *
 * Reading is a read key, defining is a write key, and both have `--json`,
 * because the primary caller here has no eyes.
 */

export interface TypesListOptions extends CommonOptions {
  readonly objects?: boolean | undefined
}

export interface TypeAddOptions extends CommonOptions {
  readonly title?: string | undefined
  readonly titleField?: string | undefined
  readonly slugField?: string | undefined
  readonly field: readonly string[]
  readonly fields?: string | undefined
}

export interface TypeSetOptions extends TypeAddOptions {
  readonly rename?: string | undefined
}

export type TypeRmOptions = CommonOptions

export interface TemplateApplyOptions extends CommonOptions {
  readonly json?: boolean | undefined
}

function readClient(context: ProjectContext): { baseUrl: string; key: string } {
  return { baseUrl: context.apiBaseUrl, key: context.readKey }
}

function writeClient(context: ProjectContext): { baseUrl: string; key: string } {
  return { baseUrl: context.apiBaseUrl, key: requireWriteKey(context) }
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
    ...(typeof record['of'] === 'string' ? { of: record['of'] } : {}),
    ...(record['deprecated'] === true ? { deprecated: true } : {}),
  }
}

/**
 * `--field` accepts the compact syntax plus one form objects cannot use:
 * `gallery:object<galleryImage>[]`, naming the registered shape the field
 * carries. The angle brackets are the same notation `objects list` prints, so
 * what an agent reads back is what it can pass straight in.
 */
const OBJECT_SPEC = /^([A-Za-z][A-Za-z0-9_]*):object<([A-Za-z][A-Za-z0-9_]*)>(\[\])?(!)?$/

function parseTypeFieldSpec(raw: string): ModelFieldDefinition {
  const match = OBJECT_SPEC.exec(raw.trim())
  if (match === null) return parseFieldSpec(raw)

  const [, name, of, repeated, required] = match
  if (name === undefined || of === undefined) {
    throw new CliError(`Cannot read the field "${raw}".`, EXIT.error)
  }
  return {
    name,
    kind: 'object',
    of,
    required: required === '!',
    ...(repeated === '[]' ? { repeated: true } : {}),
  }
}

function collectFields(
  root: string,
  options: TypeAddOptions,
): readonly ModelFieldDefinition[] | undefined {
  if (options.fields !== undefined) {
    const value = readJsonValue(root, options.fields, '--fields')
    if (!Array.isArray(value)) {
      throw new CliError('--fields must be a JSON array of field definitions.', EXIT.error)
    }
    return value.map((entry, index) => parseJsonField(entry, index))
  }
  if (options.field.length === 0) return undefined
  return options.field.map(parseTypeFieldSpec)
}

function summarise(type: ModelContentTypeDefinition): string {
  return `${type.key} — ${type.fields.map(formatFieldSpec).join(', ')}`
}

/* ── list ─────────────────────────────────────────────────────────────────── */

export async function typesListCommand(io: Io, options: TypesListOptions): Promise<void> {
  const context = loadProjectContext(io, options)
  const model = await fetchProjectModel(readClient(context))

  emitJson(io, {
    ok: true,
    command: 'types list',
    project: { id: context.projectId },
    total: model.types.length,
    types: model.types,
    ...(options.objects === false ? {} : { objects: model.objects }),
  })
}

/* ── add ──────────────────────────────────────────────────────────────────── */

export async function typeAddCommand(
  io: Io,
  key: string,
  options: TypeAddOptions,
): Promise<void> {
  const context = loadProjectContext(io, options)
  const fields = collectFields(context.root, options)

  if (fields === undefined || fields.length === 0) {
    throw new CliError(
      `"${key}" needs at least one field.`,
      EXIT.error,
      `For example: ${CLI_BIN} types add room --field title:string! --field slug:string! \\\n` +
        '  --field gallery:object<galleryImage>[]',
    )
  }

  const type = await createProjectContentType(writeClient(context), {
    key,
    title: options.title ?? key,
    titleField: options.titleField ?? 'title',
    slugField: options.slugField ?? 'slug',
    fields,
  })

  if (options.json === true) {
    emitJson(io, { ok: true, command: 'types add', type })
    return
  }
  io.write(line(MARK.done, `Defined "${type.key}" (${pluralise(type.fields.length, 'field')})`))
  io.write(`  ${summarise(type)}\n`)
}

/* ── set ──────────────────────────────────────────────────────────────────── */

export async function typeSetCommand(
  io: Io,
  key: string,
  options: TypeSetOptions,
): Promise<void> {
  const context = loadProjectContext(io, options)
  const fields = collectFields(context.root, options)

  if (fields === undefined && options.rename === undefined) {
    throw new CliError(
      'Nothing to change.',
      EXIT.error,
      'Pass --rename <title>, or --field/--fields with the FULL field list.\n' +
        'Changes are additive: existing fields may be reordered but not removed,\n' +
        'retyped, or made required. To retire one, keep it and mark it deprecated.',
    )
  }

  const type = await updateProjectContentType(writeClient(context), key, {
    ...(options.rename === undefined ? {} : { title: options.rename }),
    ...(options.titleField === undefined ? {} : { titleField: options.titleField }),
    ...(options.slugField === undefined ? {} : { slugField: options.slugField }),
    ...(fields === undefined ? {} : { fields }),
  })

  if (options.json === true) {
    emitJson(io, { ok: true, command: 'types set', type })
    return
  }
  io.write(line(MARK.done, `Updated "${type.key}"`))
  io.write(`  ${summarise(type)}\n`)
}

/* ── rm ───────────────────────────────────────────────────────────────────── */

export async function typeRmCommand(io: Io, key: string, options: TypeRmOptions): Promise<void> {
  const context = loadProjectContext(io, options)
  const deleted = await deleteProjectContentType(writeClient(context), key)

  if (options.json === true) {
    emitJson(io, { ok: true, command: 'types rm', key, deleted })
    return
  }
  io.write(line(MARK.done, `Removed "${key}"`))
}

/* ── templates ────────────────────────────────────────────────────────────── */

export function templatesListCommand(io: Io): void {
  emitJson(io, {
    ok: true,
    command: 'templates list',
    templates: TEMPLATE_NAMES.map((name) => {
      const template = templateNamed(name)
      return {
        name,
        description: template?.description ?? '',
        types: template?.types.map((type) => type.key) ?? [],
        objects: template?.objects.map((object) => object.key) ?? [],
      }
    }),
  })
}

export interface TemplateOutcome {
  readonly objects: { readonly created: string[]; readonly skipped: string[] }
  readonly types: { readonly created: string[]; readonly skipped: string[] }
}

/**
 * Applies a template to the project the command is run in.
 *
 * IDEMPOTENT BY SKIPPING, NOT BY OVERWRITING. Anything the project already holds
 * is left exactly as it is and reported as skipped. That matters more than it
 * looks: two of the template shapes (`faq`, `galleryImage`) are seeded into every
 * project, `page` always exists, and a customer may have edited any of them.
 * Overwriting would silently discard their work in the name of "applying" a
 * template they asked to ADD.
 *
 * Objects first, then types — a type whose field points at a shape that does not
 * exist yet is refused by the API, correctly.
 */
export async function applyTemplate(
  context: ProjectContext,
  name: string,
): Promise<TemplateOutcome> {
  const template = templateNamed(name)
  if (template === undefined) {
    throw new CliError(
      `There is no template called "${name}".`,
      EXIT.error,
      `Available: ${TEMPLATE_NAMES.join(', ')}.`,
    )
  }

  const client = writeClient(context)
  const existing = await fetchProjectModel(readClient(context))
  const heldObjects = new Set(existing.objects.map((object) => object.key))
  const heldTypes = new Set(existing.types.map((type) => type.key))

  const outcome: TemplateOutcome = {
    objects: { created: [], skipped: [] },
    types: { created: [], skipped: [] },
  }

  for (const object of template.objects) {
    if (heldObjects.has(object.key)) {
      outcome.objects.skipped.push(object.key)
      continue
    }
    await createProjectObject(client, {
      key: object.key,
      title: object.title,
      fields: object.fields as readonly ModelFieldDefinition[],
    })
    outcome.objects.created.push(object.key)
  }

  for (const type of template.types) {
    if (heldTypes.has(type.key)) {
      outcome.types.skipped.push(type.key)
      continue
    }
    await createProjectContentType(client, {
      key: type.key,
      title: type.title,
      titleField: type.titleField,
      slugField: type.slugField,
      fields: type.fields as readonly ModelFieldDefinition[],
    })
    outcome.types.created.push(type.key)
  }

  return outcome
}

export async function templatesApplyCommand(
  io: Io,
  name: string,
  options: TemplateApplyOptions,
): Promise<void> {
  const context = loadProjectContext(io, options)
  const outcome = await applyTemplate(context, name)

  if (options.json === true) {
    emitJson(io, { ok: true, command: 'templates apply', template: name, ...outcome })
    return
  }

  io.write(
    line(
      MARK.done,
      `Applied "${name}" — ${pluralise(outcome.types.created.length, 'type')}, ` +
        `${pluralise(outcome.objects.created.length, 'object')}`,
    ),
  )
  if (outcome.types.created.length > 0) {
    io.write(`  types:   ${outcome.types.created.join(', ')}\n`)
  }
  if (outcome.objects.created.length > 0) {
    io.write(`  objects: ${outcome.objects.created.join(', ')}\n`)
  }

  // Never silent about what it left alone: a skipped name looks identical to a
  // created one from the outside, and the difference is whether the customer's
  // existing definition survived.
  const skipped = [...outcome.types.skipped, ...outcome.objects.skipped]
  if (skipped.length > 0) {
    io.write(`  already defined, left untouched: ${skipped.join(', ')}\n`)
  }
  io.write(`  Run \`${CLI_BIN} types\` to regenerate the type definitions.\n`)
}
