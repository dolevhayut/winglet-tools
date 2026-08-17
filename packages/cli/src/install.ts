import { spawnSync } from 'node:child_process'

import { SDK_PACKAGE, sdkDependencySpec } from '@product'

import type { PackageManager } from './detect'
import { isPackageInstalled } from './detect'

/**
 * §4's third line: "✔ Installed <the SDK>".
 *
 * NON-FATAL BY DESIGN. By the time this runs the project already exists, the
 * content is already live and `.env.local` is already written — the promise in
 * §4 has been kept. A registry outage, a proxy, or a lockfile the agent is not
 * allowed to touch must not turn that into a failed `init` and a half-configured
 * repository. A failure downgrades to a printed command the caller can run.
 */

const INSTALL_TIMEOUT_MS = 180_000

const ADD_ARGS: Readonly<Record<PackageManager, readonly string[]>> = {
  pnpm: ['add'],
  yarn: ['add'],
  bun: ['add'],
  npm: ['install'],
}

export type InstallOutcome = 'installed' | 'already-present' | 'skipped' | 'failed'

export interface InstallResult {
  readonly outcome: InstallOutcome
  readonly packageName: string
  /** The command a human should run when `outcome` is `failed`. */
  readonly command: string
  readonly detail: string | undefined
}

export function installCommand(manager: PackageManager): string {
  return [manager, ...(ADD_ARGS[manager] ?? ['install']), sdkDependencySpec()].join(' ')
}

export interface InstallInput {
  readonly root: string
  readonly manager: PackageManager
  readonly enabled: boolean
}

export function installSdk(input: InstallInput): InstallResult {
  const command = installCommand(input.manager)
  const base = { packageName: SDK_PACKAGE, command } as const

  if (!input.enabled) return { ...base, outcome: 'skipped', detail: undefined }
  if (isPackageInstalled(input.root, SDK_PACKAGE)) {
    return { ...base, outcome: 'already-present', detail: undefined }
  }

  const result = spawnSync(
    input.manager,
    [...(ADD_ARGS[input.manager] ?? ['install']), sdkDependencySpec()],
    {
      cwd: input.root,
      encoding: 'utf8',
      timeout: INSTALL_TIMEOUT_MS,
      // Nothing interactive may reach the terminal: §11 forbids prompts, and a
      // package manager waiting on stdin would hang an unattended agent forever.
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  if (result.error !== undefined) {
    return { ...base, outcome: 'failed', detail: result.error.message }
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim()
    const lastLine = stderr.split('\n').filter((entry) => entry.trim().length > 0).at(-1)
    return {
      ...base,
      outcome: 'failed',
      detail: lastLine ?? `exit code ${String(result.status ?? -1)}`,
    }
  }

  /*
   * A zero exit is not proof. This step reported success for every user of this
   * tool while installing nothing at all: the package name is not on npm yet,
   * and depending on the manager and the flags a miss can still exit 0 — the
   * customer then discovered it at build time, from an error naming a registry
   * rather than anything to do with this CLI.
   *
   * So the claim is checked against the filesystem before it is made. It is the
   * same check `already-present` uses two lines above; the only reason it was
   * not also used here is that nobody thought the exit code could lie.
   */
  if (!isPackageInstalled(input.root, SDK_PACKAGE)) {
    return {
      ...base,
      outcome: 'failed',
      detail: `${input.manager} reported success but ${SDK_PACKAGE} is not in node_modules.`,
    }
  }
  return { ...base, outcome: 'installed', detail: undefined }
}
