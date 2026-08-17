/**
 * THE single source of truth for the product's identity.
 *
 * PRD constraint: "אין לפזר את השם בקוד. להגדיר קבוע יחיד PRODUCT_SLUG
 * ולגזור ממנו package name, CLI name, env prefix ודומיינים.
 * שינוי שם = שינוי במקום אחד."
 *
 * Nothing below may be re-typed as a literal anywhere else in the repo.
 * `tools/guards/product-slug.test.ts` fails the build if it is.
 *
 * A winglet is a small structure at the wing tip that reduces drag across the
 * whole aircraft — the metaphor for a small CMS layer that removes the drag of
 * routine content edits from the coding agent's loop.
 */
export const PRODUCT_SLUG = 'winglet' as const

const upper = PRODUCT_SLUG.toUpperCase()

/** Display name for UI chrome and CLI output. Derived, so it renames with the slug. */
export const PRODUCT_NAME = 'Winglet' as const

/* ── npm identity ─────────────────────────────────────────────────────────── */

export const NPM_SCOPE = `@${PRODUCT_SLUG}` as const
export const SDK_PACKAGE = `${NPM_SCOPE}/next` as const
export const CLI_PACKAGE = `${NPM_SCOPE}/cli` as const
export const CLI_BIN = PRODUCT_SLUG

/**
 * The version of the client packages a fresh `init` wires a project to.
 *
 * NOT YET ON NPM. `SDK_PACKAGE` is the name these will publish under, and
 * asking a package manager for it today returns "not in the npm registry" —
 * which is what `init` did for every user, non-fatally, so the failure only
 * surfaced later at build time.
 *
 * Until they are published, the dependency is the release tarball. A tarball is
 * the one form every package manager accepts: npm and yarn cannot resolve a git
 * SUBPATH at all, and pnpm can but then refuses to run the package's build
 * script without an `onlyBuiltDependencies` allowlist. A tarball needs neither,
 * because `dist` is already inside it and nothing is built on the customer's
 * machine.
 *
 * The cost is that the version lives in the URL rather than in a semver range,
 * so an upgrade is a changed line rather than a changed number. That is the
 * trade until publication, and publication deletes this whole block.
 */
export const CLIENT_VERSION = '0.1.3' as const

export function releaseTarball(packageName: string, version: string = CLIENT_VERSION): string {
  const bare = packageName.replace(`${NPM_SCOPE}/`, `${PRODUCT_SLUG}-`)
  return `${REPO_URL}/releases/download/v${version}/${bare}-${version}.tgz`
}

/** What `init` puts in `dependencies` for the SDK. */
export function sdkDependencySpec(): string {
  return releaseTarball(SDK_PACKAGE)
}

/* ── environment variables written into the customer's .env.local ─────────── */

export const ENV_PREFIX = `${upper}_` as const

export const ENV = {
  apiUrl: `${ENV_PREFIX}API_URL`,
  projectId: `${ENV_PREFIX}PROJECT_ID`,
  readKey: `${ENV_PREFIX}READ_KEY`,
  writeKey: `${ENV_PREFIX}WRITE_KEY`,
  previewKey: `${ENV_PREFIX}PREVIEW_KEY`,
  revalidateSecret: `${ENV_PREFIX}REVALIDATE_SECRET`,
  /**
   * The site's own public origin, e.g. `https://example.com` (M21.2).
   *
   * A canonical URL is the one piece of metadata a CMS genuinely cannot derive:
   * the content knows its slug, the deployment knows its host, and only the
   * customer knows which host is the real one. Configured once here rather than
   * passed at every `generateMetadata` call site.
   *
   * NOT `NEXT_PUBLIC_`. It is read while rendering on the server, and a value
   * inlined into every client bundle for no reason is a value that will
   * eventually be read from a browser by mistake.
   */
  siteOrigin: `${ENV_PREFIX}SITE_ORIGIN`,
} as const

/* ── API keys (§7: sha256 in DB, prefix shown in UI) ──────────────────────── */

