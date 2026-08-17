import { CLI_BIN, ENV, SDK_PACKAGE, TYPES_FILE } from '@product'

import { createAnonymousProject } from '../api'
import type { AnonymousProject } from '../api'
import { printBanner } from '../banner'
import { CONTENT_TYPE_KEYS, CONTENT_TYPE_LIST, OBJECT_LIST } from '../../../sdk/src/definitions'
import { detectNextApp } from '../detect'
import type { NextApp } from '../detect'
import { ENV_FILE } from '../env-file'
import { CliError, EXIT } from '../exit'
import { claimLines, pluralise } from '../format'
import { installSdk } from '../install'
import type { InstallResult } from '../install'
import { MARK, line } from '../io'
import type { Io } from '../io'
import type { ClaimRecord } from '../local-config'
import { writeLocalConfig } from '../local-config'
import { manualInstruction } from '../next-config'
import { generateRevalidateSecret, scaffold } from '../scaffold'
import type { ScaffoldResult, WrittenFile } from '../scaffold'
import { TEMPLATE_NAMES, templateNamed } from '../templates'
import type { CommonOptions } from './context'
import { emitJson, loadPartialContext, loadProjectContext } from './context'
import { applyTemplate } from './types-model'

/**
 * `init` — PRD §4, the whole product in one command.
 *
 * THE THREE RULES THIS COMMAND IS BUILT AROUND
 * --------------------------------------------
 * 1. **Zero prompts, ever** (§11). Every parameter is a flag with a default,
 *    and nothing in this file or anything it calls reads stdin. An agent runs
 *    this unattended; a single question would hang it forever.
 * 2. **Idempotent** (§11, AC4). A second run must find the project in
 *    `.env.local` and refresh around it. The check happens before any network
 *    call, so a re-run cannot even accidentally create a second project.
 * 3. **Never fail after the project exists.** Once the API has answered, the
 *    customer owns a live project and a claim token that lives nowhere else.
 *    From that point on every step is best-effort and reported, never fatal —
 *    except writing the local config, which is what makes the token recoverable.
 */

export interface InitOptions extends CommonOptions {
  readonly name?: string | undefined
  readonly slug?: string | undefined
  readonly agentFingerprint?: string | undefined
  readonly install?: boolean | undefined
  readonly types?: boolean | undefined
  readonly force?: boolean | undefined
  /** A content model to start from, e.g. `hospitality` (M11). */
  readonly template?: string | undefined
}

interface ResolvedProject {
  readonly created: boolean
  readonly projectId: string
  readonly projectName: string | undefined
  readonly projectSlug: string | undefined
  readonly readKey: string
  readonly writeKey: string | undefined
  readonly previewKey: string | undefined
  readonly claim: ClaimRecord | undefined
  readonly seededTypes: readonly string[]
  readonly createdAt: string | undefined
}

/* ── project resolution ───────────────────────────────────────────────────── */

function fromExisting(
  projectId: string,
  read: (name: string) => string | undefined,
  previous: { name: string | undefined; slug: string | undefined; claim: ClaimRecord | undefined; createdAt: string | undefined },
): ResolvedProject {
  const readKey = read(ENV.readKey)
  if (readKey === undefined) {
    throw new CliError(
      `${ENV_FILE} names a project (${projectId}) but has no ${ENV.readKey}.`,
      EXIT.error,
      [
        'API keys are returned once at creation and stored only as hashes, so this one',
        'cannot be recovered from the server. Either:',
        `  · re-attach with the key you have — \`${CLI_BIN} link ${projectId} --read-key <key>\`, or`,
        `  · remove ${ENV.projectId} from ${ENV_FILE} to create a new project.`,
      ].join('\n'),
    )
  }

  return {
    created: false,
    projectId,
    projectName: previous.name,
    projectSlug: previous.slug,
    readKey,
    writeKey: read(ENV.writeKey),
    previewKey: read(ENV.previewKey),
    claim: previous.claim,
    seededTypes: CONTENT_TYPE_KEYS,
    createdAt: previous.createdAt,
  }
}

function fromCreated(created: AnonymousProject): ResolvedProject {
  return {
    created: true,
    projectId: created.project.id,
    projectName: created.project.name,
    projectSlug: created.project.slug,
    readKey: created.keys.read,
    writeKey: created.keys.write,
    previewKey: created.keys.preview,
    claim: {
      url: created.claim.url,
      token: created.claim.token,
      expiresAt: created.claim.expires_at,
    },
    seededTypes: created.seeded.content_types,
    createdAt: created.project.created_at,
  }
}

/** `my-site` from a package named `@acme/my-site`, when there is one. */
function defaultProjectName(app: NextApp): string | undefined {
  const name = app.packageName
  if (name === undefined) return undefined
  const bare = name.startsWith('@') ? (name.split('/')[1] ?? name) : name
  return bare.length > 0 ? bare : undefined
}

