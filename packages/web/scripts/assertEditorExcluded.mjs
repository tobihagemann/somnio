// Runs after every `vite build` (the web package's `build` script), so the production bundle
// inside the image is checked as well as a local one. The editor entry is dev-only by
// construction: `editor.html` is never in `build.rollupOptions.input`, and this asserts that
// omission held. A text scan of the Vite config could not catch an entry added through a plugin
// hook or an editor module pulled into `dist/` by an `src/` import, so the check reads the
// output. Scoped to `dist/bundle` and `dist/index.html`, never `dist/` recursively: Vite copies
// `public/` into the output, and that may carry the multi-MB dev asset pack.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const markers = ['__editor/sectors', 'somnioEditor', 'somnio-editor-root']

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

if (existsSync(join(dist, 'editor.html'))) {
  fail('dist/editor.html is present: the editor entry leaked into the production build')
}
// Fail closed: with the build layout gone, a scan that finds nothing would pass having examined nothing.
if (!existsSync(join(dist, 'bundle')) || !existsSync(join(dist, 'index.html'))) {
  fail('expected build output missing (dist/bundle or dist/index.html): cannot verify the editor exclusion')
}

const files = [join(dist, 'index.html')]
for (const entry of readdirSync(join(dist, 'bundle'), { recursive: true, withFileTypes: true })) {
  if (entry.isFile()) files.push(join(entry.parentPath, entry.name))
}
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const hit = markers.find((marker) => text.includes(marker))
  if (hit !== undefined) {
    fail(
      `editor marker "${hit}" found in ${relative(dist, file)}: an src/ import pulled editor code into dist/`
    )
  }
}
