import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { CliError, EXIT } from './exit'

/**
 * Parses a `--data` flag: a literal JSON object, or `@path` to read one from a
 * file relative to the project root.
 *
 * Deliberately no stdin form. `program.ts` documents the invariant this package
 * holds for every command — "NOTHING HERE IS INTERACTIVE... no code path in
 * this package reads stdin" — precisely so an agent's invocation is always a
 * single, complete, retryable argument list, never a pipe that can hang waiting
 * for a byte that never comes. `@file` covers the same need (a payload too
 * large or too structured for one shell argument) without that risk.
 */
export function readJsonObject(
  root: string,
  raw: string,
  flag: string,
): Readonly<Record<string, unknown>> {
  const text = raw.startsWith('@') ? readFileFor(root, raw.slice(1), flag) : raw

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new CliError(
      `${flag} is not valid JSON.`,
      EXIT.error,
      cause instanceof Error ? cause.message : String(cause),
    )
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`${flag} must be a JSON object.`, EXIT.error)
  }
  return parsed as Readonly<Record<string, unknown>>
}

function readFileFor(root: string, path: string, flag: string): string {
  const full = isAbsolute(path) ? path : join(root, path)
  try {
    return readFileSync(full, 'utf8')
  } catch (cause) {
    throw new CliError(
      `Could not read ${full} for ${flag}.`,
      EXIT.error,
      cause instanceof Error ? cause.message : String(cause),
    )
  }
}
