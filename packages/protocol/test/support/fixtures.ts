import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The golden-frame fixture, resolved from this file so no test depends on the cwd. */
export const GOLDEN_FRAMES_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/golden-frames.json');
