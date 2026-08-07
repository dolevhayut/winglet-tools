import { CLI_BIN, ENV } from '@product'

import { resolveApiBaseUrl } from '../api'
import { resolveRoot } from '../detect'
import { ENV_FILE, readEnvValues } from '../env-file'
import { CliError, EXIT } from '../exit'
import type { Io } from '../io'
import type { LocalConfig } from '../local-config'
import { readLocalConfig } from '../local-config'

/**
 * How every command finds the project it is operating on.
 *
 * Two sources, in this order: the `.env.local` the CLI wrote, then the ambient
 * process environment. The file wins because it is the project's own answer —
 * a developer with a different project exported in their shell should still get
 * this site's content when they run the command inside this site.
 */

export interface CommonOptions {
  readonly cwd?: string | undefined
  readonly json?: boolean | undefined
  readonly apiUrl?: string | undefined
}

export interface ProjectContext {
  readonly root: string
  readonly apiBaseUrl: string
  readonly projectId: string
  readonly readKey: string
  readonly writeKey: string | undefined
  readonly previewKey: string | undefined
  readonly config: LocalConfig | undefined
}

export interface PartialContext {
  readonly root: string
  readonly apiBaseUrl: string
  readonly env: ReadonlyMap<string, string>
  readonly config: LocalConfig | undefined
  readonly value: (name: string) => string | undefined
}

export function loadPartialContext(
  io: Io,
  options: CommonOptions,
): PartialContext {
  const root = resolveRoot(io.cwd, options.cwd)
  const env = readEnvValues(root)
  const config = readLocalConfig(root)
  const value = (name: string): string | undefined => env.get(name) ?? io.env[name]

  return {
    root,
    apiBaseUrl: resolveApiBaseUrl(options.apiUrl, value(ENV.apiUrl) ?? config?.apiUrl),
    env,
    config,
    value,
  }
}

/** The same, but the project must already be configured. */
export function loadProjectContext(io: Io, options: CommonOptions): ProjectContext {
  const partial = loadPartialContext(io, options)
  const projectId = partial.value(ENV.projectId) ?? partial.config?.projectId
  const readKey = partial.value(ENV.readKey)

  if (projectId === undefined || readKey === undefined) {
    const missing: string[] = []
    if (projectId === undefined) missing.push(ENV.projectId)
    if (readKey === undefined) missing.push(ENV.readKey)

    throw new CliError(
      `No project configured in ${partial.root} (missing ${missing.join(' and ')}).`,
      EXIT.error,
      `Run \`${CLI_BIN} init\` to create one, or \`${CLI_BIN} link <projectId> --read-key <key>\`` +
        ` to connect to an existing one. Checked ${ENV_FILE} and the process environment.`,
    )
  }

  return {
    root: partial.root,
    apiBaseUrl: partial.apiBaseUrl,
    projectId,
    readKey,
    writeKey: partial.value(ENV.writeKey),
    previewKey: partial.value(ENV.previewKey),
    config: partial.config,
  }
}

/* ── output ───────────────────────────────────────────────────────────────── */

/**
 * `--json` prints one object and nothing else, so an agent can pipe the command
 * straight into a parser. Human output never mixes in.
 */
export function emitJson(io: Io, payload: Readonly<Record<string, unknown>>): void {
  io.write(`${JSON.stringify(payload, null, 2)}\n`)
}
