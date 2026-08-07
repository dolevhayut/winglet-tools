import { API_BASE_URL, CLI_BIN, ENV, PRODUCT_NAME } from '@product'
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

/* ── the server ───────────────────────────────────────────────────────────── */

const CONTENT_TYPES = ['page', 'post', 'product', 'collection'] as const

export function buildServer(config: ServerConfig): McpServer {
  const server = new McpServer({ name: PRODUCT_NAME.toLowerCase(), version: '0.1.0' })

  server.registerTool(
    'list_documents',
    {
      description:
        'List the content documents in this project. Use it to find what exists before changing anything. Optionally filter to one content type.',
      inputSchema: z.object({
        type: z.enum(CONTENT_TYPES).optional().describe('Restrict to one content type.'),
      }),
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
    'get_document',
    {
      description: 'Read one document in full, including every field, by its id.',
      inputSchema: z.object({ id: z.string().describe('The document id from list_documents.') }),
    },
    async ({ id }) => result(await call(config, `/documents/${encodeURIComponent(id)}`)),
  )

  server.registerTool(
    'create_document',
    {
      description:
        'Create a new document. It starts as a draft and is NOT on the live site until publish is called.',
      inputSchema: z.object({
        type: z.enum(CONTENT_TYPES),
        slug: z
          .string()
          .describe('URL segment: lowercase letters, digits and hyphens.'),
        data: z
          .record(z.string(), z.unknown())
          .describe('The fields. Shop-specific extras belong under a "custom" object.'),
      }),
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
        'Change a document. This edits the DRAFT only — the live site is untouched until publish is called. Pass the complete data object; it replaces the previous one.',
      inputSchema: z.object({
        id: z.string(),
        data: z.record(z.string(), z.unknown()),
      }),
    },
    async ({ id, data }) =>
      result(
        await call(config, `/documents/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: { data },
        }),
      ),
  )

  server.registerTool(
    'publish',
    {
      description:
        'Publish a document to the live site. This is the only tool that changes what visitors see: it snapshots the draft and triggers the site to refresh.',
      inputSchema: z.object({ id: z.string() }),
    },
    async ({ id }) =>
      result(
        await call(config, `/documents/${encodeURIComponent(id)}/publish`, { method: 'POST' }),
      ),
  )

  return server
}
