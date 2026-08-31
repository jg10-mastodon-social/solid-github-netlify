import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['netlify/functions/**/*.mts'],
    },
  },
  resolve: {
    extensions: ['.mts', '.ts', '.mjs', '.js'],
  },
})
