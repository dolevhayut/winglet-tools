import { API_BASE_URL } from '@product'

import { CliError, EXIT } from './exit'

/**
 * The CLI's HTTP client.
 *
 * Deliberately NOT the SDK. The SDK is a build-time content reader for the
 * customer's site: it reads its configuration from the environment, caches
 * through Next's fetch, and never touches the write key. The CLI needs the
 * opposite — an explicit base URL and key per call, no caching, and access to
 * management endpoints (`POST /projects/anonymous`, `GET /usage`) that the SDK
 * has no business exposing. Sharing a client would have meant widening the
 * SDK's surface for a consumer that is not the customer.
 *
 * Everything here maps failures onto §11's exit codes:
 *   · unreachable host, 5xx, 429, `RATE_LIMITED`, `LIMIT_EXCEEDED` → 3
 *   · anything the caller can fix (bad key, unknown project, bad input) → 1
 */

/** §9's codes, plus the `INTERNAL` the API added in M2. */
export const API_ERROR_CODES = [
  'INVALID_KEY',
  'PROJECT_NOT_FOUND',
  'LIMIT_EXCEEDED',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'CLAIM_EXPIRED',
  'INTERNAL',
] as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

/** Retryable in the caller's sense: waiting or upgrading changes the outcome. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set(['RATE_LIMITED', 'LIMIT_EXCEEDED', 'INTERNAL'])

export function resolveApiBaseUrl(explicit: string | undefined, fromEnv: string | undefined): string {
  const chosen = explicit ?? fromEnv ?? API_BASE_URL
  return chosen.replace(/\/+$/, '')
}

/* ── parsing helpers (no `any`, no schema library in the CLI) ─────────────── */

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

function requireString(record: Readonly<Record<string, unknown>>, key: string, where: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new CliError(`The API returned an unexpected ${where}: "${key}" is missing.`, EXIT.error)
  }
  return value
}

function optionalNumber(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/* ── the wire ─────────────────────────────────────────────────────────────── */

interface RawResponse {
  readonly status: number
  readonly body: unknown
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST'
  readonly key?: string
  readonly body?: unknown
  /** §14.1 counts anonymous project creation per client address. */
  readonly headers?: Readonly<Record<string, string>>
  readonly fetchImpl?: typeof fetch
}

async function send(url: string, options: RequestOptions): Promise<RawResponse> {
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers }
  if (options.key !== undefined) headers['authorization'] = `Bearer ${options.key}`
  if (options.body !== undefined) headers['content-type'] = 'application/json'

  const doFetch = options.fetchImpl ?? fetch

  let response: Response
  try {
    response = await doFetch(url, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      // The CLI is the one caller that must never read a cached answer: it is
      // reporting on state the user just changed.
      cache: 'no-store',
    })
  } catch (cause) {
    throw new CliError(
      `Cannot reach the API at ${url}.`,
      EXIT.limitOrNetwork,
      `${cause instanceof Error ? cause.message : String(cause)}\nCheck your network, or pass --api-url.`,
    )
  }

  const text = await response.text()
  let body: unknown = undefined
  if (text.length > 0) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { status: response.status, body }
}

/** Turns §9's error envelope into a `CliError` with the right exit code. */
function apiFailure(url: string, raw: RawResponse): CliError {
  const envelope = asRecord(raw.body)
  const error = envelope === undefined ? undefined : asRecord(envelope['error'])

  const code = error === undefined ? undefined : error['code']
  const codeText = typeof code === 'string' ? code : undefined
  const message = error === undefined ? undefined : error['message']
  const messageText = typeof message === 'string' ? message : `HTTP ${String(raw.status)}`

  const transport = raw.status === 429 || raw.status >= 500
  const exitCode =
    transport || (codeText !== undefined && RETRYABLE_CODES.has(codeText))
      ? EXIT.limitOrNetwork
      : EXIT.error

  const details: string[] = [`${url} → ${String(raw.status)}`]
  if (codeText !== undefined) details.push(`code: ${codeText}`)
  const upgrade = error === undefined ? undefined : error['upgrade_url']
  if (typeof upgrade === 'string') details.push(`upgrade: ${upgrade}`)

  return new CliError(messageText, exitCode, details.join('\n'))
}

