import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['apps/*/test/**/*.e2e.test.ts'], testTimeout: 200_000, hookTimeout: 200_000 } });
