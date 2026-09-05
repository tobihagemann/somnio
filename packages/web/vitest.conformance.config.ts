import { defineConfig } from 'vitest/config'
import { repoAliases } from './vite.config'

/**
 * Wire-conformance suite. Separate from the default config because these specs dial a live
 * gameplay server (stood up by `docker compose` in CI) rather than running pure logic, and
 * they need Node's `ws` rather than a DOM `WebSocket`. Keeping them out of the default
 * `include` is what lets the `checks` job stay container-free.
 */
export default defineConfig({
  resolve: { alias: repoAliases },
  test: {
    environment: 'node',
    include: ['test/conformance/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
