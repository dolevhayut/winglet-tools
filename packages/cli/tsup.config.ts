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
})
