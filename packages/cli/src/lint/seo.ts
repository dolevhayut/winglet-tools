import type { CheckDefinition, Finding, LintDocument, LintInput } from './types'
import { documentLabel, locationOf } from './types'

/**
 * M21.8 — the four checks that are facts about a value.
 *
 * §10.1's rule governs every one of them, and it is the rule that withdrew
 * three of M16's five checks: a finding must be almost certainly a real
 * problem, because a linter that is wrong two times in three is one an operator
 * stops reading — and then the checks that ARE right stop being read with it.
 *
 * Everything here is an absence, a length, or an equality. None of them judges
 * whether prose is any good, and none of them reads Hebrew morphology, which is
 * exactly what sank `entityNames`.
 *
 * WHAT IS DELIBERATELY NOT HERE: a thin-content check. It was specified and it
 * does not survive this content model. "Published with almost no text" is a
 * real defect on a page and completely normal on a `stayRule`, which is a title
 * and one sentence by design. A dynamic model has no way to know which types
 * are meant to be short, so the check would fire hardest on the documents that
 * are correct — and take these four down with it.
 */

/**
 * Google truncates a title around 60 characters and a description around 160.
 * The lower bounds are the interesting half: a 4-character title and a
 * six-word description are what an owner leaves when they meant to come back
 * to it, and both render a search result that says nothing.
 *
 * Characters, not pixels. Pixel width is the accurate model and it needs the
 * rendered font; against Hebrew, with no width table to hand, a character count
 * is the honest approximation — and it is what every tool a customer will
 * compare this against also counts.
 */
const TITLE_MIN = 15
const TITLE_MAX = 60
const DESCRIPTION_MIN = 70
const DESCRIPTION_MAX = 160

interface SeoView {
  readonly title?: string | undefined
  readonly description?: string | undefined
}

/**
 * The types that carry an `seo` field, mapped to what that field is CALLED.
 *
 * Read from the model rather than assumed, on both halves. A project defines
 * its own types — `stayRule` and `testimonial` have no `seo` field in any
 * template — and reporting a missing description on a document that cannot hold
 * one is precisely the finding that teaches an operator to skip the output. The
 * name is looked up rather than hardcoded to `seo` for the same reason the rest
 * of this binary looks things up: the field kind is fixed by the schema, the
 * field's name is the project's to choose.
 */
function seoFields(input: LintInput): ReadonlyMap<string, string> {
  const byType = new Map<string, string>()
  for (const type of input.model.types) {
    const field = type.fields.find((candidate) => candidate.kind === 'seo')
    if (field !== undefined) byType.set(type.key, field.name)
  }
  return byType
}

/** The document's `seo` value, with blank strings treated as absent. */
function seoOf(document: LintDocument, fieldName: string): SeoView {
  const value = document.data[fieldName]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const read = (key: string): string | undefined => {
    const found = record[key]
    if (typeof found !== 'string') return undefined
    const text = found.trim()
    return text.length === 0 ? undefined : text
  }
  return { title: read('title'), description: read('description') }
}

/** Every document whose type has an `seo` field, paired with what it holds. */
function withSeo(input: LintInput): ReadonlyArray<readonly [LintDocument, string, SeoView]> {
  const fields = seoFields(input)
  const rows: Array<readonly [LintDocument, string, SeoView]> = []
  for (const document of input.documents) {
    const fieldName = fields.get(document.type)
    if (fieldName === undefined) continue
    rows.push([document, fieldName, seoOf(document, fieldName)])
  }
  return rows
}

const missingSeo: CheckDefinition = {
  name: 'missing-seo',
  description: 'published documents with no search title or no search description',
  run: (input: LintInput): Finding[] => {
    const findings: Finding[] = []

    for (const [document, fieldName, seo] of withSeo(input)) {
      const absent: string[] = []
      if (seo.title === undefined) absent.push('title')
      if (seo.description === undefined) absent.push('description')
      if (absent.length === 0) continue

      findings.push({
        check: 'missing-seo',
        message: `${documentLabel(document)} has no search ${absent.join(' and no ')}.`,
        locations: [locationOf(document, `${fieldName}.${absent[0] ?? 'title'}`)],
      })
    }
    return findings
  },
}

