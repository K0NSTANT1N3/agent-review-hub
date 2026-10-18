import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['load/**/*.test.ts'],
    // The workload has a ten-minute deadline; allow extra time for setup and diagnostics.
    testTimeout: 12 * 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    env: { QUORUM_LOG_LEVEL: 'silent' },
  },
});
