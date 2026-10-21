import { defineConfig } from 'vitest/config';

// Real git and child processes slow down when every package runs its tests in parallel (CI does).
export default defineConfig({ test: { testTimeout: 30_000 } });
