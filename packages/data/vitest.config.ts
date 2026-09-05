import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'data',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**', 'test/conformance/**'],
  },
});
