import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SDK_PACKAGE } from '@product'
import { afterAll, describe, expect, it } from 'vitest'

import { generateTypes } from '../src/typegen'

/**
 * The strongest assertion a code generator can make: the code it emits compiles,
 * under the strictest settings this repo uses — and a document the SDK returns
 * satisfies the interface the customer's app was handed.
 *
 * Everything a string-matching test can miss lives here: an unbalanced brace, a
 * name referenced before it is declared, an array of a union that forgot its
 * parentheses, a field whose optionality is spelled in a way the customer's
 * tsconfig rejects.
 *
 * The compiler is driven through its own API rather than a subprocess, so the
 * whole check costs about a second and needs nothing on PATH.
 */

/** `realpath` because macOS hands out a symlinked temp directory. */
const workdir = realpathSync(mkdtempSync(join(tmpdir(), 'typegen-')))

/** The package entry point, for resolving the generated file's augmentation. */
const SDK_INDEX = fileURLToPath(new URL('../src/index.ts', import.meta.url)).replace(/\\/g, '/')

/**
 * Pulling the SDK's real source into the program brings its own `@product`
 * import along, which the repo resolves through `tsconfig.base.json`. The temp
 * program has no tsconfig, so the mapping is restated here.
 */
const PRODUCT_CONFIG = fileURLToPath(
  new URL('../../../product.config.ts', import.meta.url),
).replace(/\\/g, '/')

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true })
})

interface Diagnostic {
  readonly file: string
  readonly message: string
}

async function compile(files: Readonly<Record<string, string>>): Promise<Diagnostic[]> {
  const ts = await import('typescript')

  const names: string[] = []
  for (const [name, contents] of Object.entries(files)) {
    const path = join(workdir, name)
    writeFileSync(path, contents)
    names.push(path)
  }

  const program = ts.createProgram(names, {
    noEmit: true,
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    /*
     * M14 — the generated file augments the SDK's module, so the compiler has to
     * be able to RESOLVE it. Pointing the specifier at this package's own source
     * is what turns "the augmentation is syntactically fine" into "the
     * augmentation actually reaches `ProjectContentTypes`", which is the claim
     * worth making. Without it TypeScript reports `Invalid module name in
     * augmentation` and nothing below is tested at all.
     */
    baseUrl: workdir,
    paths: { [SDK_PACKAGE]: [SDK_INDEX], '@product': [PRODUCT_CONFIG] },
  })

  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ({
      file: diagnostic.file?.fileName ?? '(global)',
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    }))
}

describe('the generated types file', () => {
  it('compiles under strict TypeScript, augmentation included', async () => {
    /*
     * M14 GAVE UP "compiles with no dependencies", knowingly and with one more
     * condition than expected.
     *
     * The file augments the SDK's module, so the SDK must not merely be
     * installed — it must be IN THE PROGRAM. TypeScript rejects an augmentation
     * of a module nothing imports, so `generated.ts` alone does not compile;
     * `generated.ts` beside any file that imports the package does. Every real
     * consumer qualifies, because the only reason to hold this file is to call
     * the client, and `init` writes the file and installs the package together.
     *
     * The one-line `app.ts` below is that condition, made explicit rather than
     * assumed — without it this test passes for the wrong reason on the day the
     * augmentation stops being emitted.
     */
    const app = `import type { ProjectContentTypes } from '${SDK_PACKAGE}'\nexport type Registry = ProjectContentTypes\n`
    const diagnostics = await compile({ 'generated.ts': generateTypes(), 'app.ts': app })
    expect(diagnostics.map((d) => d.message)).toEqual([])
  }, 30_000)

  it('ACTUALLY teaches the SDK the project’s types, key by key', async () => {
    /*
     * The claim §6 makes, compiled rather than asserted on a string: after the
     * augmentation, `client.get('page', …)` is typed from the KEY alone. The
     * `@ts-expect-error` is the other half and the more important one — it fails
     * this test if a bad field name ever stops being an error, which is the
     * exact regression that would make typegen decorative.
     */
    const usage = [
      "import type { ProjectContentTypes } from '${SDK}'",
      "import type { PageFields } from './generated'",
      '',
      'declare const registered: ProjectContentTypes',
      '',
      '// The key resolves to the project’s own interface, with no type argument.',
      'export const title: string = registered.page.title',
      '',
      'declare const page: PageFields',
      '// @ts-expect-error — `titel` is not a field of PageFields.',
      'export const typo: unknown = page.titel',
      '',
    ]
      .join('\n')
      .replace('${SDK}', SDK_PACKAGE)

    const diagnostics = await compile({ 'generated.ts': generateTypes(), 'usage.ts': usage })
    expect(diagnostics.map((d) => `${d.file}: ${d.message}`)).toEqual([])
  }, 30_000)

  it('describes exactly what the SDK returns, under every tsconfig', async () => {
    // If these two type surfaces ever drift, a customer's component would stop
    // accepting the very document `getPage` hands it. `exactOptionalPropertyTypes`
    // is on above, which is the setting that catches an optional field written
    // as `?: T` on one side and `?: T | undefined` on the other.
    const bridge = [
      "import type { Collection, Page, Post, Product } from './generated'",
      "import type {",
      '  Collection as SdkCollection,',
      '  Page as SdkPage,',
      '  Post as SdkPost,',
      '  Product as SdkProduct,',
      `} from '${SDK_PACKAGE}'`,
      '',
      'declare const page: SdkPage',
      'declare const post: SdkPost',
      'declare const product: SdkProduct',
      'declare const collection: SdkCollection',
      '',
      'export const asGenerated: [Page, Post, Product, Collection] = [',
      '  page,',
      '  post,',
      '  product,',
      '  collection,',
      ']',
      '',
      'declare const generatedPage: Page',
      'export const asSdk: SdkPage = generatedPage',
      '',
    ].join('\n')

    const diagnostics = await compile({ 'generated.ts': generateTypes(), 'bridge.ts': bridge })
    expect(diagnostics.map((d) => `${d.file}: ${d.message}`)).toEqual([])
  }, 30_000)
})
