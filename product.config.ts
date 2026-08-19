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

/**
 * UNSCOPED, and that was decided by the registry rather than by taste.
 *
 * These were `@{slug}/next` and `@{slug}/cli` until publication was attempted.
 * The scope is TAKEN — six packages are published under it by an unrelated
 * author (`json`, `common-utils`, `react-utils`, `json-schema`, `style-utils`,
 * `data-loader`), npm's own form answers "This name is unavailable", and an org
 * name cannot be reassigned. Nothing under that scope will ever be ours.
 *
 * The CLI had to be unscoped in any case, and that is the load-bearing half:
 * `npx {slug} init` resolves a PACKAGE named `{slug}`. It does not find a bin
 * of that name living inside a scope. Published as `@{slug}/cli`, the one
 * command on the landing page, in the skill and in `INSTALL_COMMAND` would have
 * 404ed for every reader — the same defect the API URL had, shipped again.
 *
 * And once the CLI is unscoped, a scope on the other two only splits the
 * identity. `next`, `vite`, `astro`, `svelte`, `tailwindcss` and `prisma` are
 * all unscoped; this is the norm, not a compromise. What it costs is namespace
 * protection — anyone may publish `{slug}-studio` tomorrow — and that was not
 * on offer at any price, because the scope belongs to someone else.
 */
export const SDK_PACKAGE = `${PRODUCT_SLUG}-next` as const
export const CLI_PACKAGE = PRODUCT_SLUG
export const MCP_PACKAGE = `${PRODUCT_SLUG}-mcp` as const
export const CLI_BIN = PRODUCT_SLUG

/** The version of the client packages a fresh `init` wires a project to. */
export const CLIENT_VERSION = '0.3.0' as const

/**
 * ONE BOOLEAN, because the switch has to be atomic and it has to be reversible.
 *
 * Before publication the dependency is a release tarball. A tarball is the one
 * form every package manager accepts: npm and yarn cannot resolve a git SUBPATH
 * at all, and pnpm can but then refuses to run the package's build script
 * without an `onlyBuiltDependencies` allowlist. A tarball needs neither,
 * because `dist` is already inside it and nothing builds on the customer's
 * machine. The cost is that the version lives in the URL rather than in a
 * semver range, so an upgrade is a changed line rather than a changed number.
 *
 * Flipping this to `true` BEFORE the packages are actually on npm is the one
 * way to make `init` worse than it is today: it would write a dependency that
 * cannot resolve at all, where the tarball still works. So it flips after a
 * successful publish, never in anticipation of one — and if a publish is rolled
 * back, flipping it to `false` restores a working `init` in one line.
 */
export const PUBLISHED_TO_NPM = false

export function releaseTarball(packageName: string, version: string = CLIENT_VERSION): string {
  return `${REPO_URL}/releases/download/v${version}/${packageName}-${version}.tgz`
}

/** What `init` puts in `dependencies` for the SDK. */
export function sdkDependencySpec(): string {
  return PUBLISHED_TO_NPM ? `^${CLIENT_VERSION}` : releaseTarball(SDK_PACKAGE)
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

/*
 * REGISTERED 2026-08-19, and until that day it was not.
 *
 * `.dev`, `.com`, `.io`, `.app`, `.ai`, `.sh`, `.so` and `.studio` were all
 * taken; `.co.il` too. `.cloud` is the one that is also CORRECT rather than
 * merely free: this product sells two tracks that differ by who runs the
 * server, and the paid one is the cloud.
 *
 * Everything below derives from this line, which is the whole point of it —
 * the studio, the API, the CDN, the MCP server and every link the API mints
 * moved hosts in one edit.
 */
export const ROOT_DOMAIN = `${PRODUCT_SLUG}.cloud` as const
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
 * `STUDIO_ORIGIN` above is the domain this product lives on, derived from the
 * slug so a rename still moves in one edit. A link minted for a customer has to
 * point at a host that RESOLVES, though, and for a long time this one did not —
 * a claim link to an unregistered domain is a dead link, which is worse than an
 * ugly one. So the origin used for MINTING links stays overridable per
 * deployment: it is what carried every link while the domain did not exist, and
 * it is what a preview deployment still needs.
 *
 * The same gap sat under the CLI, silently. `API_BASE_URL` is its default when
 * no flag and no environment variable are given, and it pointed at a host with
 * no DNS record at all — so `init` without `--api-url` could never have worked
 * for anyone. Registering the domain is what makes that default true.
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
