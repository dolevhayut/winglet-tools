import { API_BASE_URL, CLI_BIN, ENV } from '@product'

import { MissingConfigError } from './errors'

/**
 * PRD §11 — reading the configuration `init` wrote into `.env.local`.
 *
 * The variable names come from `@product`, so a rename of the product renames
 * them everywhere at once and this file never has to know what they are called.
 *
 * SERVER ONLY. None of these names carry the `NEXT_PUBLIC_` prefix, so Next
 * never inlines them into a client bundle — but a determined caller could still
 * import this from a `'use client'` module, so `assertServerRuntime` refuses to
 * hand out a key when a `window` exists.
 */

export type EnvSource = Readonly<Record<string, string | undefined>>

export interface ClientConfig {
  /** Base URL including the version segment, e.g. `…/v1`. No trailing slash. */
  readonly apiBaseUrl: string
  readonly projectId: string
  /** Published content only. The one key a build needs. */
  readonly readKey: string
  /** Drafts. Absent unless the customer opted into preview. */
  readonly previewKey?: string | undefined
  /** Shared secret for the revalidate route. Absent unless configured. */
  readonly revalidateSecret?: string | undefined
}

const HINT = `Run \`npx ${CLI_BIN} init\` to create it.`

function readEnv(env: EnvSource, name: string): string | undefined {
  const value = env[name]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function mustRead(env: EnvSource, name: string): string {
  const value = readEnv(env, name)
  if (value === undefined) throw new MissingConfigError(name, HINT)
  return value
}

/** Trailing slashes are stripped so path joining is a plain concatenation. */
export function normaliseBaseUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

/**
 * A browser that reached this code would be one `console.log` away from the
 * project's API key. Fail loudly instead.
 */
export function assertServerRuntime(): void {
  if (typeof window !== 'undefined') {
    throw new Error(
      'The content client is server-only. Call it from a Server Component, a ' +
        'route handler, or a build script — never from a "use client" module.',
    )
  }
}

/**
 * Reads and validates the environment. Called lazily, at the first request, so
 * that importing this package in a test with no `.env.local` is harmless.
 *
 * The write key is deliberately NOT read here. Nothing in this package needs
 * it, and a value that is never loaded cannot be leaked.
 */
export function readClientConfig(env: EnvSource = process.env): ClientConfig {
  const apiBaseUrl = readEnv(env, ENV.apiUrl) ?? API_BASE_URL

  return {
    apiBaseUrl: normaliseBaseUrl(apiBaseUrl),
    projectId: mustRead(env, ENV.projectId),
    readKey: mustRead(env, ENV.readKey),
    previewKey: readEnv(env, ENV.previewKey),
    revalidateSecret: readEnv(env, ENV.revalidateSecret),
  }
}

/** The preview key, or a `MissingConfigError` naming the variable to set. */
export function requirePreviewKey(config: ClientConfig): string {
  const key = config.previewKey
  if (key === undefined) throw new MissingConfigError(ENV.previewKey, HINT)
  return key
}

/** The revalidate secret, or a `MissingConfigError` naming the variable to set. */
export function requireRevalidateSecret(env: EnvSource = process.env): string {
  return mustRead(env, ENV.revalidateSecret)
}
