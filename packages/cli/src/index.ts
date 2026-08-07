#!/usr/bin/env node
import { processIo } from './io'
import { run } from './program'

/**
 * The binary. PRD §11's entry point: `npx <the CLI> init`.
 *
 * All it does is bind the real process to `run()` and record the exit code.
 * `process.exitCode` rather than `process.exit()`, so stdout is flushed before
 * the process ends — an agent that reads the output of a piped command must not
 * lose the last lines to a truncated write.
 */

export { EXIT } from './exit'
export type { ExitCode } from './exit'
export { run, buildProgram } from './program'
export { processIo, captureIo } from './io'
export type { Io } from './io'

run(process.argv.slice(2), processIo())
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    // Unreachable: `run` converts every throw into an exit code. Here so a bug
    // in that promise surfaces as a message rather than an unhandled rejection.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