async function json(url: string, options: RequestOptions): Promise<unknown> {
  const raw = await send(url, options)
  if (raw.status < 200 || raw.status >= 300) throw apiFailure(url, raw)
  return raw.body
}

/* ── POST /projects/anonymous ─────────────────────────────────────────────── */

export interface AnonymousProject {
  readonly project: {
    readonly id: string
    readonly slug: string
    readonly name: string
    readonly created_at: string
  }
  readonly keys: { readonly read: string; readonly write: string; readonly preview: string }
  readonly claim: {
    readonly url: string
    readonly token: string
    readonly expires_at: string
  }
  readonly seeded: {
    readonly content_types: readonly string[]
    readonly documents: readonly { readonly type_key: string; readonly slug: string }[]
  }
}

function parseAnonymousProject(body: unknown): AnonymousProject {
  const root = asRecord(body)
  const project = root === undefined ? undefined : asRecord(root['project'])
  const keys = root === undefined ? undefined : asRecord(root['keys'])
  const claim = root === undefined ? undefined : asRecord(root['claim'])
  const seeded = root === undefined ? undefined : asRecord(root['seeded'])

  if (project === undefined || keys === undefined || claim === undefined || seeded === undefined) {
    throw new CliError('The API returned an unexpected project payload.', EXIT.error)
  }

  const contentTypes = seeded['content_types']
  const documents = seeded['documents']

  return {
    project: {
      id: requireString(project, 'id', 'project'),
      slug: requireString(project, 'slug', 'project'),
      name: requireString(project, 'name', 'project'),
      created_at: requireString(project, 'created_at', 'project'),
    },
    keys: {
      read: requireString(keys, 'read', 'key set'),
      write: requireString(keys, 'write', 'key set'),
      preview: requireString(keys, 'preview', 'key set'),
    },
    claim: {
      url: requireString(claim, 'url', 'claim'),
      token: requireString(claim, 'token', 'claim'),
      expires_at: requireString(claim, 'expires_at', 'claim'),
    },
    seeded: {
      content_types: Array.isArray(contentTypes)
        ? contentTypes.filter((entry): entry is string => typeof entry === 'string')
        : [],
      documents: Array.isArray(documents)
        ? documents.flatMap((entry) => {
            const record = asRecord(entry)
            if (record === undefined) return []
            const typeKey = record['type_key']
            const slug = record['slug']
            return typeof typeKey === 'string' && typeof slug === 'string'
              ? [{ type_key: typeKey, slug }]
              : []
          })
        : [],
    },
  }
}

export interface CreateProjectInput {
  readonly baseUrl: string
  readonly name?: string | undefined
  readonly slug?: string | undefined
  readonly agentFingerprint?: string | undefined
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly fetchImpl?: typeof fetch | undefined
}

