import { CLI_BIN, STUDIO_ORIGIN } from '@product'

import { CliError, EXIT } from '../exit'
import { claimStatus, daysUntil } from '../format'
import { MARK, line } from '../io'
import type { Io } from '../io'
import { configFilePath } from '../local-config'
import type { CommonOptions } from './context'
import { emitJson, loadPartialContext } from './context'

/**
 * `claim` — §11's "הדפסת לינק אימוץ מחדש".
 *
 * WHY THIS READS A LOCAL FILE AND NOT THE API
 * -------------------------------------------
 * Correction T2 stores the claim token as a sha256 digest
 * (`projects.claim_token_hash`), exactly so a database leak cannot hand an
 * attacker ownership of every unclaimed project. The consequence is that the
 * server genuinely cannot reprint the link — the plaintext exists only in the
 * terminal that ran `init` and in the CLI's local config. This command is the
 * recovery path for the first of those being closed.
 */
export type ClaimOptions = CommonOptions

export function claimCommand(io: Io, options: ClaimOptions): void {
  const partial = loadPartialContext(io, options)
  const config = partial.config

  if (config === undefined || config.claim === undefined) {
    throw new CliError(
      'No claim link stored for this project.',
      EXIT.error,
      [
        `Looked in ${configFilePath(partial.root)}.`,
        'The claim token is stored only as a hash on the server (it is what transfers',
        'ownership), so it cannot be reprinted from the API. It is written locally by',
        `\`${CLI_BIN} init\` at creation time.`,
        config === undefined
          ? `No project is configured here yet — run \`${CLI_BIN} init\`.`
          : 'If the project was already claimed, sign in at ' + STUDIO_ORIGIN + ' instead.',
      ].join('\n'),
    )
  }

  const now = new Date()
  const remaining = daysUntil(config.claim.expiresAt, now)
  const expired = remaining !== undefined && remaining < 0

  if (options.json === true) {
    emitJson(io, {
      ok: !expired,
      command: 'claim',
      project: { id: config.projectId, name: config.name ?? null, slug: config.slug ?? null },
      claim: {
        url: config.claim.url,
        expiresAt: config.claim.expiresAt,
        daysRemaining: remaining ?? null,
        expired,
      },
    })
    if (expired) {
      throw new CliError(
        `The claim link for project ${config.projectId} expired on ${config.claim.expiresAt}.`,
        EXIT.error,
      )
    }
    return
  }

  const label = config.name ?? config.slug ?? config.projectId
  io.write(line(MARK.done, `Project "${label}" — ${config.projectId}`))
  io.write(`\nOwner claim link (${claimStatus(config.claim, now)}):\n  ${config.claim.url}\n\n`)

  if (expired) {
    // §14.3 deletes an unclaimed project 14 days in. Printing a dead link as if
    // it worked would send the owner to an error page with no explanation.
    throw new CliError(
      `That link has expired. An unclaimed project is removed 14 days after creation.`,
      EXIT.error,
      `Sign in at ${STUDIO_ORIGIN} if the project was already claimed.`,
    )
  }

  io.write('Send it to the site owner. Opening it transfers the project to their account.\n')
}
