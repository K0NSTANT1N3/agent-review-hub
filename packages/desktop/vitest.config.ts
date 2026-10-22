import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: { include: ['test/**/*.test.ts', 'test/**/*.test.tsx'], exclude: ['stage/**', 'release/**', 'node_modules/**'], testTimeout: 30_000 },
});
