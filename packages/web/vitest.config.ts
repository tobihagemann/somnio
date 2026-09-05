import { defineConfig } from 'vitest/config'
import { buildDefines, repoAliases } from './vite.config'

/**
 * Headless logic suite: the transport, the predictor, the scene math, and the DOM layer against
 * `happy-dom`. No browser and no gameplay server. The conformance suite
 * that needs a live server lives in `vitest.conformance.config.ts`.
 */
export default defineConfig({
  // The same build-time constants the app bundle gets; without them `__SOMNIO_WEB_VERSION__` is
  // an undefined identifier and every suite that imports the shell fails to evaluate.
  define: buildDefines,
  resolve: { alias: repoAliases },
  test: {
    name: 'web',
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**', 'test/conformance/**'],
  },
})
