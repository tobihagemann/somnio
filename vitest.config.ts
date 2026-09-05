import { defineConfig } from 'vitest/config';

/**
 * One Vitest invocation for the whole workspace. Every package's unit suite is a project that
 * runs without Docker; the integration projects (testcontainers Postgres) join the list only
 * when `SOMNIO_INTEGRATION=1`, so the default `npm test` — and the pre-commit hook that runs it —
 * never starts a container.
 */
const unitProjects = [
  'packages/protocol/vitest.config.ts',
  'packages/core/vitest.config.ts',
  'packages/data/vitest.config.ts',
  'packages/server/vitest.config.ts',
  'packages/cli/vitest.config.ts',
  'packages/web/vitest.config.ts',
];

const integrationProjects = ['packages/data/vitest.integration.config.ts', 'packages/server/vitest.integration.config.ts'];

export default defineConfig({
  test: {
    projects: process.env.SOMNIO_INTEGRATION === '1' ? [...unitProjects, ...integrationProjects] : unitProjects,
  },
});
