import { readFileSync } from 'node:fs'

import { CLI_BIN, PRODUCT_NAME, SDK_PACKAGE, TYPES_FILE } from '@product'
import { Command, CommanderError } from 'commander'

import { claimCommand } from './commands/claim'
import type { ClaimOptions } from './commands/claim'
import { createCommand } from './commands/create'
import type { CreateOptions } from './commands/create'
import { deleteCommand } from './commands/delete'
import type { DeleteOptions } from './commands/delete'
import { editCommand } from './commands/edit'
import type { EditOptions } from './commands/edit'
import { getCommand } from './commands/get'
import type { GetOptions } from './commands/get'
import { initCommand } from './commands/init'
import type { InitOptions } from './commands/init'
import { linkCommand } from './commands/link'
import type { LinkOptions } from './commands/link'
import { listCommand } from './commands/list'
import type { ListOptions } from './commands/list'
import {
  objectsAddCommand,
  objectsListCommand,
  objectsRmCommand,
  objectsSetCommand,
} from './commands/objects'
import type {
  ObjectsAddOptions,
  ObjectsListOptions,
  ObjectsRmOptions,
  ObjectsSetOptions,
} from './commands/objects'
import { publishCommand } from './commands/publish'
import type { PublishOptions } from './commands/publish'
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
 * §11's six project-setup commands, plus content editing: `list`, `get`,
 * `create`, `edit`, `publish`, `delete` mirror the MCP server's five tools
 * (list_documents/get_document/create_document/update_document/publish) so
 * an agent can edit content from the same CLI it used to connect the site,
 * with no separate MCP install. `delete` is the one operation MCP does not
 * expose at all.
 *
 * NOTHING HERE IS INTERACTIVE. Every command takes flags with defaults; there
 * is no prompt, no confirmation, no `--yes`, and no code path in this package
 * reads stdin. `--json` on every command gives an agent a single parseable
 * object instead of prose — `list` and `get` skip the flag entirely and are
 * always JSON, since nothing about "here is a document's raw data" benefits
 * from a prose rendering.
 *
 * The parser is configured never to call `process.exit` itself: `run()` returns
 * the exit code and the binary assigns it, so the whole CLI is callable
 * in-process from a test with its output captured.
 */

const CWD_FLAG = '-C, --cwd <dir>'
const CWD_HELP = 'project directory (default: the nearest package.json)'
const JSON_HELP = 'print a single JSON object instead of human-readable output'
const API_URL_HELP = 'API base URL (default: the configured or built-in one)'

