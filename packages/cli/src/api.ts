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
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
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

  // §9's `issues` name the offending PATH. Without them a validation failure
  // reads "does not match the content type" and the caller has to guess which
  // of forty fields it meant — which is exactly what a real migration ran into.
  const issues = error === undefined ? undefined : error['issues']
  if (Array.isArray(issues)) {
    for (const issue of issues.slice(0, 8)) {
      const record = asRecord(issue)
      const path = record?.['path']
      const message = record?.['message']
      if (typeof path === 'string' && typeof message === 'string') {
        details.push(`${path}: ${message}`)
      }
    }
    if (issues.length > 8) details.push(`… and ${String(issues.length - 8)} more`)
  }
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

/* ── the Management API: /documents (write-scoped) ────────────────────────── */

/**
 * §9's whole Management API — list, read, create, edit, publish, delete —
 * requires a WRITE key. There is no read-only door into it; a read key only
 * ever unlocks the public Content API (`fetchContentSnapshot` above), which
 * serves published data and knows nothing about drafts or document ids.
 */

export interface DocumentSummary {
  readonly id: string
  readonly type: string
  readonly slug: string
  readonly status: string
}

export interface DocumentRecord {
  readonly id: string
  readonly type: string
  readonly slug: string
  readonly status: string
  readonly locale: string
  readonly data: Readonly<Record<string, unknown>>
  readonly publishedData: Readonly<Record<string, unknown>> | undefined
  readonly updatedAt: string
}

function requireRecord(
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): Readonly<Record<string, unknown>> {
  const value = asRecord(record[key])
  if (value === undefined) {
    throw new CliError(`The API returned an unexpected ${where}: "${key}" is missing or not an object.`, EXIT.error)
  }
  return value
}

function parseDocumentSummary(value: unknown): DocumentSummary | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  return {
    id: requireString(record, 'id', 'document'),
    type: requireString(record, 'type_key', 'document'),
    slug: requireString(record, 'slug', 'document'),
    status: requireString(record, 'status', 'document'),
  }
}

function parseDocumentRecord(body: unknown): DocumentRecord {
  const root = asRecord(body)
  const document = root === undefined ? undefined : asRecord(root['document'])
  if (document === undefined) {
    throw new CliError('The API returned an unexpected document payload.', EXIT.error)
  }

  const published = asRecord(document['published_data'])

  return {
    id: requireString(document, 'id', 'document'),
    type: requireString(document, 'type_key', 'document'),
    slug: requireString(document, 'slug', 'document'),
    status: requireString(document, 'status', 'document'),
    locale: requireString(document, 'locale', 'document'),
    data: requireRecord(document, 'data', 'document'),
    publishedData: published,
    updatedAt: requireString(document, 'updated_at', 'document'),
  }
}

export interface ManagementClientOptions {
  readonly baseUrl: string
  readonly writeKey: string
  readonly fetchImpl?: typeof fetch | undefined
}

function withFetch(fetchImpl: typeof fetch | undefined): { fetchImpl?: typeof fetch } {
  return fetchImpl === undefined ? {} : { fetchImpl }
}

export async function listDocuments(
  options: ManagementClientOptions,
  type?: string,
): Promise<readonly DocumentSummary[]> {
  const query = type === undefined ? '' : `?type=${encodeURIComponent(type)}`
  const url = `${options.baseUrl}/documents${query}`
  const body = await json(url, { key: options.writeKey, ...withFetch(options.fetchImpl) })
  const root = asRecord(body)
  const documents = root === undefined ? undefined : root['documents']
  if (!Array.isArray(documents)) {
    throw new CliError('The API returned an unexpected document list.', EXIT.error)
  }
  return documents.flatMap((entry) => {
    const summary = parseDocumentSummary(entry)
    return summary === undefined ? [] : [summary]
  })
}

export async function getDocument(
  options: ManagementClientOptions,
  id: string,
): Promise<DocumentRecord> {
  const url = `${options.baseUrl}/documents/${encodeURIComponent(id)}`
  const body = await json(url, { key: options.writeKey, ...withFetch(options.fetchImpl) })
  return parseDocumentRecord(body)
}

export interface CreateDocumentInput {
  readonly type: string
  readonly slug: string
  readonly data: Readonly<Record<string, unknown>>
  readonly locale?: string | undefined
}

