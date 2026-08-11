import { queryContent } from '../api'
import { CliError, EXIT } from '../exit'
import type { Io } from '../io'
import type { CommonOptions } from './context'
import { emitJson, loadProjectContext } from './context'

/**
 * `query <type>` — M13 (PRD-v2 §5) from the command line.
 *
 * WHY THIS IS NOT A FLAG ON `list`
 * --------------------------------
 * `list` reads `/v1/documents` with a WRITE key: it is the management view, it
 * shows drafts, and it is what an agent uses to find something before changing
 * it. This reads `/v1/content` with a READ key — the endpoint the customer's
 * SITE calls. They answer different questions, and an agent checking whether a
 * filter behaves needs the second one: predicting a live page from a view that
 * includes drafts is how you ship a filter that works in the terminal and not on
 * the site.
 *
 * WHY IT EXISTS AT ALL
 * --------------------
 * The hard constraint: the agent is the primary worker and the CLI is its whole
 * interface. Without this, `filter[sleeps][gt]=9` can only be tried by writing
 * it into the customer's site and reloading — which is exactly the loop the CLI
 * exists to remove.
 *
 * Always JSON, like `list`, and for the same reason: nobody types this at a
 * terminal to read prose.
 */

export interface QueryOptions extends CommonOptions {
  readonly filter: readonly string[]
  readonly sort?: string | undefined
  readonly fields?: string | undefined
  readonly expand?: string | undefined
  readonly limit?: string | undefined
  readonly offset?: string | undefined
  readonly status?: string | undefined
}

/**
 * `--filter 'visibility:ne=hidden'` → `filter[visibility][ne]`.
 *
 * A COLON FOR THE OPERATOR, not the API's brackets. `--filter
 * 'filter[visibility][ne]=hidden'` would be more literal and is unusable in
 * practice: every shell this runs in treats `[` as a glob, so the operator would
 * have to quote it correctly every time and curl would need `-g` besides. The
 * colon form is the same shape `--field` and `sort` already use here.
 *
 * Without an operator, `--filter 'status=active'` is equality — the common case.
 */
const FILTER_SPEC = /^([A-Za-z_][A-Za-z0-9_]*)(?::([a-z]+))?=(.*)$/

function parseFilters(specs: readonly string[]): Record<string, string> {
  const params: Record<string, string> = {}

  for (const raw of specs) {
    const match = FILTER_SPEC.exec(raw.trim())
    if (match === null) {
      throw new CliError(
        `Cannot read the filter "${raw}".`,
        EXIT.error,
        "Use field=value, or field:operator=value — for example 'visibility:ne=hidden',\n" +
          "'sleeps:gte=4', 'endDate:gte=now', or 'kind:in=cabin,suite'.",
      )
    }
    const [, field, operator, value] = match
    if (field === undefined || value === undefined) continue
    // The server validates the operator and names the alternatives, so this does
    // not keep its own list — one vocabulary, in one place.
    params[operator === undefined ? `filter[${field}]` : `filter[${field}][${operator}]`] = value
  }

  return params
}

export async function queryCommand(io: Io, typeKey: string, options: QueryOptions): Promise<void> {
  const context = loadProjectContext(io, options)

  const search: Record<string, string> = {
    ...parseFilters(options.filter),
    ...(options.sort === undefined ? {} : { sort: options.sort }),
    ...(options.fields === undefined ? {} : { fields: options.fields }),
    ...(options.expand === undefined ? {} : { expand: options.expand }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.offset === undefined ? {} : { offset: options.offset }),
    ...(options.status === undefined ? {} : { status: options.status }),
  }

  const result = await queryContent(context.apiBaseUrl, context.readKey, typeKey, search)

  emitJson(io, {
    ok: true,
    command: 'query',
    project: { id: context.projectId },
    type: result.type,
    // The URL the API actually answered, so a filter that behaved unexpectedly
    // can be pasted into the SDK or a browser without being reconstructed.
    query: search,
    total: result.total,
    ...(result.expanded === undefined ? {} : { expanded: result.expanded }),
    documents: result.documents,
  })
}
