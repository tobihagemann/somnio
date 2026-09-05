import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { editorSectorFs } from './vite.editorFs'

const webRoot = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Vite's root is `packages/web/`, and the workspace packages this one imports read committed data
 * files above it (the core package's model registry), so `server.fs.allow` has to reach the
 * repository root — otherwise the dev server refuses the read.
 *
 * `@scripts` exists so the Vitest suite can reach `Scripts/glb-buffer-uris.mjs`, whose consumer
 * (`bundle-web-assets.sh`) cannot detect it failing. An alias rather than relocating the script
 * into this package: it is a build-tool sibling of the shell script that runs it, and it also runs
 * from the image build stage, where nothing resolves a Vite alias.
 */
export const repoAliases = {
  '@': `${webRoot}src`,
  '@scripts': `${repoRoot}Scripts`,
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
  // `editorSectorFs` is dev-only twice over: a `configureServer` hook that no build or preview
  // server runs, gated on `SOMNIO_EDITOR_SECTORS_DIR` (set by the `editor` npm script).
  plugins: [editorSectorFs()],
  resolve: { alias: repoAliases },
  server: {
    port: 17669,
    fs: { allow: [repoRoot] },
    proxy: {
      // Development does not share an origin with the gameplay server the way production
      // does: Vite serves the page and the gameplay server listens on :17662 (the local dev
      // port). Proxying `/ws` here means `wss://<origin>/ws` resolves in both environments,
      // so the endpoint resolver needs no dev-only branch.
      '/ws': {
        target: process.env.SOMNIO_DEV_GAMEPLAY_ORIGIN ?? 'http://127.0.0.1:17662',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    // Deliberately no `rollupOptions.input`: the default single-input build (`index.html`
    // alone) is what keeps `editor.html` out of `dist/` and therefore out of the shipped
    // image — the editor is served only by `vite dev`. `Scripts/lint.sh` builds and asserts
    // this, so the omission is machine-enforced, not remembered.
    outDir: 'dist',
    // Vite's hashed bundles go in `bundle/`, not the default `assets/`, because the operator-supplied
    // asset pack owns `dist/assets/` (`Models/`, `FloorMaterials/`, `UI/`, referenced by absolute
    // `/assets/...` URLs). Leaving both in one directory works only by filename luck.
    assetsDir: 'bundle',
    sourcemap: true,
    target: 'es2023',
  },
})
