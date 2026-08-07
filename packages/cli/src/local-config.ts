import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PRODUCT_SLUG } from '@product'

import { CliError, EXIT } from './exit'

/**
 * The CLI's own state file, next to the customer's code.
 *
 * §11 asks `claim` to reprint the adoption link. The server cannot help: T2
 * stores only a sha256 of the claim token (`projects.claim_token_hash`), so the
 * plaintext exists in exactly two places after creation — the terminal, and
 * here. It deliberately does NOT live in `.env.local`: it is not a runtime
 * secret, the site never reads it, and putting it there would ship it to every
 * deployment environment the customer configures.
 *
 * The directory is added to `.gitignore` for the same reason a key would be:
 * whoever holds the token can take ownership of the project.
 */

export const CONFIG_DIR = `.${PRODUCT_SLUG}`
export const CONFIG_FILE = 'config.json'
/** Where `pull` writes by default — inside the ignored directory. */
export const CONTENT_DIR = 'content'

export function configDirPath(root: string): string {
  return join(root, CONFIG_DIR)
}

export function configFilePath(root: string): string {
  return join(configDirPath(root), CONFIG_FILE)
}

export interface ClaimRecord {
  readonly url: string
  readonly token: string
  /** ISO-8601. */
  readonly expiresAt: string
}

export interface LocalConfig {
  readonly projectId: string
  readonly slug: string | undefined
  readonly name: string | undefined
  readonly apiUrl: string
  readonly claim: ClaimRecord | undefined
  /** ISO-8601, set once when this project was created by `init`. */
  readonly createdAt: string | undefined
  readonly updatedAt: string
}

/* ── reading ──────────────────────────────────────────────────────────────── */

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

function str(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseClaim(value: unknown): ClaimRecord | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const url = str(record, 'url')
  const token = str(record, 'token')
  const expiresAt = str(record, 'expiresAt')
  if (url === undefined || token === undefined || expiresAt === undefined) return undefined
  return { url, token, expiresAt }
}

/**
 * Returns `undefined` when there is no config. A config that exists but cannot
 * be understood throws instead of being silently ignored — quietly treating a
 * corrupt file as "no project" is how `init` would create a second one.
 */
export function readLocalConfig(root: string): LocalConfig | undefined {
  const path = configFilePath(root)
  if (!existsSync(path)) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new CliError(
      `${path} is not valid JSON.`,
      EXIT.error,
      'Delete the file to start over — the project itself is unaffected.',
    )
  }

  const record = asRecord(parsed)
  const projectId = record === undefined ? undefined : str(record, 'projectId')
  if (record === undefined || projectId === undefined) {
    throw new CliError(
      `${path} is missing "projectId".`,
      EXIT.error,
      'Delete the file to start over — the project itself is unaffected.',
    )
  }

  return {
    projectId,
    slug: str(record, 'slug'),
    name: str(record, 'name'),
    apiUrl: str(record, 'apiUrl') ?? '',
    claim: parseClaim(record['claim']),
    createdAt: str(record, 'createdAt'),
    updatedAt: str(record, 'updatedAt') ?? '',
  }
}

/* ── writing ──────────────────────────────────────────────────────────────── */

/** Only defined values are serialised, so the file stays readable by a human. */
function serialise(config: LocalConfig): string {
  const payload: Record<string, unknown> = {
    projectId: config.projectId,
    apiUrl: config.apiUrl,
    updatedAt: config.updatedAt,
  }
  if (config.slug !== undefined) payload['slug'] = config.slug
  if (config.name !== undefined) payload['name'] = config.name
  if (config.createdAt !== undefined) payload['createdAt'] = config.createdAt
  if (config.claim !== undefined) payload['claim'] = config.claim
  return `${JSON.stringify(payload, null, 2)}\n`
}

export function writeLocalConfig(root: string, config: LocalConfig): string {
  const dir = configDirPath(root)
  mkdirSync(dir, { recursive: true })
  const path = configFilePath(root)
  writeFileSync(path, serialise(config), 'utf8')
  return path
}