export async function createDocument(
  options: ManagementClientOptions,
  input: CreateDocumentInput,
): Promise<DocumentRecord> {
  const url = `${options.baseUrl}/documents`
  const body = await json(url, {
    method: 'POST',
    key: options.writeKey,
    body: {
      type_key: input.type,
      slug: input.slug,
      data: input.data,
      ...(input.locale === undefined ? {} : { locale: input.locale }),
    },
    ...withFetch(options.fetchImpl),
  })
  return parseDocumentRecord(body)
}

export async function updateDocumentData(
  options: ManagementClientOptions,
  id: string,
  data: Readonly<Record<string, unknown>>,
): Promise<DocumentRecord> {
  const url = `${options.baseUrl}/documents/${encodeURIComponent(id)}`
  const body = await json(url, {
    method: 'PATCH',
    key: options.writeKey,
    body: { data },
    ...withFetch(options.fetchImpl),
  })
  return parseDocumentRecord(body)
}

export interface PublishResult {
  readonly documentId: string
  readonly contentVersion: number | undefined
}

export async function publishDocument(
  options: ManagementClientOptions,
  id: string,
): Promise<PublishResult> {
  const url = `${options.baseUrl}/documents/${encodeURIComponent(id)}/publish`
  const body = await json(url, {
    method: 'POST',
    key: options.writeKey,
    ...withFetch(options.fetchImpl),
  })
  const root = asRecord(body)
  if (root === undefined) {
    throw new CliError('The API returned an unexpected publish payload.', EXIT.error)
  }
  return {
    documentId: requireString(root, 'document_id', 'publish result'),
    contentVersion: optionalNumber(root, 'content_version'),
  }
}

export interface DeleteResult {
  readonly deleted: boolean
  readonly contentVersion: number | undefined
}

export async function deleteDocument(
  options: ManagementClientOptions,
  id: string,
): Promise<DeleteResult> {
  const url = `${options.baseUrl}/documents/${encodeURIComponent(id)}`
  const raw = await send(url, { method: 'DELETE', key: options.writeKey, ...withFetch(options.fetchImpl) })
  if (raw.status < 200 || raw.status >= 300) throw apiFailure(url, raw)
  const root = asRecord(raw.body)
  return {
    deleted: root?.['deleted'] === true,
    contentVersion: root === undefined ? undefined : optionalNumber(root, 'content_version'),
  }
}

/* ── the content model (M10) ──────────────────────────────────────────────── */

/**
 * `GET /v1/types`, `GET|POST|PATCH|DELETE /v1/objects` — the project's own
 * content model, as opposed to its content.
 *
 * WHY THE CLI OWNS THIS AT ALL
 * ----------------------------
 * The agent is the primary worker and the command line is its whole world: it
 * has no browser to open the studio in. A model that can only be inspected or
 * changed through a UI is, for the agent, a model that cannot be changed. Every
 * one of these has a `--json` path for exactly that reason.
 *
 * Reading takes the READ key, not the write key: the model is not a secret, and
 * `types` must work in a build-only checkout that was linked with `--read-key`
 * alone.
 */

export interface ModelFieldDefinition {
  readonly name: string
  readonly kind: string
  readonly required: boolean
  readonly title?: string | undefined
  readonly repeated?: boolean | undefined
  readonly options?: readonly string[] | undefined
  readonly to?: readonly string[] | undefined
  readonly blocks?: readonly string[] | undefined
  readonly of?: string | undefined
  readonly deprecated?: boolean | undefined
}

export interface ModelObjectDefinition {
  readonly key: string
  readonly title: string
  readonly fields: readonly ModelFieldDefinition[]
}

export interface ModelContentTypeDefinition extends ModelObjectDefinition {
  readonly titleField: string
  readonly slugField: string
  /** M15 — absent means `many`. See `Cardinality` in the SDK's definitions. */
  readonly cardinality?: 'single' | 'many' | undefined
  /** M15 — the studio sidebar heading this type is filed under. */
  readonly group?: string | undefined
}

export interface ProjectModel {
  readonly types: readonly ModelContentTypeDefinition[]
  readonly objects: readonly ModelObjectDefinition[]
}

export interface ModelClientOptions {
  readonly baseUrl: string
  readonly key: string
  readonly fetchImpl?: typeof fetch | undefined
}

