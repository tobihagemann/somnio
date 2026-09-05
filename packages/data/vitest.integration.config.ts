import { defineConfig } from 'vitest/config'

/** Testcontainers Postgres per file; joins the root run only under `SOMNIO_INTEGRATION=1`. */
export default defineConfig({
  test: {
    name: 'data-integration',
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