/* ── printing ─────────────────────────────────────────────────────────────── */

function fileLine(file: WrittenFile, verbs: Readonly<Record<string, string>>): string {
  const verb = verbs[file.outcome] ?? file.outcome
  return line(file.outcome === 'kept' ? MARK.warn : MARK.done, `${verb} ${file.label}`)
}

function installLine(result: InstallResult): string {
  switch (result.outcome) {
    case 'installed':
      return line(MARK.done, `Installed ${result.packageName}`)
    case 'already-present':
      return line(MARK.done, `${result.packageName} already installed`)
    case 'skipped':
      return line(MARK.info, `Skipped installing ${result.packageName} (--no-install)`)
    case 'failed':
      return line(
        MARK.warn,
        `Could not install ${result.packageName}${result.detail === undefined ? '' : ` — ${result.detail}`}\n` +
          `  Run it yourself: ${result.command}`,
      )
  }
}

function report(
  io: Io,
  resolved: ResolvedProject,
  result: ScaffoldResult,
  install: InstallResult,
  now: Date,
): void {
  printBanner(io)

  const label = resolved.projectName ?? resolved.projectSlug ?? resolved.projectId

  io.write(
    resolved.created
      ? line(MARK.done, `Created project "${label}" (anonymous)`)
      : line(MARK.done, `Found project "${label}" — ${resolved.projectId}`),
  )

  io.write(
    fileLine(result.env, {
      created: 'Wrote',
      updated: 'Updated',
      unchanged: 'Already configured:',
    }),
  )
  if (result.gitignoreAdded.length > 0) {
    io.write(line(MARK.done, `Ignored ${result.gitignoreAdded.join(', ')} in .gitignore`))
  }

  io.write(installLine(install))

  if (result.types !== undefined) {
    io.write(
      line(
        MARK.done,
        `${result.types.outcome === 'unchanged' ? 'Types up to date' : 'Generated types'} → ${TYPES_FILE}`,
      ),
    )
  }

  io.write(
    fileLine(result.agents, {
      created: 'Wrote',
      updated: 'Updated',
      unchanged: 'Up to date:',
    }),
  )
  io.write(
    fileLine(result.revalidate, {
      created: 'Mounted revalidate route →',
      updated: 'Updated revalidate route →',
      unchanged: 'Revalidate route in place →',
      kept: 'Kept your edited revalidate route at',
    }),
  )
  io.write(
    fileLine(result.nextConfig, {
      created: 'Wrote AI-crawler metadata config →',
      updated: 'Added AI-crawler metadata config to',
      unchanged: 'AI-crawler metadata config in place →',
      kept: 'Left your Next config untouched:',
    }),
  )
  const manual = manualInstruction(result.nextConfig)
  if (manual !== undefined) io.write(`\n${manual}\n\n`)

  const types = resolved.seededTypes
  io.write(
    line(
      MARK.done,
      `${resolved.created ? 'Seeded' : 'Serving'} ${pluralise(types.length, 'content type')} (${types.join(', ')})`,
    ),
  )

  io.write('\nYour content is live. Read it with:\n\n')
  io.write(`  import { getPage } from '${SDK_PACKAGE}'\n`)
  io.write(`  const home = await getPage('home')\n`)

  if (resolved.claim !== undefined) {
    io.write(`${claimLines(resolved.claim, now).join('\n')}\n`)
  } else {
    io.write(`\nNo claim link stored locally. Reprint options: \`${CLI_BIN} claim\`.\n`)
  }
}

/* ── the command ──────────────────────────────────────────────────────────── */

