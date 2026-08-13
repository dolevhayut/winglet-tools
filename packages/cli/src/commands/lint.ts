import { CLI_BIN } from '@product'

import { fetchContentSnapshot, fetchProjectModel } from '../api'
import { CliError, EXIT } from '../exit'
import { pluralise } from '../format'
import { MARK, line } from '../io'
import type { Io } from '../io'
import { CHECKS, findCheck, runLint, toLintDocuments } from '../lint'
import type { Finding } from '../lint'
import type { CommonOptions } from './context'
import { emitJson, loadProjectContext } from './context'

/**
 * `lint` — M16, PRD-v2 §10: the checks that read the CONTENT rather than the
 * schema.
 *
 * The evidence this exists for: the reference site went live with one paragraph
 * saying seven bedrooms and another saying five, and it stayed that way for nine
 * days. No schema, no validator and no type generator can see that, because
 * every field was individually valid. The checks live in `../lint`, one file
 * each, with the reasoning for where each one draws its line; this file only
 * fetches, prints, and picks an exit code.
 *
 * READ KEY ONLY, AND NOTHING IS WRITTEN.
 * Two requests, both to endpoints a read key opens: the whole site in one
 * (`/content/_all`) and the content model (`/types`). The command has no write
 * key in scope, so "lint fixed my content" is not a thing that can happen by
 * accident. Fixing is the agent's job, with `edit`, after a person has decided
 * which of the two numbers was right — which is the entire point of §10.2.
 */

export interface LintOptions extends CommonOptions {
  readonly check?: string | undefined
}

function locationLine(quote: string | undefined, where: string): string {
  return quote === undefined ? `    ${where}\n` : `    ${where} — ${quote}\n`
}

function printFindings(io: Io, findings: readonly Finding[]): void {
  let current = ''
  for (const finding of findings) {
    if (finding.check !== current) {
      current = finding.check
      io.write(line(MARK.info, current))
    }
    io.write(line(MARK.warn, finding.message))
    for (const location of finding.locations) {
      const label = location.slug.length > 0 ? `${location.type}/${location.slug}` : location.documentId
      const where = location.path.length > 0 ? `${label} · ${location.path}` : label
      io.write(locationLine(location.quote, where))
    }
  }
}

export async function lintCommand(io: Io, options: LintOptions): Promise<void> {
  const context = loadProjectContext(io, options)

  const selected = options.check === undefined ? undefined : findCheck(options.check)
  if (options.check !== undefined && selected === undefined) {
    throw new CliError(
      `No such check: ${options.check}`,
      EXIT.error,
      ['Available checks:', ...CHECKS.map((check) => `  ${check.name} — ${check.description}`)].join(
        '\n',
      ),
    )
  }

  // Both reads are independent, and the model is small; issuing them together
  // keeps the command at one round trip's latency rather than two.
  const [snapshot, model] = await Promise.all([
    fetchContentSnapshot(context.apiBaseUrl, context.readKey),
    fetchProjectModel({ baseUrl: context.apiBaseUrl, key: context.readKey }),
  ])

  const documents = toLintDocuments(snapshot.documents, model)
  const report = runLint({
    documents,
    model,
    ...(selected === undefined ? {} : { checks: [selected] }),
  })

  if (options.json === true) {
    emitJson(io, {
      ok: report.findings.length === 0,
      command: 'lint',
      project: { id: snapshot.projectId },
      documents: report.documentCount,
      truncated: snapshot.truncated,
      checks: report.checks,
      findings: report.findings,
    })
  } else {
    io.write(
      line(
        MARK.info,
        `${pluralise(report.documentCount, 'document')}, ${pluralise(report.checks.length, 'check')}` +
          ` — ${report.checks.join(', ')}`,
      ),
    )
    if (report.findings.length === 0) {
      io.write(line(MARK.done, 'No content problems found.'))
    } else {
      printFindings(io, report.findings)
    }
  }

  if (snapshot.truncated) {
    // Said on stderr in both modes: a partial snapshot makes "no problems found"
    // a claim about part of the site, and a caller must not read it as more.
    io.writeError(
      line(MARK.warn, 'The API truncated this snapshot — some documents were not checked.'),
    )
  }

  if (report.findings.length === 0) return

  /*
   * EXIT 1, and none of the other three.
   *
   * §11's contract has four values and an agent branches on the number: 0 ok,
   * 1 something the caller can fix by changing the command or the project, 2 an
   * unsupported environment, 3 a limit or the network. Content that disagrees
   * with itself is the definition of the second — it is the project, and it is
   * fixable. 2 and 3 would both be lies about what went wrong.
   *
   * A distinct "findings exist" code was considered and rejected. Every other
   * linter a caller has ever run exits non-zero on findings and zero on none,
   * and adding a fifth value to a published four-value contract to say something
   * the report already says would break every existing branch on it.
   *
   * The message goes to stderr through `run`, after the report is already on
   * stdout — so `--json` output stays a single parseable object either way.
   */
  const documentIds = new Set(
    report.findings.flatMap((finding) => finding.locations.map((location) => location.documentId)),
  )
  throw new CliError(
    `${pluralise(report.findings.length, 'content problem')} in ` +
      `${pluralise(documentIds.size, 'document')}.`,
    EXIT.error,
    `Nothing was changed — ${CLI_BIN} lint only reads. Decide which version is right, then\n` +
      `fix it with ${CLI_BIN} edit <id> --set <field>=<value> and publish.`,
  )
}
