import type { CheckDefinition, Finding, LintDocument, LintInput } from './types'
import { documentLabel, locationOf } from './types'

/**
 * `broken-links` — PRD-v2 §10.1, "קישורים שבורים פנימיים".
 *
 * TWO KINDS OF INTERNAL LINK, AND ONLY ONE OF THEM IS CERTAIN
 * -----------------------------------------------------------
 * A reference field is unambiguous: it holds a document id, and either the site
 * is serving that document or it is not. Nothing has to be assumed to check it.
 *
 * A path written into text — `/cabins/spa` — is a different animal, because the
 * routing that turns it into a page lives in the customer's own code and is not
 * visible from here. `/contact` may be a hand-written page with no document
 * behind it at all, and reporting it as broken would be wrong every single time.
 *
 * So paths are only checked where the CONTENT ITSELF proves the pattern: within
 * one prefix, if two or more links resolve to real documents and another does
 * not, that prefix demonstrably maps slugs to pages and the odd one out is
 * demonstrably not among them. Two is the smallest number that can be a pattern
 * rather than a coincidence. Top-level paths (`/about`) are excluded entirely
 * even under that rule — a site's root is where its hand-written pages live, and
 * the evidence there is never good enough.
 *
 * External links are not fetched. That would make this command a crawler, and
 * someone else's 404 is not a consistency problem in this content.
 */

const CHECK_NAME = 'broken-links'

/** Below this, a shared prefix is a coincidence rather than a routing pattern. */
const MIN_RESOLVED_SIBLINGS = 2

/** A path that names a file is an asset, not a page. */
const FILE_EXTENSION = /\.[a-z0-9]{2,4}$/iu

interface PathLink {
  readonly document: LintDocument
  readonly path: string
  readonly href: string
  readonly prefix: string
  readonly lastSegment: string
}

/** Drops the query and the fragment: both are addressed inside a page, not to it. */
function pagePath(href: string): string {
  const withoutHash = href.split('#')[0] ?? ''
  return withoutHash.split('?')[0] ?? ''
}

function splitPath(href: string): { prefix: string; lastSegment: string } | undefined {
  const segments = pagePath(href)
    .split('/')
    .filter((segment) => segment.length > 0)
  if (segments.length < 2) return undefined
  const lastSegment = segments[segments.length - 1] ?? ''
  if (lastSegment.length === 0 || FILE_EXTENSION.test(lastSegment)) return undefined
  return { prefix: segments.slice(0, -1).join('/'), lastSegment }
}

/** Every slug being served, however many documents share one. */
export function slugsOf(documents: readonly LintDocument[]): ReadonlySet<string> {
  const slugs = new Set<string>()
  for (const document of documents) {
    if (document.slug.length > 0) slugs.add(document.slug)
  }
  return slugs
}

function danglingReferences(input: LintInput): Finding[] {
  const ids = new Set(input.documents.map((document) => document.id))
  const findings: Finding[] = []

  for (const index of input.indexes) {
    for (const reference of index.references) {
      if (ids.has(reference.ref)) continue
      findings.push({
        check: CHECK_NAME,
        message:
          `${documentLabel(index.document)} points at a document that is not being served: ` +
          `${reference.ref}. It was deleted, or it exists and has never been published.`,
        locations: [locationOf(index.document, reference.path, reference.ref)],
      })
    }
  }

  return findings
}

function danglingPaths(input: LintInput): Finding[] {
  const slugs = slugsOf(input.documents)

  const byPrefix = new Map<string, PathLink[]>()
  for (const index of input.indexes) {
    for (const link of index.links) {
      const parts = splitPath(link.href)
      if (parts === undefined) continue
      const entry: PathLink = {
        document: index.document,
        path: link.path,
        href: link.href,
        prefix: parts.prefix,
        lastSegment: parts.lastSegment,
      }
      const bucket = byPrefix.get(entry.prefix) ?? []
      bucket.push(entry)
      byPrefix.set(entry.prefix, bucket)
    }
  }

  const findings: Finding[] = []
  for (const links of byPrefix.values()) {
    const resolved = links.filter((link) => slugs.has(link.lastSegment))
    if (resolved.length < MIN_RESOLVED_SIBLINGS) continue

    for (const link of links) {
      if (slugs.has(link.lastSegment)) continue
      findings.push({
        check: CHECK_NAME,
        message:
          `${documentLabel(link.document)} links to ${link.href}, and no document has the ` +
          `slug "${link.lastSegment}" — while ${String(resolved.length)} other links under ` +
          `/${link.prefix}/ do resolve.`,
        locations: [locationOf(link.document, link.path, link.href)],
      })
    }
  }

  return findings
}

export const brokenLinks: CheckDefinition = {
  name: CHECK_NAME,
  description: 'references and internal paths that lead nowhere',
  run: (input: LintInput): Finding[] => [...danglingReferences(input), ...danglingPaths(input)],
}
