import { API_BASE_URL, CLI_BIN, ENV, PRODUCT_NAME } from '@product'
import { version as PACKAGE_VERSION } from '../package.json'
import { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'

/**
 * PRD §11 — the MCP server.
 *
 * WHAT THIS IS FOR
 * ----------------
 * MCP is the open standard for connecting an AI application to external systems
 * — Anthropic describes it as "a USB-C port for AI applications". Without it, an
 * agent that wants to change a headline has to read our REST docs, mint a key
 * and hand-roll a fetch. With it, the agent sees five typed tools and calls one.
 *
 * This complements the CLI rather than replacing it: `${CLI_BIN} init` is how a
 * site gets connected once, and these tools are how an agent edits content
 * afterwards, in conversation.
 *
 * DELIBERATELY A THIN SHELL over the same public REST API the SDK and studio
 * use. It holds no database credentials and reimplements no rules — scope
 * checks, quotas, limits and tenant isolation all stay in one place, on the
 * server. A second implementation of those rules is a second set of bugs.
 */

export interface ServerConfig {
  /** The project's write key. Never logged, never echoed back in a tool result. */
  readonly writeKey: string
  readonly apiBaseUrl: string
}

/** Reads config from the environment, using the same names the CLI writes. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig | null {
  const writeKey = env[ENV.writeKey]
  if (writeKey === undefined || writeKey.length === 0) return null
  return { writeKey, apiBaseUrl: env[ENV.apiUrl] ?? API_BASE_URL }
}

/* ── the REST client ──────────────────────────────────────────────────────── */

interface ApiFailure {
  readonly error?: { readonly code?: string; readonly message?: string }
}

async function call(
  config: ServerConfig,
  path: string,
  init: { method: string; body?: unknown } = { method: 'GET' },
): Promise<unknown> {
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${config.writeKey}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })

  const payload: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    // The §9 envelope is already a good explanation; pass it through rather than
    // inventing a second vocabulary the agent would have to learn.
    const failure = payload as ApiFailure
    throw new Error(
      `${failure.error?.code ?? String(response.status)}: ${failure.error?.message ?? 'Request failed.'}`,
    )
  }
  return payload
}

/** Every tool answers with JSON text — an agent parses it far better than prose. */
function result(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

/* ── patching ─────────────────────────────────────────────────────────────── */

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Sets one dot-path on an immutable copy of `base`. Only the spine leading to
 * the changed field is copied; every other branch keeps its reference.
 *
 * The same operation the CLI's `edit --set` performs. It is duplicated here
 * rather than imported because the CLI's copy throws `CliError` with a process
 * exit code, which is meaningless inside a tool call.
 */
function applySet(
  base: Readonly<Record<string, unknown>>,
  path: readonly string[],
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = path
  if (head === undefined) return { ...base }
  if (rest.length === 0) return { ...base, [head]: value }

  const existing = base[head]
  if (existing !== undefined && !isPlainObject(existing)) {
    throw new Error(
      `Cannot set "${path.join('.')}" — "${head}" holds a ${
        Array.isArray(existing) ? 'list' : typeof existing
      }, not an object. Set "${head}" as a whole instead.`,
    )
  }
  return { ...base, [head]: applySet(isPlainObject(existing) ? existing : {}, rest, value) }
}

/* ── the server ───────────────────────────────────────────────────────────── */

/**
 * A content type key, validated by SHAPE rather than by membership (M11).
 *
 * This was `z.enum(['page','post','product','collection'])`, which was correct
 * while those four were the whole vocabulary. A project now defines its own
 * types, and a closed enum here would have meant an agent connected over MCP
 * could see `accommodation` in `list_documents` and be unable to create one —
 * the tool refusing a value the same tool had just returned.
 *
 * The server is the authority on which keys exist and answers with the list when
 * it rejects one, so this only has to keep obviously malformed input out of a
 * URL segment.
 */
const TYPE_KEY = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/, 'Letters, digits and underscores; must start with a letter.')