export const KEY_SCOPES = ['read', 'write', 'preview'] as const
export type KeyScope = (typeof KEY_SCOPES)[number]

/** `{slug}_read_…` / `{slug}_write_…` / `{slug}_preview_…` */
export const keyPrefix = (scope: KeyScope): string => `${PRODUCT_SLUG}_${scope}_`

/* ── domains (§9, §14.7) ──────────────────────────────────────────────────── */

export const ROOT_DOMAIN = `${PRODUCT_SLUG}.dev` as const
export const STUDIO_ORIGIN = `https://${ROOT_DOMAIN}` as const
export const API_ORIGIN = `https://api.${ROOT_DOMAIN}` as const
export const CDN_ORIGIN = `https://cdn.${ROOT_DOMAIN}` as const
export const API_BASE_URL = `${API_ORIGIN}/v1` as const

/** Where the hosted MCP server answers. */
export const MCP_ORIGIN = `https://mcp.${ROOT_DOMAIN}` as const
export const MCP_URL = `${MCP_ORIGIN}/mcp` as const

/** The agent skill, published as a directory in the public repo. */
export const GITHUB_ORG = 'dolevhayut' as const
export const REPO_URL = `https://github.com/${GITHUB_ORG}/${PRODUCT_SLUG}-tools` as const
export const SKILL_URL = `${REPO_URL}/tree/main/skills/${PRODUCT_SLUG}` as const

/** `npx {slug} init` — the one line a developer copies. */
export const INSTALL_COMMAND = `npx ${PRODUCT_SLUG} init` as const

/**
 * Where the studio ACTUALLY answers right now.
 *
 * `STUDIO_ORIGIN` above is the domain this product is *intended* to live on,
 * derived from the slug so a rename still moves in one edit. But a link minted
 * for a customer has to point at a host that resolves today — a claim link to
 * an unregistered domain is a dead link, which is worse than an ugly one. So
 * the origin used for MINTING links is overridable per deployment, while the
 * intended domain stays the default and the single source of the name.
 *
 * Server-side only. Links are minted by the API, never in a browser, so this
 * deliberately does not use a `NEXT_PUBLIC_` prefix — the value would then be
 * inlined into every client bundle for no reason.
 */
export const STUDIO_ORIGIN_ENV = `${ENV_PREFIX}STUDIO_ORIGIN` as const

function studioOrigin(): string {
  // `typeof process` rather than a truthiness check: in a browser bundle the
  // identifier is not merely falsy, it is undeclared, and referencing it throws.
  if (typeof process === 'undefined') return STUDIO_ORIGIN
  const configured = process.env[STUDIO_ORIGIN_ENV]
  return configured !== undefined && configured.length > 0 ? configured : STUDIO_ORIGIN
}

export const claimUrl = (token: string): string => `${studioOrigin()}/claim/${token}`
export const upgradeUrl = (projectId: string): string =>
  `${studioOrigin()}/upgrade/${projectId}`

/* ── files the CLI writes into the customer's project (§11) ───────────────── */

export const TYPES_FILE = `${PRODUCT_SLUG}.types.ts` as const
export const AGENTS_FILE = 'AGENTS.md' as const
/** Route the CLI mounts so our publish webhook can call `revalidateTag`. */
export const REVALIDATE_ROUTE = `/api/${PRODUCT_SLUG}/revalidate` as const

/* ── Next.js cache tags (§10) ─────────────────────────────────────────────── */

/** `{slug}:{projectId}:{typeKey}` — what `revalidateTag` receives. */
export const cacheTag = (projectId: string, typeKey: string): string =>
  `${PRODUCT_SLUG}:${projectId}:${typeKey}`

/** `{slug}:{projectId}` — invalidates every type in a project at once. */
export const projectCacheTag = (projectId: string): string =>
  `${PRODUCT_SLUG}:${projectId}`

/* ── CSS custom-property namespace for the studio (§13.2) ─────────────────── */

export const CSS_PREFIX = '--clay' as const
