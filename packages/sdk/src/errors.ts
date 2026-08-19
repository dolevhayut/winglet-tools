/**
 * Every failure this package can produce, as a closed set of named classes.
 *
 * A missing document is NOT an error — `getPage('nope')` resolves to `null`, so
 * a page that renders a 404 does not need a try/catch. Anything else (no config,
 * a dead network, a rejected key, a response that does not match the contract)
 * throws one of these, and `isContentError` narrows to the union.
 */

/** §9's error codes, plus the INTERNAL code the API adds for its own failures. */
export const API_ERROR_CODES = [
  'INVALID_KEY',
  'NOT_FOUND',
  'LIMIT_EXCEEDED',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'CLAIM_EXPIRED',
  'INTERNAL',
  /*
   * `NOT_FOUND` was called `PROJECT_NOT_FOUND` until 2026-08-20. It is kept here,
   * last so it reads as the leftover it is, because THIS package is the reason
   * the rename was a breaking change: 0.3.1 turns the code into `null` for a
   * missing page, so an API that stopped sending it made every deployed site
   * throw where it used to render a 404.
   *
   * Listing both is what makes the deploy ORDER stop mattering — this client is
   * correct against an API on either side of the rename, so neither has to ship
   * first. Removable once nothing is serving the old name.
   */
  'PROJECT_NOT_FOUND',
] as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

/**
 * The codes that mean "no such thing here" — both spellings, for the reason
 * above. Anything reading `code` to decide 404-ness must use this, not equality.
 */
export const NOT_FOUND_CODES: readonly ApiErrorCode[] = ['NOT_FOUND', 'PROJECT_NOT_FOUND']

export function isNotFoundCode(value: unknown): boolean {
  return typeof value === 'string' && (NOT_FOUND_CODES as readonly string[]).includes(value)
}

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && (API_ERROR_CODES as readonly string[]).includes(value)
}

/** The base every error in this package extends. */
export abstract class ContentError extends Error {
  protected constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message)
    if (options !== undefined && 'cause' in options) this.cause = options.cause
  }
}

export function isContentError(value: unknown): value is ContentError {
  return value instanceof ContentError
}

/**
 * A required environment variable is absent. Thrown at the first call rather
 * than at import time, so that merely importing the package in a unit test with
 * no configuration does not explode.
 */
export class MissingConfigError extends ContentError {
  override readonly name = 'MissingConfigError'
  readonly variable: string

  constructor(variable: string, hint: string) {
    super(`Missing required environment variable ${variable}. ${hint}`)
    this.variable = variable
  }
}

/** The request never produced an HTTP response: DNS, TLS, timeout, abort. */
export class TransportError extends ContentError {
  override readonly name = 'TransportError'
  readonly url: string

  constructor(url: string, cause: unknown) {
    super(`Could not reach the content API at ${url}.`, { cause })
    this.url = url
  }
}

/** A response arrived, and it was a failure envelope (or an unparseable body). */
export class ApiResponseError extends ContentError {
  override readonly name = 'ApiResponseError'
  readonly status: number
  readonly code: ApiErrorCode | 'UNKNOWN'
  readonly url: string

  constructor(input: {
    readonly status: number
    readonly code: ApiErrorCode | 'UNKNOWN'
    readonly message: string
    readonly url: string
  }) {
    super(input.message)
    this.status = input.status
    this.code = input.code
    this.url = input.url
  }
}

/**
 * The response was a 200 whose body does not match the §8 contract — a document
 * carrying a block type this version does not know, for instance. Surfaced
 * rather than coerced: silently dropping fields would make a content bug look
 * like an empty page.
 */
export class ContentValidationError extends ContentError {
  override readonly name = 'ContentValidationError'
  readonly url: string
  readonly issues: readonly { readonly path: string; readonly message: string }[]

  constructor(
    url: string,
    issues: readonly { readonly path: string; readonly message: string }[],
  ) {
    const detail = issues
      .slice(0, 5)
      .map((issue) => `${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`)
      .join('; ')
    super(`Content from ${url} does not match the expected schema. ${detail}`)
    this.url = url
    this.issues = issues
  }
}
