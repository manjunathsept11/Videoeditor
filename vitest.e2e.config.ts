import { defineConfig } from 'vitest/config';

// One file at a time: every e2e file renders with software WebGL, and running them together starves the CPU.
export default defineConfig({ test: { include: ['apps/*/test/**/*.e2e.test.ts'], testTimeout: 200_000, hookTimeout: 200_000, fileParallelism: false } });
