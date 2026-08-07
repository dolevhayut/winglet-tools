import { CliError, EXIT } from './exit'

/**
 * `edit`'s patch semantics, modelled on Sanity's mutation `set` — not a naive
 * whole-object replace, and not a client-computed deep merge either.
 *
 * WHY NOT REPLACE
 * ----------------
 * The API's `PATCH /documents/:id` replaces `data` wholesale; it does not
 * merge. The studio itself shipped this exact bug once (see `saveMerged` in
 * the private repo's editor): a form that only knew about its own fields wrote
 * back an object missing `custom`, `seo` and `sections`, silently deleting
 * whatever an agent — or the seed — had put there. `edit` exists specifically
 * so a CLI caller does not repeat that mistake: it always reads the current
 * draft first and writes back the whole thing, changed only at the paths named.
 *
 * WHY NOT A DEEP MERGE
 * ---------------------
 * A merge cannot express "replace this array" or "remove this key by setting
 * it to something the merge would instead combine with" — and it is surprising
 * about which side wins on a type mismatch. A named path with an explicit
 * value has one meaning: THIS field becomes exactly this value, and nothing
 * else in the document moves.
 *
 * `--set field=value` and `--data '{"path.to.field": value}'` are the same
 * operation through two syntaxes — the latter is for when a value itself needs
 * to be structured (arrays, nested objects) or there are many fields at once.
 */

export interface SetOp {
  readonly path: readonly string[]
  readonly value: unknown
}

function parsePath(raw: string): readonly string[] {
  const path = raw
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
  if (path.length === 0) {
    throw new CliError(`Empty field path in "${raw}".`, EXIT.error)
  }
  return path
}

/**
 * `price=42` becomes the number `42`; `title=Hello` stays the string `"Hello"`
 * because it does not parse as JSON. `--set` is for a human or an agent typing
 * a flag, not for round-tripping a value that was already JSON — that case is
 * what `--data` is for.
 */
export function parseSetValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

export function parseSetFlag(flag: string): SetOp {
  const eq = flag.indexOf('=')
  if (eq <= 0) {
    throw new CliError(
      `Invalid --set "${flag}" — expected field=value, e.g. --set price=42 or --set seo.title=Hello.`,
      EXIT.error,
    )
  }
  return { path: parsePath(flag.slice(0, eq)), value: parseSetValue(flag.slice(eq + 1)) }
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Sets one path on an immutable copy of `base`. Every ancestor object not
 * named by the path is returned untouched (same reference); only the spine
 * leading to the changed field is copied. Setting through a path segment that
 * already holds a non-object (a string, a number, a list) is a hard error
 * rather than a silent overwrite — that is very likely a typo'd path.
 */
export function applySet(
  base: Readonly<Record<string, unknown>>,
  path: readonly string[],
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = path
  if (head === undefined) return { ...base }

  if (rest.length === 0) return { ...base, [head]: value }

  const existing = base[head]
  if (existing !== undefined && !isPlainObject(existing)) {
    throw new CliError(
      `Cannot set "${path.join('.')}" — "${head}" already holds a ${
        Array.isArray(existing) ? 'list' : typeof existing
      }, not an object.`,
      EXIT.error,
      `Replace the whole field instead: --set ${head}='${JSON.stringify({ [rest.join('.')]: value })}'`,
    )
  }

  return { ...base, [head]: applySet(isPlainObject(existing) ? existing : {}, rest, value) }
}

export function applySets(
  base: Readonly<Record<string, unknown>>,
  ops: readonly SetOp[],
): Record<string, unknown> {
  return ops.reduce<Record<string, unknown>>((acc, op) => applySet(acc, op.path, op.value), { ...base })
}

/** `--data`: a flat object whose own keys are dot-paths, applied the same way as `--set`. */
export function opsFromDataObject(data: Readonly<Record<string, unknown>>): readonly SetOp[] {
  return Object.entries(data).map(([key, value]) => ({ path: parsePath(key), value }))
}
