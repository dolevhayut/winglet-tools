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
 * Acronym of "New Generation Content Management System". Verified free at the
 * time of writing: the unscoped npm name (required for `npx <slug> init`), the
 * npm scope, and the .dev domain.
 */
export const PRODUCT_SLUG = 'ngcms' as const

const upper = PRODUCT_SLUG.toUpperCase()

/** Display name for UI chrome and CLI output. Derived, so it renames with the slug. */
export const PRODUCT_NAME = upper

/* ── npm identity ─────────────────────────────────────────────────────────── */

export const NPM_SCOPE = `@${PRODUCT_SLUG}` as const
export const SDK_PACKAGE = `${NPM_SCOPE}/next` as const
export const CLI_PACKAGE = `${NPM_SCOPE}/cli` as const
export const CLI_BIN = PRODUCT_SLUG

/* ── environment variables written into the customer's .env.local ─────────── */

export const ENV_PREFIX = `${upper}_` as const

export const ENV = {
  apiUrl: `${ENV_PREFIX}API_URL`,
  projectId: `${ENV_PREFIX}PROJECT_ID`,
  readKey: `${ENV_PREFIX}READ_KEY`,
  writeKey: `${ENV_PREFIX}WRITE_KEY`,
  previewKey: `${ENV_PREFIX}PREVIEW_KEY`,
  revalidateSecret: `${ENV_PREFIX}REVALIDATE_SECRET`,
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

export const claimUrl = (token: string): string => `${STUDIO_ORIGIN}/claim/${token}`
export const upgradeUrl = (projectId: string): string =>
  `${STUDIO_ORIGIN}/upgrade/${projectId}`

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
