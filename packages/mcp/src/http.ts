import { serve } from '@hono/node-server'
import { API_BASE_URL, ENV, MCP_ORIGIN, PRODUCT_NAME, PRODUCT_SLUG, REPO_URL } from '@product'
import { createMcpHonoApp } from '@modelcontextprotocol/hono'
import { createMcpHandler, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/server'

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
 *
 * This is NOT the token-passthrough anti-pattern the spec warns about. That
 * rule is about relaying a token minted by a third-party authorization server
 * into a different trust domain. The write key is first-party and this process
 * and the REST API are one boundary — the same shape GitHub's and Supabase's
 * hosted servers ship.
 */

const PORT = Number(process.env['PORT'] ?? '8080')

/** Bind on all interfaces inside a container; the port is what gets published. */
const HOST = process.env['HOST'] ?? '0.0.0.0'

const API_BASE = process.env[ENV.apiUrl] ?? API_BASE_URL

/**
 * The public origin this server answers on, which is NOT the same thing as the
 * interface it binds. It is what goes in the RFC 9728 `resource` field and in
 * the `resource_metadata` pointer, so it has to be the URL a client typed —
 * getting it from the request's own Host header would let a caller dictate the
 * contents of our discovery document.
 */
const FLY_APP = process.env['FLY_APP_NAME']

/*
 * The address a client actually typed, which since the domain moved is the
 * product's own host and not the platform's. Deployed, this used to default to
 * `<app>.fly.dev`; that is now merely where the container happens to run.
 */
const PUBLIC_URL = new URL(
  process.env[`${PRODUCT_SLUG.toUpperCase()}_MCP_PUBLIC_URL`] ??
    (FLY_APP === undefined ? `http://localhost:${String(PORT)}` : MCP_ORIGIN),
)

/**
 * DNS REBINDING PROTECTION — the reason this file cannot use the adapter's
 * defaults.
 *
 * `createMcpHonoApp()` with no options defaults to `host: '127.0.0.1'`, and
 * that default installs localhost-only `Host` validation on every route. On any
 * real host the `Host` header is the deployed domain, so EVERY request — the
 * health check included — answers 403. It passes locally only because you
 * reach it as `localhost`, which is exactly the environment where the bug is
 * invisible.
 *
 * Turning the check off is not the fix either: the spec is a flat MUST for all
 * Streamable HTTP servers, not just local ones — "Servers MUST validate the
 * `Origin` header on all incoming connections to prevent DNS rebinding
 * attacks." So the list is stated explicitly instead.
 *
 * Origin is separate and more permissive by design: the SDK lets a request with
 * NO `Origin` through, because non-browser MCP clients do not send one. Only a
 * present-and-unrecognised value is refused.
 */
const allowedHosts = [
  PUBLIC_URL.hostname,
  /*
   * The product's own hostname, DERIVED, and listed even when `PUBLIC_URL`
   * already resolves to it — because the day a custom domain was pointed at
   * this app, every request through it answered
   * `403 Invalid Host: mcp.<domain>` while the platform hostname kept working.
   * That is the URL on the landing page and in the MCP registry entry, so the
   * published address was the one address that did not work.
   */
  new URL(MCP_ORIGIN).hostname,
  'localhost',
  '127.0.0.1',
  '[::1]',
  ...(FLY_APP === undefined ? [] : [`${FLY_APP}.fly.dev`, `${FLY_APP}.internal`]),
  ...(process.env[`${PRODUCT_SLUG.toUpperCase()}_MCP_ALLOWED_HOSTS`] ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0),
]

const allowedOrigins = [PUBLIC_URL.hostname, new URL(MCP_ORIGIN).hostname, 'localhost', '127.0.0.1']

function configFromRequest(request: Request): ServerConfig | null {
  const header = request.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return null
  const writeKey = header.slice('Bearer '.length).trim()
  if (writeKey.length === 0) return null
  return { writeKey, apiBaseUrl: API_BASE }
}

const MCP_PATH = '/mcp'
const resourceUrl = new URL(MCP_PATH, PUBLIC_URL)
const metadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl)

/**
 * RFC 9728 Protected Resource Metadata — a MUST for MCP servers, and the piece
 * that turns a 401 into something a client can act on rather than just fail on.
 *
 * `authorization_servers` is deliberately ABSENT rather than empty. The field
 * is optional, and we do not run an authorization server: this resource takes a
 * first-party project write key. Naming an AS we do not operate would send
 * clients into a discovery flow that dead-ends. That is also why the SDK's
 * `oauthMetadataResponse` helper is not used here — it requires an
 * `oauthMetadata` document as input, which we would have to invent.
 */
const protectedResourceMetadata = {
  resource: resourceUrl.href,
  // Says the credential belongs in the Authorization header, which is also the
  // spec's rule: "Access tokens MUST NOT be included in the URI query string."
  bearer_methods_supported: ['header'],
  resource_name: `${PRODUCT_NAME} MCP`,
  resource_documentation: REPO_URL,
}

const mcp = createMcpHonoApp({ host: HOST, allowedHosts, allowedOrigins })

mcp.get(metadataUrl.replace(PUBLIC_URL.origin, ''), (c) => c.json(protectedResourceMetadata))

mcp.all(MCP_PATH, async (c) => {
  const config = configFromRequest(c.req.raw)
  if (config === null) {
    /*
     * The `WWW-Authenticate` header is the whole point of this branch. Without
     * it a conformant client that meets a 401 has no way to discover how to
     * authenticate and simply gives up; with it, it fetches the metadata
     * document above. Every mature hosted MCP server emits this.
     */
    c.header(
      'WWW-Authenticate',
      `Bearer error="invalid_token", error_description="A project write key is required.", resource_metadata="${metadataUrl}"`,
    )
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

/*
 * HEALTH IS ANSWERED AHEAD OF THE APP, not inside it.
 *
 * The adapter installs its Host/Origin middleware on `*`, so a route mounted
 * inside would be subject to it. Fly runs checks over the private network,
 * where the `Host` is neither the public hostname nor necessarily localhost —
 * and a check that 403s is a check that never passes, which reads as "the app
 * is broken" rather than "the allowlist is short". Short-circuiting here means
 * no middleware, present or future, can take liveness down with it.
 *
 * It is a liveness probe only: it reports that this process is listening and
 * deliberately does not call the REST API. A health check that depends on a
 * third party turns their outage into our crash loop.
 */
function fetchHandler(request: Request): Response | Promise<Response> {
  if (new URL(request.url).pathname === '/healthz') {
    return Response.json({ service: `${PRODUCT_SLUG}-mcp`, status: 'ok' })
  }
  return mcp.fetch(request)
}

const server = serve({ fetch: fetchHandler, port: PORT, hostname: HOST }, () => {
  process.stderr.write(
    `mcp listening on ${String(PORT)} · public ${PUBLIC_URL.origin} · api ${API_BASE}\n`,
  )
})

/*
 * GRACEFUL SHUTDOWN.
 *
 * Both signals, because the platform's own docs disagree about which one it
 * sends: the config reference says SIGINT, the long-running-tasks blueprint
 * says SIGTERM. Handling one and guessing wrong means every deploy kills
 * in-flight requests instead of draining them.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    process.stderr.write(`${signal} received, draining\n`)
    server.close(() => {
      process.exit(0)
    })
  })
}