export async function createAnonymousProject(
  input: CreateProjectInput,
): Promise<AnonymousProject> {
  const body: Record<string, string> = {}
  if (input.name !== undefined) body['name'] = input.name
  if (input.slug !== undefined) body['slug'] = input.slug
  if (input.agentFingerprint !== undefined) body['agentFingerprint'] = input.agentFingerprint

  const url = `${input.baseUrl}/projects/anonymous`
  const payload = await json(url, {
    method: 'POST',
    body,
    ...(input.headers === undefined ? {} : { headers: input.headers }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  })
  return parseAnonymousProject(payload)
}

/* ── GET /content/_all ────────────────────────────────────────────────────── */

export interface ContentSnapshot {
  readonly projectId: string
  readonly contentVersion: number | undefined
  readonly types: readonly string[]
  readonly documents: Readonly<Record<string, readonly unknown[]>>
  readonly total: number
  readonly truncated: boolean
}

export async function fetchContentSnapshot(
  baseUrl: string,
  readKey: string,
  fetchImpl?: typeof fetch,
): Promise<ContentSnapshot> {
  const url = `${baseUrl}/content/_all`
  const body = await json(url, {
    key: readKey,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  })

  const root = asRecord(body)
  if (root === undefined) {
    throw new CliError('The API returned an unexpected content payload.', EXIT.error)
  }

  const documentsRecord = asRecord(root['documents']) ?? {}
  const documents: Record<string, readonly unknown[]> = {}
  for (const [typeKey, value] of Object.entries(documentsRecord)) {
    documents[typeKey] = Array.isArray(value) ? value : []
  }

  const types = root['types']
  const total = optionalNumber(root, 'total')

  return {
    projectId: requireString(root, 'project_id', 'content payload'),
    contentVersion: optionalNumber(root, 'content_version'),
    types: Array.isArray(types)
      ? types.filter((entry): entry is string => typeof entry === 'string')
      : Object.keys(documents),
    documents,
    total: total ?? Object.values(documents).reduce((sum, list) => sum + list.length, 0),
    truncated: root['truncated'] === true,
  }
}

/**
 * Cheapest possible proof that a read key belongs to a live project — used by
 * `link` before it writes anything, so a typo fails fast instead of producing a
 * `.env.local` that only breaks at the customer's next build.
 */
export async function verifyReadKey(
  baseUrl: string,
  readKey: string,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const snapshot = await fetchContentSnapshot(baseUrl, readKey, fetchImpl)
  return snapshot.projectId
}

/* ── GET /usage ───────────────────────────────────────────────────────────── */

export interface UsageCounter {
  readonly name: string
  readonly current: number
  readonly max: number | undefined
}

export interface UsageReport {
  readonly plan: string | undefined
  readonly counters: readonly UsageCounter[]
}

/**
 * §9 lists `GET /usage`, which the API has not shipped yet. A 404 therefore
 * means "not available on this deployment", not "your project is gone", and the
 * `usage` command derives what it can from the Content API instead. Anything
 * else is a real failure and propagates.
 *
 * The parse is intentionally shape-tolerant: it accepts a flat map of numbers
 * and a `{ current, max }` map equally, so the command keeps working the day
 * the endpoint lands without a CLI release.
 */
export async function fetchUsage(
  baseUrl: string,
  key: string,
  fetchImpl?: typeof fetch,
): Promise<UsageReport | undefined> {
  const url = `${baseUrl}/usage`
  const raw = await send(url, { key, ...(fetchImpl === undefined ? {} : { fetchImpl }) })
  if (raw.status === 404) return undefined
  if (raw.status < 200 || raw.status >= 300) throw apiFailure(url, raw)

  const root = asRecord(raw.body)
  if (root === undefined) return undefined

  const planValue = root['plan']
  const source = asRecord(root['usage']) ?? asRecord(root['counters']) ?? root

  const counters: UsageCounter[] = []
  for (const [name, value] of Object.entries(source)) {
    if (name === 'plan') continue
    if (typeof value === 'number' && Number.isFinite(value)) {
      counters.push({ name, current: value, max: undefined })
      continue
    }
    const nested = asRecord(value)
    if (nested === undefined) continue
    const current = optionalNumber(nested, 'current') ?? optionalNumber(nested, 'used')
    if (current === undefined) continue
    counters.push({ name, current, max: optionalNumber(nested, 'max') ?? optionalNumber(nested, 'limit') })
  }

  if (counters.length === 0) return undefined
  return {
    plan: typeof planValue === 'string' ? planValue : undefined,
    counters: counters.sort((a, b) => a.name.localeCompare(b.name)),
  }
}
