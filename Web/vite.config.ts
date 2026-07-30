import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'

const webRoot = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * Four repository paths are read directly rather than copied, so the browser never
 * re-derives them: the model registry, the `.xcstrings` catalogs, (tests only) the
 * golden-frame fixtures, and (tests only) the build scripts in `Scripts/`. Vite's root is
 * `Web/`, so both the aliases below and `server.fs.allow` have to reach above it —
 * otherwise the dev server refuses the read and an implementer "fixes" it by forking copies
 * into `Web/`, reintroducing exactly the drift the hand-mirror plus conformance strategy
 * exists to prevent.
 *
 * `@scripts` exists so the Vitest suite can reach `Scripts/glb-buffer-uris.mjs`, whose consumer
 * (`bundle-web-assets.sh`) cannot detect it failing. An alias rather than relocating the script
 * into `Web/`: it is a build-tool sibling of the shell script that runs it, and it also runs from
 * the image build stage, where nothing resolves a Vite alias.
 */
export const swiftTreeAliases = {
  '@': `${webRoot}src`,
  '@registry': `${repoRoot}Sources/SomnioCore/Resources/ModelRegistry.json`,
  '@catalog/core': `${repoRoot}Sources/SomnioCore/Resources/Localizable.xcstrings`,
  '@catalog/ui': `${repoRoot}Sources/SomnioUI/Resources/Localizable.xcstrings`,
  '@catalog/app': `${repoRoot}Sources/SomnioApp/Resources/Localizable.xcstrings`,
  '@fixtures': `${repoRoot}Tests/SomnioProtocolTests/GoldenFrames`,
  '@scripts': `${repoRoot}Scripts`,
}

/**
 * Loads `.xcstrings` as a JSON module. `resolveJsonModule` only covers `.json`, and without this
 * Vite would treat the catalogs as opaque assets — so the strings would resolve to a URL string
 * instead of the catalog, and every lookup would silently fall back to its English key.
 */
export function xcstringsJSON(): Plugin {
  return {
    name: 'somnio-xcstrings-json',
    enforce: 'pre',
    async load(id) {
      if (!id.endsWith('.xcstrings')) return null
      return `export default ${await readFile(id, 'utf8')}`
    },
  }
}

/**
 * Build-time constants. `SOMNIO_WEB_VERSION` comes from the environment (the image build passes the
 * release version); an unset value is a local build and reports 0.0.0.
 *
 * An explicit `define` rather than Vite's `VITE_`-prefixed `import.meta.env` pickup, so the
 * injection depends on this file rather than on which variables Vite chooses to expose. The image
 * build greps the bundle for the folded result instead of trusting either mechanism.
 */
export const buildDefines = {
  __SOMNIO_WEB_VERSION__: JSON.stringify(process.env.SOMNIO_WEB_VERSION ?? '0.0.0'),
}

export default defineConfig({
  define: buildDefines,
  plugins: [xcstringsJSON()],
  resolve: { alias: swiftTreeAliases },
  server: {
    fs: { allow: [repoRoot] },
    proxy: {
      // Development does not share an origin with the gameplay server the way production
      // does: Vite serves the page and the Swift server listens on :8090 (the local dev
      // port). Proxying `/ws` here means `wss://<origin>/ws` resolves in both environments,
      // so the endpoint resolver needs no dev-only branch.
      '/ws': {
        target: process.env.SOMNIO_DEV_GAMEPLAY_ORIGIN ?? 'http://127.0.0.1:8090',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    // Vite's hashed bundles go in `bundle/`, not the default `assets/`, because the operator-supplied
    // asset pack owns `dist/assets/` (`Models/`, `FloorMaterials/`, `UI/`, referenced by absolute
    // `/assets/...` URLs). Leaving both in one directory works only by filename luck.
    assetsDir: 'bundle',
    sourcemap: true,
    target: 'es2023',
  },
})
