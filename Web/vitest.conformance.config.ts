import { defineConfig } from 'vitest/config'
import { swiftTreeAliases } from './vite.config'

/**
 * Wire-conformance suite. Separate from the default config because these specs dial a live
 * Swift gameplay server (stood up by `docker compose` in CI) rather than running pure
 * logic, and they need Node's `ws` rather than a DOM `WebSocket`. Keeping them out of the
 * default `include` is what lets the `web` job stay Node-only.
 */
export default defineConfig({
  resolve: { alias: swiftTreeAliases },
  test: {
    environment: 'node',
    include: ['test/conformance/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
