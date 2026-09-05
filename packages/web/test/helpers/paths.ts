import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Filesystem anchors for tests that read files, resolved from this module's own location
 * rather than `process.cwd()`: the root Vitest run starts every project from the workspace
 * root, so a cwd-relative path resolves differently there than under a per-package run.
 *
 * `fileURLToPath` on the string `import.meta.url` rather than on a `URL` built from it —
 * `happy-dom` installs its own `URL` global, which Node's `fileURLToPath` refuses.
 */
const helpersDirectory = dirname(fileURLToPath(import.meta.url));

/** `packages/web/`. */
export const WEB_ROOT = resolve(helpersDirectory, '..', '..');
