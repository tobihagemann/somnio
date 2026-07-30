import { defineConfig } from 'vitest/config'
import { buildDefines, swiftTreeAliases, xcstringsJSON } from './vite.config'

/**
 * Headless logic suite: the ported protocol, core geometry, transport, predictor, and the
 * DOM layer against `happy-dom`. No browser and no Swift server, so it runs in the
 * Node-only `web` CI job. The conformance suite that needs a live server lives in
 * `vitest.conformance.config.ts`.
 */
export default defineConfig({
  // The same build-time constants the app bundle gets; without them `__SOMNIO_WEB_VERSION__` is
  // an undefined identifier and every suite that imports the shell fails to evaluate.
  define: buildDefines,
  plugins: [xcstringsJSON()],
  resolve: { alias: swiftTreeAliases },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
    exclude: ['test/conformance/**'],
  },
})
