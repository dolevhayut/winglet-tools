/**
 * PRD §11's exit-code contract.
 *
 * An agent is the primary caller and it branches on the number, not on the
 * message, so these four values are part of the public interface. Every failure
 * path in this package throws a `CliError` carrying one of them; nothing else
 * is allowed to decide the process's fate.
 */
export const EXIT = {
  ok: 0,
  /** Anything the caller can fix by changing the command or the project. */
  error: 1,
  /** Not a supported environment — no Next.js App Router here. */
  unsupportedEnvironment: 2,
  /** A plan limit, a rate limit, or the network/server being unavailable. */
  limitOrNetwork: 3,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/**
 * A failure with a decided exit code and, where one exists, a concrete next
 * action. `hint` is printed on its own line after the message so a human skims
 * it and an agent can still parse the first line as the error.
 */
export class CliError extends Error {
  override readonly name = 'CliError'
  readonly exitCode: ExitCode
  readonly hint: string | undefined

  constructor(message: string, exitCode: ExitCode = EXIT.error, hint?: string) {
    super(message)
    this.exitCode = exitCode
    this.hint = hint
  }
}

export function isCliError(value: unknown): value is CliError {
  return value instanceof CliError
}

/** Every non-`CliError` throw becomes a general error with its message kept. */
export function toCliError(value: unknown): CliError {
  if (isCliError(value)) return value
  const message = value instanceof Error ? value.message : String(value)
  return new CliError(message, EXIT.error)
}
