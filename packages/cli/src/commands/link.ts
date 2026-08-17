import { CLI_BIN, ENV, TYPES_FILE } from '@product'

import { verifyReadKey } from '../api'
import { detectNextApp } from '../detect'
import { ENV_FILE } from '../env-file'
import { CliError, EXIT } from '../exit'
import { MARK, line } from '../io'
import type { Io } from '../io'
import { writeLocalConfig } from '../local-config'
import { manualInstruction } from '../next-config'
import { generateRevalidateSecret, scaffold } from '../scaffold'
import type { CommonOptions } from './context'
import { emitJson, loadPartialContext } from './context'

/**
 * `link <projectId>` — §11's "חיבור לפרויקט קיים".
 *
 * The second half of `init`, for a project that already exists: a second
 * developer cloning the repo, a site being pointed at a project created from
 * the studio, or an agent re-attaching after `.env.local` was lost.
 *
 * It VERIFIES BEFORE IT WRITES. A read key is proven against the live Content
 * API first, so a typo fails here with a clear message instead of producing a
 * plausible-looking `.env.local` that only breaks at the customer's next build.
 * Keys cannot be recovered from the server (§14.8 stores hashes), so the caller
 * has to supply the read key; the write and preview keys are optional because
 * a build-only checkout needs neither.
 */

export interface LinkOptions extends CommonOptions {
  readonly readKey?: string | undefined
  readonly writeKey?: string | undefined
  readonly previewKey?: string | undefined
  readonly types?: boolean | undefined
  readonly force?: boolean | undefined
}

export async function linkCommand(
  io: Io,
  projectId: string,
  options: LinkOptions,
): Promise<void> {
  const partial = loadPartialContext(io, options)
  const app = detectNextApp(partial.root)

  const readKey = options.readKey ?? partial.value(ENV.readKey)
  if (readKey === undefined) {
    throw new CliError(
      `A read key is required to link project ${projectId}.`,
      EXIT.error,
      [
        `Pass it explicitly: \`${CLI_BIN} link ${projectId} --read-key <key>\`,`,
        `or set ${ENV.readKey} in ${ENV_FILE} or the environment.`,
        'Keys are shown once at creation and stored only as hashes — the server cannot resend one.',
      ].join('\n'),
    )
  }

  const servedProjectId = await verifyReadKey(partial.apiBaseUrl, readKey)
  if (servedProjectId !== projectId) {
    throw new CliError(
      `That read key belongs to project ${servedProjectId}, not ${projectId}.`,
      EXIT.error,
      `Re-run with the id the key serves: \`${CLI_BIN} link ${servedProjectId} --read-key <key>\`.`,
    )
  }

  // A config pointing at a *different* project is superseded, claim token and
  // all; one pointing at this project is carried over untouched, because `link`
  // never learns a claim token (only creation returns it) and must not erase it.
  const previous =
    partial.config !== undefined && partial.config.projectId === projectId
      ? partial.config
      : undefined

  const result = scaffold({
    app,
    projectId,
    projectName: previous?.name,
    apiBaseUrl: partial.apiBaseUrl,
    keys: {
      read: readKey,
      write: options.writeKey ?? partial.value(ENV.writeKey),
      preview: options.previewKey ?? partial.value(ENV.previewKey),
    },
    revalidateSecret: partial.value(ENV.revalidateSecret) ?? generateRevalidateSecret(),
    writeTypes: options.types !== false,
    force: options.force === true,
  })

  const now = new Date()
  const configPath = writeLocalConfig(app.root, {
    projectId,
    slug: previous?.slug,
    name: previous?.name,
    apiUrl: partial.apiBaseUrl,
    claim: previous?.claim,
    createdAt: previous?.createdAt,
    updatedAt: now.toISOString(),
  })

  if (options.json === true) {
    emitJson(io, {
      ok: true,
      command: 'link',
      project: { id: projectId },
      apiBaseUrl: partial.apiBaseUrl,
      files: {
        env: { path: result.env.path, outcome: result.env.outcome, keys: result.envChanged },
        types: result.types === undefined ? null : { path: result.types.path, outcome: result.types.outcome },
        agents: { path: result.agents.path, outcome: result.agents.outcome },
        revalidate: { path: result.revalidate.path, outcome: result.revalidate.outcome },
        nextConfig: {
          path: result.nextConfig.path,
          outcome: result.nextConfig.outcome,
          manual: result.nextConfig.manual ?? null,
        },
        config: { path: configPath },
        gitignoreAdded: result.gitignoreAdded,
      },
    })
    return
  }

  io.write(line(MARK.done, `Linked project ${projectId}`))
  io.write(line(MARK.done, `${result.env.outcome === 'unchanged' ? 'Already configured:' : 'Wrote'} ${ENV_FILE}`))
  if (result.types !== undefined) {
    io.write(
      line(MARK.done, `${result.types.outcome === 'unchanged' ? 'Types up to date' : 'Generated types'} → ${TYPES_FILE}`),
    )
  }
  io.write(line(MARK.done, `${result.agents.outcome === 'unchanged' ? 'Up to date:' : 'Wrote'} ${result.agents.label}`))
  io.write(
    line(
      result.revalidate.outcome === 'kept' ? MARK.warn : MARK.done,
      `${result.revalidate.outcome === 'kept' ? 'Kept your edited revalidate route at' : 'Revalidate route →'} ${result.revalidate.label}`,
    ),
  )
  io.write(
    line(
      result.nextConfig.outcome === 'kept' ? MARK.warn : MARK.done,
      `${result.nextConfig.outcome === 'kept' ? 'Left your Next config untouched:' : 'AI-crawler metadata config →'} ${result.nextConfig.label}`,
    ),
  )
  const manual = manualInstruction(result.nextConfig)
  if (manual !== undefined) io.write(`\n${manual}\n`)

  io.write(`\nRead content with \`getPage('home')\`. Run \`${CLI_BIN} pull\` for a local copy.\n`)
}
