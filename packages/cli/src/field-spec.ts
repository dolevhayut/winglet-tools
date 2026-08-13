import { OBJECT_FIELD_KINDS } from '../../sdk/src/definitions'

import type { ModelFieldDefinition } from './api'
import { CliError, EXIT } from './exit'

/**
 * The compact field syntax `--field` accepts:
 *
 *   label:string!            required string
 *   price:number             optional number
 *   tags:stringList[]        optional repeated string
 *   category:select=room|spa optional select, closed to two values
 *
 * WHY A MINI-SYNTAX AND NOT JUST JSON
 * -----------------------------------
 * `--fields '@shape.json'` exists too, and is the right form for a shape an
 * agent is generating anyway. But defining an object is often the FIRST thing
 * that happens in a project, before any file worth writing exists, and
 * `objects add faq --field question:string! --field answer:text!` is one line an
 * agent can emit — and a person can read in a review — without a heredoc. The
 * two forms produce the same request.
 *
 * The grammar is deliberately tiny and total: anything it cannot parse is an
 * error naming the exact token, never a silently-dropped modifier.
 */

const KINDS: ReadonlySet<string> = new Set(OBJECT_FIELD_KINDS)

const SPEC = /^([A-Za-z][A-Za-z0-9_]*):([A-Za-z]+)(\[\])?(!)?(?:=(.*))?$/

/**
 * `gallery:object<galleryImage>[]` — a field carrying a registered shape.
 *
 * MOVED HERE IN M18, from the content-type command that used to own it. Once an
 * object could contain another object, `objects add` needed the same notation
 * `types add` had, and two parsers for one grammar is two chances to disagree
 * about it. The angle brackets are what `objects list` already prints, so what
 * an agent reads back is what it can pass straight in.
 */
const OBJECT_SPEC = /^([A-Za-z][A-Za-z0-9_]*):object<([A-Za-z][A-Za-z0-9_]*)>(\[\])?(!)?$/

export function parseFieldSpec(raw: string): ModelFieldDefinition {
  const nested = OBJECT_SPEC.exec(raw.trim())
  if (nested !== null) {
    const [, name, of, repeated, required] = nested
    if (name !== undefined && of !== undefined) {
      return {
        name,
        kind: 'object',
        of,
        required: required === '!',
        ...(repeated === '[]' ? { repeated: true } : {}),
      }
    }
  }

  const match = SPEC.exec(raw.trim())
  if (match === null) {
    throw new CliError(
      `Cannot read the field "${raw}".`,
      EXIT.error,
      'Expected name:kind, optionally with [] for a list, ! for required, and\n' +
        '=a|b for select options. For example: price:number! or category:select=room|spa',
    )
  }

  const [, name, kind, repeated, required, options] = match
  if (name === undefined || kind === undefined) {
    // Unreachable while the regex has both groups; present so the narrowing is
    // real rather than asserted.
    throw new CliError(`Cannot read the field "${raw}".`, EXIT.error)
  }

  if (!KINDS.has(kind)) {
    throw new CliError(
      `"${kind}" is not a field kind.`,
      EXIT.error,
      `Known kinds: ${[...KINDS].join(', ')}.\n` +
        'An object field names the shape it carries: gallery:object<galleryImage>[].',
    )
  }

  if (kind === 'object') {
    throw new CliError(
      `The object field "${name}" does not say which shape it carries.`,
      EXIT.error,
      `Write it as ${name}:object<shapeKey>, or ${name}:object<shapeKey>[] for a list.`,
    )
  }

  const values = options === undefined ? [] : options.split('|').filter((value) => value.length > 0)
  if (kind === 'select' && values.length === 0) {
    throw new CliError(
      `The select field "${name}" has no options.`,
      EXIT.error,
      `Write it as ${name}:select=first|second.`,
    )
  }
  if (kind !== 'select' && values.length > 0) {
    throw new CliError(
      `Only a select field takes options, and "${name}" is ${kind}.`,
      EXIT.error,
    )
  }

  return {
    name,
    kind,
    required: required === '!',
    ...(repeated === '[]' ? { repeated: true } : {}),
    ...(values.length > 0 ? { options: values } : {}),
  }
}

/** Renders one field back into the syntax above — used by `objects list`. */
export function formatFieldSpec(field: ModelFieldDefinition): string {
  const list = field.repeated === true ? '[]' : ''
  const required = field.required ? '!' : ''
  const options =
    field.options === undefined || field.options.length === 0
      ? ''
      : `=${field.options.join('|')}`
  const target = field.of === undefined ? '' : `<${field.of}>`
  return `${field.name}:${field.kind}${target}${list}${required}${options}`
}
