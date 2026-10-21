import { defineConfig } from 'vitest/config';

// Ink render tests slow down when every package runs its tests in parallel (CI does).
export default defineConfig({ test: { testTimeout: 30_000 } });
