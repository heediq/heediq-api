import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    // tests/integration/ requires DynamoDB Local + its own env setup — run via
    // `pnpm run test:integration` (vitest.integration.config.ts), not the unit suite.
    exclude: ['**/node_modules/**', 'tests/integration/**'],
  },
})