function lengthCheck(
  name: string,
  description: string,
  key: 'title' | 'description',
  min: number,
  max: number,
): CheckDefinition {
  return {
    name,
    description,
    run: (input: LintInput): Finding[] => {
      const findings: Finding[] = []

      for (const [document, fieldName, seo] of withSeo(input)) {
        const value = seo[key]
        // Absence is `missing-seo`'s finding, not this one. Both would put two
        // lines in front of an operator for one empty field.
        if (value === undefined) continue

        // Code points, not UTF-16 units: an emoji in a title is two units and
        // one character, and Google counts what a reader sees.
        const length = [...value].length
        if (length >= min && length <= max) continue

        const problem = length < min ? 'too short to say anything' : 'cut off in results'
        findings.push({
          check: name,
          message:
            `${documentLabel(document)} has a ${String(length)}-character search ${key}, ` +
            `${problem}; ${String(min)}–${String(max)} is the range search results show.`,
          locations: [locationOf(document, `${fieldName}.${key}`, value)],
        })
      }
      return findings
    },
  }
}

const seoTitleLength = lengthCheck(
  'seo-title-length',
  'search titles that will be cut off, or are too short to say anything',
  'title',
  TITLE_MIN,
  TITLE_MAX,
)

const seoDescriptionLength = lengthCheck(
  'seo-description-length',
  'search descriptions that will be cut off, or are too short to say anything',
  'description',
  DESCRIPTION_MIN,
  DESCRIPTION_MAX,
)

/**
 * Two documents OF ONE TYPE claiming the same search title.
 *
 * This is the one SEO defect that is invisible from the page it is on: each
 * page looks right in isolation and only the pair is wrong. It is also an
 * equality between two strings, which is as certain as this file gets.
 *
 * WHY IT STOPS AT THE TYPE BOUNDARY — the whole tuning of this check.
 * Two documents of one type are the same KIND of thing, so two of them wearing
 * one name is a naming mistake by definition. Two documents of different types
 * are not: one of them may not be a page at all. A settings singleton, a global
 * banner, a navigation container — each carries an `seo` whose entire job is to
 * be the site-wide default that the home page then matches, and nothing in the
 * model records which types render as pages.
 *
 * Measured against the reference site before shipping, the unrestricted version
 * produced exactly one finding, and it was `homePage` against `siteSettings`
 * carrying the same title — which is not a defect, it is the layout default
 * working. Same reason `contradictoryNumbers` was withdrawn in M16: a check
 * that is wrong on real content is worse than no check.
 *
 * The deliberate miss this buys: a landing page copied from a page, keeping its
 * title, is a genuine duplicate across two types and will not be reported. That
 * is the trade — a miss nobody sees, against a false positive everybody does.
 * It also means a `cardinality: 'single'` type can never produce a finding,
 * which falls out of the rule rather than being a special case for settings.
 *
 * Reported ONCE per collision, carrying every side — the shape
 * `contradictoryNumbers` used for the two halves of a disagreement, and the
 * reason `Finding.locations` is a list rather than one place.
 *
 * Titles are compared as the owner typed them, with only surrounding space
 * trimmed. Case-folding and normalising punctuation would catch a few more, and
 * would also start reporting pairs a person looking at both would call
 * different — which is the trade this file does not make.
 */
const duplicateSeo: CheckDefinition = {
  name: 'duplicate-seo',
  description: 'two or more documents of one type sharing a search title',
  run: (input: LintInput): Finding[] => {
    // Keyed by type AND title, so the grouping itself enforces the boundary.
    // A newline separates them because neither a type key nor a title can hold
    // one, and a plain space would let a type ending in a space collide.
    const groups = new Map<string, Array<readonly [LintDocument, string, string]>>()

    for (const [document, fieldName, seo] of withSeo(input)) {
      const title = seo.title
      if (title === undefined) continue
      const key = `${document.type}\n${title}`
      const group = groups.get(key) ?? []
      group.push([document, fieldName, title])
      groups.set(key, group)
    }

    const findings: Finding[] = []
    for (const group of groups.values()) {
      if (group.length < 2) continue
      const first = group[0]
      if (first === undefined) continue
      const [, , title] = first
      findings.push({
        check: 'duplicate-seo',
        message: `${String(group.length)} ${first[0].type} documents share the search title “${title}”.`,
        locations: group.map(([document, fieldName]) =>
          locationOf(document, `${fieldName}.title`, title),
        ),
      })
    }
    return findings
  },
}

export const SEO_CHECKS: readonly CheckDefinition[] = [
  missingSeo,
  seoTitleLength,
  seoDescriptionLength,
  duplicateSeo,
]
