import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/stdio.ts', 'src/http.ts'],
  format: ['esm'],
  target: 'node20',
  dts: false,
  clean: true,
  sourcemap: false,
  noExternal: ['@product'],
})