function parseFields(value: unknown, context: string): ModelFieldDefinition[] {
  if (!Array.isArray(value)) {
    throw new CliError(`The API returned an unexpected ${context}.`, EXIT.error)
  }
  return value.flatMap((entry) => {
    const record = asRecord(entry)
    if (record === undefined) return []
    const name = record['name']
    const kind = record['kind']
    if (typeof name !== 'string' || typeof kind !== 'string') return []
    return [
      {
        name,
        kind,
        required: record['required'] === true,
        ...(typeof record['title'] === 'string' ? { title: record['title'] } : {}),
        ...(typeof record['repeated'] === 'boolean' ? { repeated: record['repeated'] } : {}),
        ...(Array.isArray(record['options'])
          ? { options: record['options'].filter((o): o is string => typeof o === 'string') }
          : {}),
        ...(Array.isArray(record['to'])
          ? { to: record['to'].filter((o): o is string => typeof o === 'string') }
          : {}),
        ...(Array.isArray(record['blocks'])
          ? { blocks: record['blocks'].filter((o): o is string => typeof o === 'string') }
          : {}),
        ...(typeof record['of'] === 'string' ? { of: record['of'] } : {}),
        ...(record['deprecated'] === true ? { deprecated: true } : {}),
      },
    ]
  })
}

function parseObjectDefinition(entry: unknown): ModelObjectDefinition | undefined {
  const record = asRecord(entry)
  if (record === undefined) return undefined
  const key = record['key']
  if (typeof key !== 'string') return undefined
  const title = record['title']
  return {
    key,
    title: typeof title === 'string' ? title : key,
    fields: parseFields(record['fields'], `definition of "${key}"`),
  }
}

function parseContentTypeDefinition(entry: unknown): ModelContentTypeDefinition | undefined {
  const base = parseObjectDefinition(entry)
  if (base === undefined) return undefined
  const record = asRecord(entry) ?? {}
  const titleField = record['titleField']
  const slugField = record['slugField']
  const cardinality = record['cardinality']
  const group = record['group']
  return {
    ...base,
    titleField: typeof titleField === 'string' ? titleField : 'title',
    slugField: typeof slugField === 'string' ? slugField : 'slug',
    // Only `single` is carried through. Anything else — absent, `many`, or a
    // value a future version invented — reads as the default, so a CLI one
    // deploy behind never mistakes an unknown cardinality for a restriction it
    // would then enforce in its own output.
    ...(cardinality === 'single' ? { cardinality: 'single' as const } : {}),
    ...(typeof group === 'string' && group.length > 0 ? { group } : {}),
  }
}

export async function fetchProjectModel(options: ModelClientOptions): Promise<ProjectModel> {
  const url = `${options.baseUrl}/types`
  const body = await json(url, { key: options.key, ...withFetch(options.fetchImpl) })
  const root = asRecord(body)
  if (root === undefined) {
    throw new CliError('The API returned an unexpected content model.', EXIT.error)
  }
  const types = Array.isArray(root['types']) ? root['types'] : []
  const objects = Array.isArray(root['objects']) ? root['objects'] : []
  return {
    types: types.flatMap((entry) => {
      const parsed = parseContentTypeDefinition(entry)
      return parsed === undefined ? [] : [parsed]
    }),
    objects: objects.flatMap((entry) => {
      const parsed = parseObjectDefinition(entry)
      return parsed === undefined ? [] : [parsed]
    }),
  }
}

export async function listProjectObjects(
  options: ModelClientOptions,
): Promise<readonly ModelObjectDefinition[]> {
  const url = `${options.baseUrl}/objects`
  const body = await json(url, { key: options.key, ...withFetch(options.fetchImpl) })
  const root = asRecord(body)
  const objects = root === undefined ? undefined : root['objects']
  if (!Array.isArray(objects)) {
    throw new CliError('The API returned an unexpected object list.', EXIT.error)
  }
  return objects.flatMap((entry) => {
    const parsed = parseObjectDefinition(entry)
    return parsed === undefined ? [] : [parsed]
  })
}

function requireObject(body: unknown, what: string): ModelObjectDefinition {
  const root = asRecord(body)
  const parsed = root === undefined ? undefined : parseObjectDefinition(root['object'])
  if (parsed === undefined) {
    throw new CliError(`The API returned an unexpected ${what}.`, EXIT.error)
  }
  return parsed
}

