import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  dts: true,
  clean: true,
  // Closed source — see the note in the SDK config.
  sourcemap: false,
  noExternal: ['@product'],
  /**
   * `sharp` is a NATIVE module and an optional dependency, used only to shrink
   * an oversized image during `import`. Bundling it — which is what tsup does by
   * default to anything outside `dependencies` — inlined it into a chunk whose
   * bindings cannot load, so the dynamic import failed at runtime and the one
   * 46MB photograph in a real migration was silently skipped. External it is,
   * and the import stays guarded for the case where it is genuinely absent.
   */
  external: ['sharp'],
})
