import type { FilterCondition, QueryOptions } from './types'

/**
 * M13 (PRD-v2 §5) — turning the SDK's query options into URL parameters.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * It is the one piece of M13 the customer's code touches directly, and the one
 * whose output has to match the server's parser exactly. A mismatch of one
 * character is not a type error and not a runtime error — it is a 422 on their
 * site, or worse, a filter the server never saw and silently did not apply.
 * Keeping it out of `client.ts` is what lets it be tested without a fetch.
 *
 * THE OUTPUT IS DELIBERATELY FLAT
 * -------------------------------
 * `RequestSpec.search` is a flat record, and `filter[visibility][ne]` is just a
 * key with brackets in it. Nothing needs a nested serialiser, and `URLSearchParams`
 * percent-encodes the brackets on the way out, which the server's `URLSearchParams`
 * decodes back before matching. Both sides use the platform, so neither has an
 * escaping scheme of its own to get wrong.
 */

const OPERATORS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in'] as const

/**
 * The operator map, widened for lookup — or `null` when the condition is the
 * bare-value shorthand.
 *
 * A type predicate cannot do this. `FilterCondition` is a union whose `in`
 * member has no `eq`, so narrowing to "some object" still leaves TypeScript
 * unable to index it by an arbitrary operator. Spreading into an explicit
 * `Record` says what is meant — the keys are checked against `OPERATORS` on the
 * next line anyway — and keeps this file free of the `any` the guards forbid.
 */
function operatorMap(value: FilterCondition): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || value instanceof Date) return null
  return { ...value }
}

/**
 * A single comparison value as the wire wants it.
 *
 * A `Date` becomes ISO-8601, which is what the server's timestamp gate accepts.
 * A caller reaching for `new Date()` on a `date` field should almost always
 * write the string `'now'` instead — see `FilterCondition` — but serialising a
 * Date they did pass is better than stringifying it to "Wed Aug 12 2026 …",
 * which no gate matches and which would silently return nothing.
 */
function scalar(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

/**
 * `filter`, `sort`, `fields` and `expand` as search parameters.
 *
 * Empty inputs produce no key at all rather than an empty one: `?fields=` would
 * reach the server as a present-but-blank parameter, and "return no fields" is
 * not what a caller who passed `[]` meant.
 */
export function queryParams(options: QueryOptions): Record<string, string> {
  const params: Record<string, string> = {}

  for (const [field, condition] of Object.entries(options.filter ?? {})) {
    if (condition === undefined) continue

    const operators = operatorMap(condition)
    if (operators === null) {
      // The shorthand. `{ status: 'active' }` is `eq`, which is most filters.
      params[`filter[${field}]`] = scalar(condition)
      continue
    }

    for (const operator of OPERATORS) {
      const value = operators[operator]
      if (value === undefined) continue
      params[`filter[${field}][${operator}]`] =
        operator === 'in' && Array.isArray(value)
          ? value.map(scalar).join(',')
          : scalar(value)
    }
  }

  const sort = options.sort
  if (sort !== undefined) {
    const keys = typeof sort === 'string' ? [sort] : sort
    if (keys.length > 0) params['sort'] = keys.join(',')
  }

  if (options.fields !== undefined && options.fields.length > 0) {
    params['fields'] = options.fields.join(',')
  }

  if (options.expand !== undefined && options.expand.length > 0) {
    params['expand'] = options.expand.join(',')

    /*
     * An expanded field left out of the projection is refused by the API, and
     * rightly — the two parameters contradict each other. But a caller who wrote
     * `{ fields: ['title'], expand: ['featured'] }` meant "title plus the
     * resolved featured", not "please fail". Adding it here turns a 422 the
     * customer has to debug into the thing they asked for.
     */
    if (options.fields !== undefined && options.fields.length > 0) {
      const projected = new Set(options.fields)
      for (const name of options.expand) projected.add(name)
      params['fields'] = [...projected].join(',')
    }
  }

  return params
}