export async function createProjectObject(
  options: ModelClientOptions,
  input: ModelObjectDefinition,
): Promise<ModelObjectDefinition> {
  const url = `${options.baseUrl}/objects`
  const body = await json(url, {
    method: 'POST',
    key: options.key,
    body: { key: input.key, title: input.title, fields: input.fields },
    ...withFetch(options.fetchImpl),
  })
  return requireObject(body, 'object definition')
}

export interface ObjectPatchInput {
  readonly title?: string | undefined
  readonly fields?: readonly ModelFieldDefinition[] | undefined
}

export async function updateProjectObject(
  options: ModelClientOptions,
  key: string,
  patch: ObjectPatchInput,
): Promise<ModelObjectDefinition> {
  const url = `${options.baseUrl}/objects/${encodeURIComponent(key)}`
  const body = await json(url, {
    method: 'PATCH',
    key: options.key,
    body: {
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.fields === undefined ? {} : { fields: patch.fields }),
    },
    ...withFetch(options.fetchImpl),
  })
  return requireObject(body, 'object definition')
}

export async function deleteProjectObject(
  options: ModelClientOptions,
  key: string,
): Promise<boolean> {
  const url = `${options.baseUrl}/objects/${encodeURIComponent(key)}`
  const raw = await send(url, {
    method: 'DELETE',
    key: options.key,
    ...withFetch(options.fetchImpl),
  })
  if (raw.status < 200 || raw.status >= 300) throw apiFailure(url, raw)
  return asRecord(raw.body)?.['deleted'] === true
}

/* ── content types (M11) ──────────────────────────────────────────────────── */

export interface ContentTypeInput {
  readonly key: string
  readonly title: string
  readonly titleField: string
  readonly slugField: string
  readonly cardinality?: 'single' | 'many' | undefined
  readonly group?: string | undefined
  readonly fields: readonly ModelFieldDefinition[]
}

export interface ContentTypePatchInput {
  readonly title?: string | undefined
  readonly titleField?: string | undefined
  readonly slugField?: string | undefined
  readonly cardinality?: 'single' | 'many' | undefined
  readonly group?: string | undefined
  readonly fields?: readonly ModelFieldDefinition[] | undefined
}

function requireContentType(body: unknown, what: string): ModelContentTypeDefinition {
  const root = asRecord(body)
  const parsed = root === undefined ? undefined : parseContentTypeDefinition(root['type'])
  if (parsed === undefined) {
    throw new CliError(`The API returned an unexpected ${what}.`, EXIT.error)
  }
  return parsed
}

export async function createProjectContentType(
  options: ModelClientOptions,
  input: ContentTypeInput,
): Promise<ModelContentTypeDefinition> {
  const url = `${options.baseUrl}/types`
  const body = await json(url, {
    method: 'POST',
    key: options.key,
    body: {
      key: input.key,
      title: input.title,
      titleField: input.titleField,
      slugField: input.slugField,
      ...(input.cardinality === undefined ? {} : { cardinality: input.cardinality }),
      ...(input.group === undefined ? {} : { group: input.group }),
      fields: input.fields,
    },
    ...withFetch(options.fetchImpl),
  })
  return requireContentType(body, 'content type')
}

export async function updateProjectContentType(
  options: ModelClientOptions,
  key: string,
  patch: ContentTypePatchInput,
): Promise<ModelContentTypeDefinition> {
  const url = `${options.baseUrl}/types/${encodeURIComponent(key)}`
  const body = await json(url, {
    method: 'PATCH',
    key: options.key,
    body: {
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.titleField === undefined ? {} : { titleField: patch.titleField }),
      ...(patch.slugField === undefined ? {} : { slugField: patch.slugField }),
      ...(patch.cardinality === undefined ? {} : { cardinality: patch.cardinality }),
      ...(patch.group === undefined ? {} : { group: patch.group }),
      ...(patch.fields === undefined ? {} : { fields: patch.fields }),
    },
    ...withFetch(options.fetchImpl),
  })
  return requireContentType(body, 'content type')
}

export async function deleteProjectContentType(
  options: ModelClientOptions,
  key: string,
): Promise<boolean> {
  const url = `${options.baseUrl}/types/${encodeURIComponent(key)}`
  const raw = await send(url, {
    method: 'DELETE',
    key: options.key,
    ...withFetch(options.fetchImpl),
  })
  if (raw.status < 200 || raw.status >= 300) throw apiFailure(url, raw)
  return asRecord(raw.body)?.['deleted'] === true
}
