import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    hookTimeout: 60000,
    globalSetup: ['./tests/helpers/build-config-setup.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          setupFiles: ['./tests/helpers/dev-server-setup.ts'],
          hookTimeout: 60000,
          testTimeout: 30000,
          threads: true,
          singleThread: true,
        },
      },
    ],
  },
})
