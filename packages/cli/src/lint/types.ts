import type { ProjectModel } from '../api'

/**
 * M16 (PRD-v2 §10) — the vocabulary every consistency check speaks.
 *
 * WHAT THIS MILESTONE IS FOR
 * --------------------------
 * The reference site arrived from another CMS carrying a contradiction: one
 * paragraph said seven bedrooms, another said five. Nothing in the migration was
 * wrong, nothing failed validation, and the contradiction was live for nine days
 * because no schema can see it. Everything in this directory reads the CONTENT
 * and asks whether it agrees with itself.
 *
 * THE ONE RULE THAT GOVERNS EVERY CHECK
 * -------------------------------------
 * A finding must be almost certainly a real problem. A linter that reports ten
 * things of which three are wrong is one a person stops running, and then it
 * catches nothing at all — strictly worse than not having it. So every check
 * here is tuned to stay silent when it is unsure, each module says in its own
 * comments where that line was drawn, and the tests assert the silence as
 * carefully as they assert the findings.
 *
 * There is deliberately NO severity scale. A scale invites a "warning" tier,
 * and a warning tier is where the guesses go to live; the honest choice is that
 * a check either reports or it does not.
 *
 * OUTPUT IS IN ENGLISH, unlike the studio.
 * The rest of this binary speaks English because its reader is a coding agent
 * or the developer running it, and a command that answered in two languages
 * depending on the subcommand would be worse for both. The owner meets these
 * findings through the studio (§10.2), where they are Hebrew. What is quoted
 * back here is the owner's own text, verbatim, in whatever language they wrote.
 */

/** One document, lifted out of the Content API's envelope. */
export interface LintDocument {
  readonly id: string
  readonly type: string
  readonly slug: string
  /** The value of the type's `titleField`, when it holds a non-empty string. */
  readonly title: string | undefined
  readonly data: Readonly<Record<string, unknown>>
}

/**
 * A piece of prose found somewhere in a document.
 *
 * `inList` is the single most important flag in this file. A value inside a
 * repeated container — a price table, a list of cabins, an FAQ — is describing
 * a DIFFERENT thing from its siblings, so two of them disagreeing is not a
 * disagreement at all. Rich text is the deliberate exception: it is stored as an
 * array of blocks but it is one continuous body of prose, and it is exactly
 * where the reference site's contradiction lived.
 */
export interface TextValue {
  readonly path: string
  readonly text: string
  readonly inList: boolean
}

export interface NumberValue {
  readonly path: string
  readonly value: number
  readonly inList: boolean
}

export interface ImageValue {
  readonly path: string
  /** Present and non-blank means the image is described. */
  readonly alt: string | undefined
}

export interface ReferenceValue {
  readonly path: string
  readonly ref: string
}

/** An internal link: a value that starts with `/` and names a page of this site. */
export interface LinkValue {
  readonly path: string
  readonly href: string
}

/** Everything the checks need from one document, gathered in a single walk. */
export interface DocumentIndex {
  readonly document: LintDocument
  readonly texts: readonly TextValue[]
  readonly numbers: readonly NumberValue[]
  readonly images: readonly ImageValue[]
  readonly references: readonly ReferenceValue[]
  readonly links: readonly LinkValue[]
}

/** Where a finding is, precisely enough to open the field and look. */
export interface FindingLocation {
  readonly documentId: string
  readonly type: string
  readonly slug: string
  /** Dot/bracket path inside the document's fields; empty for the document itself. */
  readonly path: string
  /** The owner's own words, unmodified. */
  readonly quote?: string | undefined
}

export interface Finding {
  readonly check: string
  /** One sentence, stating the problem and nothing else. */
  readonly message: string
  /** At least one; a contradiction carries the two sides that disagree. */
  readonly locations: readonly FindingLocation[]
}

export interface LintInput {
  readonly documents: readonly LintDocument[]
  readonly indexes: readonly DocumentIndex[]
  readonly model: ProjectModel
}

export type CheckFn = (input: LintInput) => Finding[]

export interface CheckDefinition {
  readonly name: string
  /** One line, printed by `--check` when the name given does not exist. */
  readonly description: string
  readonly run: CheckFn
}

export function locationOf(
  document: LintDocument,
  path: string,
  quote?: string,
): FindingLocation {
  return {
    documentId: document.id,
    type: document.type,
    slug: document.slug,
    path,
    ...(quote === undefined ? {} : { quote }),
  }
}

/** How a document is named in a message: the slug, or the id when it has none. */
export function documentLabel(document: LintDocument): string {
  return document.slug.length > 0 ? `${document.type}/${document.slug}` : document.id
}