export function buildServer(config: ServerConfig): McpServer {
  /*
   * The version is IMPORTED, not written here.
   *
   * It was the literal '0.1.0' and stayed that way through 0.2 and 0.3, because
   * nothing fails when it is wrong -- every tool works, every test passes, and
   * the only place it surfaces is the line an MCP client shows a human. So it
   * had been advertising 0.1.0 for a product published to npm as 0.3.1.
   *
   * A literal here cannot be kept true by anything except memory, so it will
   * drift again the next time the package is released. tsup inlines this at
   * build time, so there is no runtime file read and no chance of a container
   * reporting a version different from the code it is running.
   */
  const server = new McpServer({ name: PRODUCT_NAME.toLowerCase(), version: PACKAGE_VERSION })

  server.registerTool(
    'list_documents',
    {
      description:
        'List the content documents in this project. Use it to find what exists before changing anything. Optionally filter to one content type.',
      inputSchema: z.object({
        type: TYPE_KEY.optional().describe(
          'Restrict to one content type. Use list_content_types to see what this project defines.',
        ),
      }),
      // The hints are what let a client tell a lookup from a change to a live
      // site. Without them every tool looks equally consequential, so a client
      // either confirms all of them or none.
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ type }) => {
      const query = type === undefined ? '' : `?type=${encodeURIComponent(type)}`
      const body = (await call(config, `/documents${query}`)) as {
        documents: { id: string; type_key: string; slug: string; status: string }[]
      }
      // Trimmed on purpose: the full payload of every document would flood the
      // agent's context on a project of any size. `get_document` fetches one.
      return result(
        body.documents.map((d) => ({
          id: d.id,
          type: d.type_key,
          slug: d.slug,
          status: d.status,
        })),
      )
    },
  )

  server.registerTool(
    'list_content_types',
    {
      description:
        "List this project's content types and the reusable object shapes they use, with every field. Read this before creating or updating a document: the model belongs to the project, not to this server's version, so the available types and fields differ between projects. A type with \"cardinality\": \"single\" holds exactly one document — update the existing one rather than creating another, because create_document will be refused.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => result(await call(config, '/types')),
  )

  server.registerTool(
    'get_document',
    {
      description: 'Read one document in full, including every field, by its id.',
      inputSchema: z.object({ id: z.string().describe('The document id from list_documents.') }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ id }) => result(await call(config, `/documents/${encodeURIComponent(id)}`)),
  )

  server.registerTool(
    'create_document',
    {
      description:
        'Create a new document. It starts as a draft and is NOT on the live site until publish is called. Refused for a content type whose cardinality is "single" and which already holds a document — find that one with list_documents and update it instead.',
      inputSchema: z.object({
        type: TYPE_KEY.describe(
          'One of this project\'s content types — see list_content_types.',
        ),
        slug: z
          .string()
          .describe('URL segment: lowercase letters, digits and hyphens.'),
        data: z
          .record(z.string(), z.unknown())
          .describe('The fields. Shop-specific extras belong under a "custom" object.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ type, slug, data }) =>
      result(
        await call(config, '/documents', {
          method: 'POST',
          body: { type_key: type, slug, data },
        }),
      ),
  )

  server.registerTool(
    'update_document',
    {
      description:
        'Change specific fields of a document. This edits the DRAFT only — the live site is untouched until publish is called. Pass ONLY the fields you are changing, keyed by dot path: {"custom.hours": "…", "seo.title": "…"}. Everything you do not name is left exactly as it was.',
      inputSchema: z.object({
        id: z.string(),
        data: z
          .record(z.string(), z.unknown())
          .describe('Only the fields to change, keyed by dot path, e.g. {"seo.title": "Hello"}.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    /*
     * READ, SET THE NAMED PATHS, WRITE THE WHOLE THING BACK.
     *
     * `PATCH /documents/:id` REPLACES `data`; it does not merge. This tool used
     * to hand the caller's object straight to it and describe that as "pass the
     * complete data object" — but an agent told to change a tagline passes a
     * tagline, and the entire rest of the document was silently deleted.
     * Observed, not theorised: one `update_document` call reduced a seven-field
     * page to a single key, and only the published snapshot saved the site.
     *
     * The keys are dot paths for the same reason the CLI's `--set` and the
     * studio's editor use them: "this field becomes this value, nothing else
     * moves" has exactly one meaning, where a deep merge has several.
     */
    async ({ id, data }) => {
      const current = (await call(config, `/documents/${encodeURIComponent(id)}`)) as {
        document?: { data?: unknown }
      }
      const stored = isPlainObject(current.document?.data) ? current.document.data : {}

      let merged: Record<string, unknown> = { ...stored }
      for (const [rawPath, value] of Object.entries(data)) {
        const path = rawPath
          .split('.')
          .map((segment) => segment.trim())
          .filter((segment) => segment.length > 0)
        if (path.length === 0) throw new Error(`Empty field path in "${rawPath}".`)
        merged = applySet(merged, path, value)
      }

      return result(
        await call(config, `/documents/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: { data: merged },
        }),
      )
    },
  )

  server.registerTool(
    'publish',
    {
      description:
        'Publish a document to the live site. This is the only tool that changes what visitors see: it snapshots the draft and triggers the site to refresh.',
      inputSchema: z.object({ id: z.string() }),
      // The only tool whose effect is visible to the public. Not 'destructive' —
      // it adds a snapshot rather than removing anything — but a client should
      // treat it as the consequential one.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) =>
      result(
        await call(config, `/documents/${encodeURIComponent(id)}/publish`, { method: 'POST' }),
      ),
  )

  return server
}
