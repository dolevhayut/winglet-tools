import type { ProjectModel } from '../api'
import { indexDocument } from './document'
import { brokenLinks } from './links'
import { missingAlt } from './images'
import { SEO_CHECKS } from './seo'
import type { CheckDefinition, DocumentIndex, Finding, LintDocument } from './types'

export { toLintDocuments } from './document'
export type {
  DocumentIndex,
  Finding,
  FindingLocation,
  LintDocument,
  LintInput,
} from './types'

/**
 * M16 — the whole of `lint`, with no network anywhere in it.
 *
 * Every check is a pure function of (documents, model), which is what makes the
 * hard part of this milestone testable: the tuning that decides whether a
 * finding is trustworthy is exercised against hand-built documents, in
 * milliseconds, with no project and no key. The command in `commands/lint.ts` is
 * only the shell that fetches and prints.
 *
 * TWO CHECKS SHIPPED, THREE WERE BUILT AND WITHDRAWN.
 *
 * `contradictoryNumbers`, `entityNames` and `orphanDocuments` were written,
 * tested, and then measured against the real migrated site — where they produced
 * seven findings, all of them wrong, against three that were right. The sentence
 *
 *     5 בקתות עם 2 חדרי שינה וסלון, 6 בקתות עם חדר שינה
 *
 * is one coherent description of two kinds of cabin, and the numbers check read
 * it as a site contradicting itself. `entityNames` cannot tell Hebrew's
 * construct-state article — בקתות הספא / בקתות ספא — from a misspelling, and
 * that alternation is simultaneously its headline true positive and its worst
 * false positive: one rule, and only the fixture decides which you see.
 *
 * They are withdrawn rather than kept-and-caveated because a check that is wrong
 * two times in three teaches an operator to skip the output, and once they skip
 * it the two checks that ARE right stop being read as well. Same reason the
 * studio never shows an owner a warning it is not sure about.
 *
 * What is left is what earned its place on real content: `brokenLinks` found
 * three genuinely dangling references that had survived WordPress → Sanity →
 * here, and `missingAlt` is a fact about a value rather than a judgement about
 * prose. The withdrawn three are recoverable from git history; the hard parts
 * they need — subject identity and Hebrew morphology — are not a tuning pass.
 */

/**
 * M21.8 added four more, and they belong to the same rule rather than to a new
 * one: a missing search description, a title that will be cut off at 60
 * characters, and two pages claiming the same title are all facts about a
 * value, verifiable without reading the language the value is written in. The
 * fifth that was specified — thin content — is not here, and `seo.ts` says why.
 */
export const CHECKS: readonly CheckDefinition[] = [brokenLinks, missingAlt, ...SEO_CHECKS]

export const CHECK_NAMES: readonly string[] = CHECKS.map((check) => check.name)

export function findCheck(name: string): CheckDefinition | undefined {
  return CHECKS.find((check) => check.name === name)
}

export interface LintReport {
  /** How many documents were read, so a suspiciously empty run is visible. */
  readonly documentCount: number
  readonly checks: readonly string[]
  readonly findings: readonly Finding[]
}

export interface LintRequest {
  readonly documents: readonly LintDocument[]
  readonly model: ProjectModel
  /** Which checks to run; every one of them when omitted. */
  readonly checks?: readonly CheckDefinition[] | undefined
}

/** Within a check, group a site's findings by where they are. */
function byLocation(left: Finding, right: Finding): number {
  const a = left.locations[0]
  const b = right.locations[0]
  if (a === undefined || b === undefined) return 0
  return (
    a.type.localeCompare(b.type) ||
    a.slug.localeCompare(b.slug) ||
    a.path.localeCompare(b.path)
  )
}

export function runLint(request: LintRequest): LintReport {
  const checks = request.checks ?? CHECKS
  const indexes: readonly DocumentIndex[] = request.documents.map((document) =>
    indexDocument(document),
  )
  const input = { documents: request.documents, indexes, model: request.model }

  const findings = checks.flatMap((check) => [...check.run(input)].sort(byLocation))

  return {
    documentCount: request.documents.length,
    checks: checks.map((check) => check.name),
    findings,
  }
}