export async function initCommand(io: Io, options: InitOptions): Promise<void> {
  const partial = loadPartialContext(io, options)
  // Exit 2 before anything else: there is no point creating a project for a
  // repository that cannot consume it.
  const app = detectNextApp(partial.root)

  const knownProjectId = partial.value(ENV.projectId) ?? partial.config?.projectId

  const resolved =
    knownProjectId === undefined
      ? fromCreated(
          await createAnonymousProject({
            baseUrl: partial.apiBaseUrl,
            name: options.name ?? defaultProjectName(app),
            slug: options.slug,
            agentFingerprint: options.agentFingerprint,
          }),
        )
      : fromExisting(knownProjectId, partial.value, {
          name: partial.config?.name,
          slug: partial.config?.slug,
          claim: partial.config?.claim,
          createdAt: partial.config?.createdAt,
        })

  const revalidateSecret = partial.value(ENV.revalidateSecret) ?? generateRevalidateSecret()

  const result = scaffold({
    app,
    projectId: resolved.projectId,
    projectName: resolved.projectName,
    apiBaseUrl: partial.apiBaseUrl,
    keys: {
      read: resolved.readKey,
      write: resolved.writeKey,
      preview: resolved.previewKey,
    },
    revalidateSecret,
    writeTypes: options.types !== false,
    force: options.force === true,
  })

  // Before the install, which is the slowest and least reliable step: the claim
  // token exists nowhere else and must be on disk the moment it is knowable.
  const now = new Date()
  const configPath = writeLocalConfig(app.root, {
    projectId: resolved.projectId,
    slug: resolved.projectSlug,
    name: resolved.projectName,
    apiUrl: partial.apiBaseUrl,
    claim: resolved.claim,
    createdAt: resolved.createdAt,
    updatedAt: now.toISOString(),
  })

  // M11 — the template runs BEFORE the install and before the types file is
  // reported, so `init --template hospitality` leaves behind a project whose
  // generated types already describe the model it was given. Applying it after
  // would produce a types file one command out of date on its very first run.
  //
  // A failure here is loud but not fatal to the init: the project, the keys and
  // `.env.local` are already written and are the expensive, unrepeatable part.
  // Telling the operator to run one more command beats discarding a project
  // whose claim link has already been printed.
  let template: { readonly name: string; readonly applied: boolean; readonly message?: string } | undefined
  if (options.template !== undefined) {
    template = await applyTemplateDuringInit(io, options, options.template)
  }

  const install = installSdk({
    root: app.root,
    manager: app.packageManager,
    enabled: options.install !== false,
  })

  if (options.json === true) {
    emitJson(io, {
      ok: true,
      command: 'init',
      created: resolved.created,
      project: {
        id: resolved.projectId,
        name: resolved.projectName,
        slug: resolved.projectSlug,
      },
      apiBaseUrl: partial.apiBaseUrl,
      contentTypes: CONTENT_TYPE_LIST.map((definition) => definition.key),
      objects: OBJECT_LIST.map((definition) => definition.key),
      ...(template === undefined ? {} : { template }),
      files: {
        env: { path: result.env.path, outcome: result.env.outcome, keys: result.envChanged },
        types: result.types === undefined ? null : { path: result.types.path, outcome: result.types.outcome },
        agents: { path: result.agents.path, outcome: result.agents.outcome },
        revalidate: { path: result.revalidate.path, outcome: result.revalidate.outcome },
        nextConfig: {
          path: result.nextConfig.path,
          outcome: result.nextConfig.outcome,
          // Present only when the shape was not safe to edit. An agent reading
          // this JSON can then apply the line itself, which is the whole reason
          // the refusal carries the line rather than just a warning.
          manual: result.nextConfig.manual ?? null,
        },
        config: { path: configPath },
        gitignoreAdded: result.gitignoreAdded,
      },
      install: { outcome: install.outcome, package: install.packageName, command: install.command },
      claim:
        resolved.claim === undefined
          ? null
          : { url: resolved.claim.url, expiresAt: resolved.claim.expiresAt },
    })
    return
  }

  report(io, resolved, result, install, now)
}

/* ── templates during init (M11) ──────────────────────────────────────────── */

interface TemplateReport {
  readonly name: string
  readonly applied: boolean
  readonly message?: string
}

/**
 * Applies a template to the project `init` has just created.
 *
 * The context is re-loaded from disk rather than threaded through, and that is
 * deliberate: `.env.local` was written moments ago and is the same source every
 * other command reads, so this exercises the wiring `init` just produced instead
 * of trusting values it happens to hold in memory. If the keys it wrote do not
 * work, this is where that surfaces — during init, not on the operator's next
 * command.
 */
async function applyTemplateDuringInit(
  io: Io,
  options: InitOptions,
  name: string,
): Promise<TemplateReport> {
  if (templateNamed(name) === undefined) {
    const message = `There is no template called "${name}". Available: ${TEMPLATE_NAMES.join(', ')}.`
    io.writeError(line(MARK.warn, message))
    return { name, applied: false, message }
  }

  try {
    const context = loadProjectContext(io, options)
    const outcome = await applyTemplate(context, name)
    if (options.json !== true) {
      io.write(
        line(
          MARK.done,
          `Applied the "${name}" content model ` +
            `(${pluralise(outcome.types.created.length, 'type')}, ` +
            `${pluralise(outcome.objects.created.length, 'object')})`,
        ),
      )
    }
    return { name, applied: true }
  } catch (error: unknown) {
    // Never fatal. The project, its keys and the claim link already exist and
    // cannot be recreated by re-running; losing them because a template call
    // failed would be a far worse outcome than one extra command.
    const message = error instanceof Error ? error.message : String(error)
    io.writeError(
      line(MARK.warn, `The project was created, but the "${name}" template did not apply.`),
    )
    io.writeError(`  ${message}\n  Run \`${CLI_BIN} templates apply ${name}\` to retry.\n`)
    return { name, applied: false, message }
  }
}
