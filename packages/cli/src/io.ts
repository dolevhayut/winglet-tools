/**
 * Everything ambient a command may touch: streams, cwd, environment.
 *
 * Commands never reach for `process` directly. That is what makes the whole
 * CLI callable in-process from a test with its output captured, and it is why
 * `run()` can be asserted on without spawning a shell.
 */
export interface Io {
  readonly write: (text: string) => void
  readonly writeError: (text: string) => void
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  /** True only for a real interactive terminal — false for a pipe, a file, or a test. */
  readonly isTTY: boolean
}

export function processIo(): Io {
  return {
    write: (text) => {
      process.stdout.write(text)
    },
    writeError: (text) => {
      process.stderr.write(text)
    },
    cwd: process.cwd(),
    env: process.env,
    isTTY: process.stdout.isTTY === true,
  }
}

/**
 * Buffers output instead of writing it. Used by the tests, and by nothing else.
 */
export interface CapturedIo extends Io {
  readonly stdout: () => string
  readonly stderr: () => string
}

export function captureIo(options: {
  readonly cwd: string
  readonly env?: Readonly<Record<string, string | undefined>>
}): CapturedIo {
  const out: string[] = []
  const err: string[] = []
  return {
    write: (text) => out.push(text),
    writeError: (text) => err.push(text),
    cwd: options.cwd,
    env: options.env ?? {},
    isTTY: false,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}

/* ── the one line-formatting vocabulary the whole CLI shares ──────────────── */

/**
 * §11: "אפס prompts אינטראקטיביים" and an agent reads this. No spinners, no
 * carriage returns, no colour: one fact per line, always terminated.
 */
export const MARK = {
  done: '✔',
  warn: '!',
  info: '·',
} as const

export function line(mark: string, text: string): string {
  return `${mark} ${text}\n`
}
