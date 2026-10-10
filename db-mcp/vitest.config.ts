import { defineConfig } from 'vitest/config'

// unit: sem banco. integration: Postgres 16 real (DB_MCP_IT_ADMIN_URL e cia., ver tests/*.integration.test.ts).
export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      { test: { name: 'unit', include: ['tests/**/*.test.ts'], exclude: ['tests/**/*.integration.test.ts'] } },
      { test: { name: 'integration', include: ['tests/**/*.integration.test.ts'], testTimeout: 30_000, hookTimeout: 120_000, fileParallelism: false } },
    ],
  },
})