/** Commander's accumulator for a repeatable `--set field=value` flag. */
function collectSet(value: string, previous: readonly string[]): string[] {
  return [...previous, value]
}

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
      'Shaping the content model:',
      `  ${CLI_BIN} objects list             the reusable field shapes this project defines`,
      `  ${CLI_BIN} objects add <key>        register one, e.g. --field question:string!`,
      `  ${CLI_BIN} objects set <key>        extend one — additive only`,
      '',
      'Editing content:',
      `  ${CLI_BIN} list                    every document, id/type/slug/status`,
      `  ${CLI_BIN} get <id>                one document in full`,
      `  ${CLI_BIN} create --type --slug    a new draft`,
      `  ${CLI_BIN} edit <id> --set k=v     change fields in the draft`,
      `  ${CLI_BIN} publish <id>            the draft goes live`,
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
    .description(`regenerate ${TYPES_FILE} from this project’s content model`)
    .option(CWD_FLAG, CWD_HELP)
    .option('--api-url <url>', API_URL_HELP)
    .option('--local', 'generate from the built-in schema without contacting the API')
    .option('--json', JSON_HELP)
    .action(async (options: TypesOptions) => {
      await typesCommand(io, options)
    })

  /**
   * `objects` — the content model, from the command line.
   *
   * A subcommand group rather than five top-level verbs: `objects` is a noun the
   * agent is operating ON, and keeping the verbs under it leaves room for
   * `types` to grow the same shape when content types become definable.
   */
  const objects = program
    .command('objects')
    .description('reusable field shapes this project defines (`object` fields point at these)')

  objects
    .command('list')
    .description('every object this project defines (always JSON)')
    .option('--types', 'include the content types too')
    .option(CWD_FLAG, CWD_HELP)
    .option('--api-url <url>', API_URL_HELP)
    .action(async (options: ObjectsListOptions) => {
      await objectsListCommand(io, options)
    })

  objects
    .command('add')
    .argument('<key>', 'the object name, e.g. galleryImage')
    .description('register a reusable field shape')
    .option('--title <title>', 'human label for the studio (default: the key)')
    .option(
      '--field <spec...>',
      'repeatable; name:kind, with [] for a list, ! for required, =a|b for select options',
      collectSet,
      [],
    )
    .option('--fields <json>', 'the full field list as a JSON array, or @path to a file')
    .option(CWD_FLAG, CWD_HELP)
    .option('--api-url <url>', API_URL_HELP)
    .option('--json', JSON_HELP)
    .action(async (key: string, options: ObjectsAddOptions) => {
      await objectsAddCommand(io, key, options)
    })

  objects
    .command('set')
    .argument('<key>', 'the object to change')
    .description('extend an object — additive only: nothing may be removed or retyped')
    .option('--rename <title>', 'change the human label')
    .option('--field <spec...>', 'repeatable; the FULL field list, existing fields included', collectSet, [])
    .option('--fields <json>', 'the full field list as a JSON array, or @path to a file')
    .option(CWD_FLAG, CWD_HELP)
    .option('--api-url <url>', API_URL_HELP)
    .option('--json', JSON_HELP)
    .action(async (key: string, options: ObjectsSetOptions) => {
      await objectsSetCommand(io, key, options)
    })

  objects
    .command('rm')
    .argument('<key>', 'the object to remove')
    .description('remove an object — refused while any content type still uses it')
    .option(CWD_FLAG, CWD_HELP)
    .option('--api-url <url>', API_URL_HELP)
    .option('--json', JSON_HELP)
    .action(async (key: string, options: ObjectsRmOptions) => {
      await objectsRmCommand(io, key, options)
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

  program
    .command('list')
    .description('list this project’s documents (always JSON)')
    .option('--type <type>', 'restrict to one content type')
    .option('--status <status>', 'restrict to one status, e.g. draft or published')
    .option(CWD_FLAG, CWD_HELP)
    .option('--api-url <url>', API_URL_HELP)
    .action(async (options: ListOptions) => {
      await listCommand(io, options)
    })

  program
    .command('get')
    .argument('<id>', 'the document id, from `list`')
    .description('read one document in full (always JSON)')
    .option(CWD_FLAG, CWD_HELP)
    .option('--api-url <url>', API_URL_HELP)
    .action(async (id: string, options: GetOptions) => {
      await getCommand(io, id, options)
    })

  program
    .command('create')
    .description('create a new draft document')
    .requiredOption('--type <type>', 'the content type, e.g. page or post')
    .requiredOption('--slug <slug>', 'lowercase letters, digits and hyphens')
    .option('--data <json>', 'the fields as a JSON object, or @path to a file')
    .option('--locale <locale>', 'defaults to the project’s default locale')
    .option(CWD_FLAG, CWD_HELP)
    .option('--api-url <url>', API_URL_HELP)
    .option('--json', JSON_HELP)
    .action(async (options: CreateOptions) => {
      await createCommand(io, options)
    })

  program
    .command('edit')
    .argument('<id>', 'the document id, from `list`')
    .description('change fields in a document’s draft — never the whole thing')
    .option('--set <field=value...>', 'repeatable; dot-path, e.g. seo.title=Hello', collectSet, [])
    .option('--data <json>', 'a JSON object of {"path.to.field": value}, or @path to a file')
    .option(CWD_FLAG, CWD_HELP)
    .option('--api-url <url>', API_URL_HELP)
    .option('--json', JSON_HELP)
    .action(async (id: string, options: EditOptions) => {
      await editCommand(io, id, options)
    })

  program
    .command('publish')
    .argument('<id>', 'the document id, from `list`')
    .description('publish a document — the only command that changes the live site')
    .option(CWD_FLAG, CWD_HELP)
    .option('--api-url <url>', API_URL_HELP)
    .option('--json', JSON_HELP)
    .action(async (id: string, options: PublishOptions) => {
      await publishCommand(io, id, options)
    })

  program
    .command('delete')
    .argument('<id>', 'the document id, from `list`')
    .description('delete a document — no confirmation prompt (§11: nothing here is interactive)')
    .option(CWD_FLAG, CWD_HELP)
    .option('--api-url <url>', API_URL_HELP)
    .option('--json', JSON_HELP)
    .action(async (id: string, options: DeleteOptions) => {
      await deleteCommand(io, id, options)
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
