import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  CLI_BIN,
  CLIENT_VERSION,
  CLI_PACKAGE,
  ENV_PREFIX,
  PRODUCT_SLUG,
  ROOT_DOMAIN,
  MCP_PACKAGE,
  PUBLISHED_TO_NPM,
  SDK_PACKAGE,
  sdkDependencySpec,
} from '@product'

import { REPO_ROOT, matchingLines, readSources } from './walk.js'

/**
 * PRD (header): "אין לפזר את השם בקוד ... שינוי שם = שינוי במקום אחד."
 *
 * These tests are the enforcement. They fail loudly the moment somebody types
 * the product name by hand instead of importing it from `product.config.ts`.
 */

const SCANNED_ROOTS = ['packages', 'tools']

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.sql', '.md']

/**
 * The slug as a standalone token. Catches every shape it appears in — bare, and
 * followed by `_`, `.`, `/` or `-` — in any casing, but not a longer word that
 * merely contains those letters.
 *
 * Comments in this repo must stay slug-neutral (write `{slug}`, not the name),
 * because this scan does not exempt them.
 */
const SLUG_LITERAL = new RegExp(`(?<![a-z0-9])${PRODUCT_SLUG}(?![a-z0-9])`, 'i')

describe('product identity is derived, never re-typed', () => {
  it('no source file outside product.config.ts contains the slug as a literal', () => {
    const offenders = readSources(SCANNED_ROOTS, SOURCE_EXTENSIONS)
      .filter((file) => !file.path.endsWith('tools/guards/product-slug.test.ts'))
      .flatMap((file) =>
        matchingLines(file.text, SLUG_LITERAL).map((line) => `${file.path}:${line}`),
      )

    expect(
      offenders,
      `Hard-coded product name found. Import it from "@product" instead:\n  ${offenders.join('\n  ')}`,
    ).toEqual([])
  })

  /**
   * npm manifests cannot compute their own `name`/`bin`, so they are excluded
   * from the scan above and asserted against the derived value here instead.
   * A rename still fails the suite — it just fails with a diff, not a grep.
   */
  it.each([
    ['packages/sdk/package.json', SDK_PACKAGE],
    ['packages/cli/package.json', CLI_PACKAGE],
  ])('%s declares the derived package name', (manifestPath, expectedName) => {
    const manifest: unknown = JSON.parse(
      readFileSync(join(REPO_ROOT, manifestPath), 'utf8'),
    )
    expect(manifest).toMatchObject({ name: expectedName })
  })

  it('the CLI manifest exposes the derived bin name', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages/cli/package.json'), 'utf8'),
    )
    expect(manifest).toMatchObject({ bin: { [CLI_BIN]: expect.any(String) as unknown as string } })
  })
})

/**
 * Agent- and human-facing prose is the ONE place the name must appear literally.
 * A skill file has to say the real command — an agent cannot import a TypeScript
 * constant — and a registry entry is submitted as text.
 *
 * So these are inverted: instead of "must not contain the name", they must
 * contain the CURRENT one. A rename still fails the suite, which is the property
 * that matters; it just fails with "this file is stale" instead of a grep hit.
 */
describe('published prose names the current product', () => {
  const PROSE = ['skills', 'registries']

  it('every prose file that names a product names this one', () => {
    const files = readSources(PROSE, ['.md', '.json'])
    expect(files.length, 'no prose files found — the scan is looking in the wrong place').toBeGreaterThan(0)

    const stale = files
      .filter((file) => /npx\s+[a-z][a-z0-9-]*\s+init|github\.com\/[^/]+\/[a-z0-9-]+/iu.test(file.text))
      .filter((file) => !file.text.toLowerCase().includes(PRODUCT_SLUG))
      .map((file) => file.path)

    expect(stale, `These name a product, but not this one:\n  ${stale.join('\n  ')}`).toEqual([])
  })

  it('the skill file declares the install command as it really is', () => {
    const skill = readSources(['skills'], ['.md']).find((f) => f.path.endsWith('SKILL.md'))
    expect(skill, 'skills/**/SKILL.md is missing').toBeDefined()
    expect(skill?.text).toContain(`npx ${PRODUCT_SLUG} init`)
    expect(skill?.text, 'a skill needs frontmatter to be discoverable').toMatch(/^---\n/u)
  })
})

describe('derived identity stays internally consistent', () => {
  it('every derived value is built from the slug', () => {
    // UNSCOPED, and asserted rather than assumed. These read `@slug/next` and
    // `@slug/cli` until publication, when the scope turned out to belong to an
    // unrelated author and to be unobtainable at any price. The rule the guard
    // exists for is unchanged — every name is still derived from the slug and
    // a rename still moves in one edit — so the assertion follows the shape
    // rather than the shape following the assertion.
    expect(SDK_PACKAGE.startsWith(`${PRODUCT_SLUG}-`)).toBe(true)
    expect(MCP_PACKAGE.startsWith(`${PRODUCT_SLUG}-`)).toBe(true)
    expect(SDK_PACKAGE).not.toContain('@')
    expect(MCP_PACKAGE).not.toContain('@')

    // The one that is not merely derived but IDENTICAL, because `npx <slug>`
    // resolves a package of exactly that name. Anything else and the single
    // command this product is sold on 404s for every reader.
    expect(CLI_PACKAGE).toBe(PRODUCT_SLUG)

    expect(CLI_BIN).toBe(PRODUCT_SLUG)
    expect(ENV_PREFIX).toBe(`${PRODUCT_SLUG.toUpperCase()}_`)
    expect(ROOT_DOMAIN.startsWith(`${PRODUCT_SLUG}.`)).toBe(true)
  })

  /*
   * The tarball URL and the semver range are the two things `init` can write
   * into a customer's package.json, and exactly one of them works at any given
   * moment. Asserting the pairing is what stops the flag being flipped in
   * anticipation of a publish that has not happened.
   */
  it('the dependency spec matches whether the packages are actually published', () => {
    if (PUBLISHED_TO_NPM) {
      expect(sdkDependencySpec()).toBe(`^${CLIENT_VERSION}`)
    } else {
      expect(sdkDependencySpec()).toContain(`${SDK_PACKAGE}-${CLIENT_VERSION}.tgz`)
    }
  })
})
