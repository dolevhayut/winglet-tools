import { serve } from '@hono/node-server'
import { API_BASE_URL, ENV, PRODUCT_NAME } from '@product'
import { createMcpHonoApp } from '@modelcontextprotocol/hono'
import { createMcpHandler } from '@modelcontextprotocol/server'

import { buildServer } from './server'
import type { ServerConfig } from './server'

/**
 * The Streamable HTTP transport — what runs in the container.
 *
 * WHY THE KEY COMES FROM THE REQUEST, NOT THE ENVIRONMENT
 * ------------------------------------------------------
 * The stdio server is per-project: one agent, one process, one key in its env.
 * A hosted server is not. Baking a key into the container would make every
 * caller that reaches the port an editor of that one project — and every other
 * tenant would need their own container.
 *
 * So each request carries its own `Authorization: Bearer <write key>`, and a
 * server instance is built for that request. The key is never stored, never
 * logged, and never leaves the process. A request without one is refused.
 */

const PORT = Number(process.env['PORT'] ?? '8080')

/** Bind on all interfaces inside a container; the port is what gets published. */
const HOST = process.env['HOST'] ?? '0.0.0.0'

const API_BASE = process.env[ENV.apiUrl] ?? API_BASE_URL

function configFromRequest(request: Request): ServerConfig | null {
  const header = request.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return null
  const writeKey = header.slice('Bearer '.length).trim()
  if (writeKey.length === 0) return null
  return { writeKey, apiBaseUrl: API_BASE }
}

const app = createMcpHonoApp()

/** Liveness, so a container orchestrator can tell "up" from "listening". */
app.get('/healthz', (c) => c.json({ service: `${PRODUCT_NAME.toLowerCase()}-mcp`, status: 'ok' }))

app.all('/mcp', async (c) => {
  const config = configFromRequest(c.req.raw)
  if (config === null) {
    return c.json(
      {
        error: {
          code: 'INVALID_KEY',
          message: 'Send the project write key as: Authorization: Bearer <key>.',
        },
      },
      401,
    )
  }

  const handler = createMcpHandler(() => buildServer(config))
  return handler.fetch(c.req.raw)
})

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
  process.stderr.write(`mcp listening on http://${HOST}:${String(PORT)}/mcp · api ${API_BASE}\n`)
})
