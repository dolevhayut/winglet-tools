import type { CheckDefinition, Finding, LintInput } from './types'
import { documentLabel, locationOf } from './types'

/**
 * `missing-alt` — PRD-v2 §10.1, "שדות `alt` ריקים".
 *
 * The one check here that needs no judgement about meaning: either the image
 * has a description or it does not. All of the care went into deciding what
 * counts as an image at all, and that lives in the walker — a record is only an
 * image when it carries an asset id, or a URL corroborated by dimensions, a
 * placeholder, a hotspot or an image file extension. A call to action shaped
 * like `{ url, label }` is not an image, and flagging one would have made this
 * check the reason nobody runs the command.
 *
 * WHAT IS EXCLUDED, DELIBERATELY
 * ------------------------------
 * Images under a field of kind `seo`. An Open Graph image is read by a crawler
 * from a meta tag, never rendered as an element with an alt attribute, so
 * demanding a description there is asking for text no one will ever read.
 *
 * NOT EXCLUDED: decorative images. A CMS cannot tell a decorative image from an
 * undescribed one, and in content an owner writes by hand the second is far
 * commoner than the first. The finding names the field, so a decorative image
 * costs one glance to dismiss.
 */

const CHECK_NAME = 'missing-alt'

/** The top-level field a path belongs to: `gallery[2].image` → `gallery`. */
function rootField(path: string): string {
  const dot = path.indexOf('.')
  const bracket = path.indexOf('[')
  const end = Math.min(dot === -1 ? path.length : dot, bracket === -1 ? path.length : bracket)
  return path.slice(0, end)
}

export const missingAlt: CheckDefinition = {
  name: CHECK_NAME,
  description: 'images published with no description',
  run: (input: LintInput): Finding[] => {
    const seoFields = new Map<string, ReadonlySet<string>>()
    for (const type of input.model.types) {
      seoFields.set(
        type.key,
        new Set(type.fields.filter((field) => field.kind === 'seo').map((field) => field.name)),
      )
    }

    const findings: Finding[] = []
    for (const index of input.indexes) {
      const excluded = seoFields.get(index.document.type) ?? new Set<string>()
      for (const image of index.images) {
        if (image.alt !== undefined) continue
        if (excluded.has(rootField(image.path))) continue
        findings.push({
          check: CHECK_NAME,
          message: `${documentLabel(index.document)} publishes an image with no description (alt).`,
          locations: [locationOf(index.document, image.path)],
        })
      }
    }
    return findings
  },
}
