import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scenarios/**/*.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 60_000,
    // Scenarios spawn real git processes, sockets and timers; run files one at a time.
    fileParallelism: false,
  },
});
