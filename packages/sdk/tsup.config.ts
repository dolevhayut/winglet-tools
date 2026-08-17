import { defineConfig } from 'tsup'

export default defineConfig({
  // Three entries, three subpaths. `revalidate` is separate so that importing
  // the main entry never pulls in `next/cache`, which only exists inside a Next
  // runtime; `seo` is separate so that its `Metadata` type — the one place this
  // package names a type from `next` — stays out of the main entry's
  // declarations, where it would make the SDK untypeable without Next installed.
  entry: ['src/index.ts', 'src/revalidate.ts', 'src/seo.ts'],
  format: ['esm'],
  target: 'node20',
  dts: true,
  clean: true,
  // Closed source: sourcemaps inline the original TypeScript, and `files: ["dist"]`
  // would publish them to npm. Never emit them from a publishable package.
  sourcemap: false,
  treeshake: true,
  splitting: true,
  // `@product` lives outside the package, so it must be inlined, not externalised.
  noExternal: ['@product'],
  external: ['next', 'react', 'zod'],
})
