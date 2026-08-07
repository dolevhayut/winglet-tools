import { readFileSync } from 'node:fs'

import { CLI_BIN, PRODUCT_NAME, SDK_PACKAGE, TYPES_FILE } from '@product'
import { Command, CommanderError } from 'commander'

import { claimCommand } from './commands/claim'
import type { ClaimOptions } from './commands/claim'
import { initCommand } from './commands/init'
import type { InitOptions } from './commands/init'
import { linkCommand } from './commands/link'
import type { LinkOptions } from './commands/link'
import { pullCommand } from './commands/pull'
import type { PullOptions } from './commands/pull'
import { typesCommand } from './commands/types'
import type { TypesOptions } from './commands/types'
import { usageCommand } from './commands/usage'
import type { UsageOptions } from './commands/usage'
import { EXIT, toCliError } from './exit'
import type { ExitCode } from './exit'
import { MARK, line } from './io'
import type { Io } from './io'

/**
 * §11's six commands, wired to a real argument parser.
 *
 * NOTHING HERE IS INTERACTIVE. Every command takes flags with defaults; there
 * is no prompt, no confirmation, no `--yes`, and no code path in this package
 * reads stdin. `--json` on every command gives an agent a single parseable
 * object instead of prose.
 *
 * The parser is configured never to call `process.exit` itself: `run()` returns
 * the exit code and the binary assigns it, so the whole CLI is callable
 * in-process from a test with its output captured.
 */

const CWD_FLAG = '-C, --cwd <dir>'
const CWD_HELP = 'project directory (default: the nearest package.json)'
const JSON_HELP = 'print a single JSON object instead of human-readable output'
const API_URL_HELP = 'API base URL (default: the configured or built-in one)'

function version(): string {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    )
    if (typeof manifest === 'object' && manifest !== null) {
      const value = (manifest as Record<string, unknown>)['version']
      if (typeof value === 'string') return value
    }
  } catch {
    // A bundled binary without its manifest still has to run.
  }
  return '0.0.0'
}

export function buildProgram(io: Io): Command {
  const program = new Command()

  program
    .name(CLI_BIN)
    .description(`${PRODUCT_NAME} — content for sites built by coding agents`)
    .version(version(), '-v, --version')
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        io.write(text)
      },
      writeErr: (text) => {
        io.writeError(text)
      },
      outputError: (text, write) => {
        write(text)
      },
    })

  program.addHelpText(
    'after',
    [
      '',
      'Typical use, start to finish:',
      `  npx ${CLI_BIN} init            create a project and wire it into this site`,
      `  npx ${CLI_BIN} types           refresh ${TYPES_FILE} after a CLI upgrade`,
      `  npx ${CLI_BIN} claim           reprint the owner adoption link`,
      '',
      `Content is read at build time through ${SDK_PACKAGE}. Exit codes: 0 ok, 1 error,`,
      '2 unsupported environment, 3 limit or network.',
      '',
    ].join('\n'),
  )

  program
    .command('init')
    .description('create a project, write .env.local, generate types, seed content')
    .option(CWD_FLAG, CWD_HELP)
    .option('--name <name>', 'project name (default: the name in package.json)')
    .option('--slug <slug>', 'project slug (default: derived from the name)')
    .option('--api-url <url>', API_URL_HELP)
    .option('--agent-fingerprint <value>', 'identifies the agent running this, for abuse handling')
    .option('--no-install', `do not install ${SDK_PACKAGE}`)
    .option('--no-types', `do not generate ${TYPES_FILE}`)
    .option('--force', 'overwrite a revalidate route handler you have edited')
    .option('--json', JSON_HELP)
    .action(async (options: InitOptions) => {
      await initCommand(io, options)
    })

  program
    .command('types')
    .description(`regenerate ${TYPES_FILE}`)
    .option(CWD_FLAG, CWD_HELP)
    .option('--json', JSON_HELP)
    .action((options: TypesOptions) => {
      typesCommand(io, options)
    })

  program
    .command('pull')
    .description('pull this project’s content to local JSON')
    .option(CWD_FLAG, CWD_HELP)
    .option('--out <dir>', 'destination directory')
    .option('--api-url <url>', API_URL_HELP)
    .option('--json', JSON_HELP)
    .action(async (options: PullOptions) => {
      await pullCommand(io, options)
    })

  program
    .command('claim')
    .description('reprint the owner claim link stored locally')
    .option(CWD_FLAG, CWD_HELP)
    .option('--json', JSON_HELP)
    .action((options: ClaimOptions) => {
      claimCommand(io, options)
    })

  program
    .command('usage')
    .description('counters against plan limits')
    .option(CWD_FLAG, CWD_HELP)
    .option('--plan <plan>', 'compare against a specific plan instead of inferring one')
    .option('--api-url <url>', API_URL_HELP)
    .option('--json', JSON_HELP)
    .action(async (options: UsageOptions) => {
      await usageCommand(io, options)
    })

  program
    .command('link')
    .argument('<projectId>', 'the project to connect this site to')
    .description('connect this site to an existing project')
    .requiredOption('--read-key <key>', 'the project’s read key')
    .option('--write-key <key>', 'the project’s write key')
    .option('--preview-key <key>', 'the project’s preview key')
    .option(CWD_FLAG, CWD_HELP)
    .option('--api-url <url>', API_URL_HELP)
    .option('--no-types', `do not generate ${TYPES_FILE}`)
    .option('--force', 'overwrite a revalidate route handler you have edited')
    .option('--json', JSON_HELP)
    .action(async (projectId: string, options: LinkOptions) => {
      await linkCommand(io, projectId, options)
    })

  return program
}

/** Commander's own exits that are successes, not failures. */
const HELP_CODES: ReadonlySet<string> = new Set([
  'commander.help',
  'commander.helpDisplayed',
  'commander.version',
])

export async function run(argv: readonly string[], io: Io): Promise<ExitCode> {
  const program = buildProgram(io)

  if (argv.length === 0) {
    io.write(program.helpInformation())
    return EXIT.ok
  }

  try {
    await program.parseAsync([...argv], { from: 'user' })
    return EXIT.ok
  } catch (error) {
    if (error instanceof CommanderError) {
      // Commander has already written its own message through `configureOutput`.
      return HELP_CODES.has(error.code) ? EXIT.ok : EXIT.error
    }

    const failure = toCliError(error)
    io.writeError(line(MARK.warn, failure.message))
    if (failure.hint !== undefined) {
      io.writeError(`${failure.hint.split('\n').map((entry) => `  ${entry}`).join('\n')}\n`)
    }
    return failure.exitCode
  }
}
