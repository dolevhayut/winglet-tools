import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/** The SDK's own type module, as a specifier the compiler can follow from there. */
const SDK_TYPES = relative(
  workdir,
  fileURLToPath(new URL('../src/types', import.meta.url)),
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
  })

  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ({
      file: diagnostic.file?.fileName ?? '(global)',
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    }))
}

describe('the generated types file', () => {
  it('compiles on its own under strict TypeScript', async () => {
    const diagnostics = await compile({ 'generated.ts': generateTypes() })
    expect(diagnostics.map((d) => d.message)).toEqual([])
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
      `} from '${SDK_TYPES}'`,
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
