import { defineConfig } from 'vitest/config'

// Separate from vitest.config.ts (unit tests, no external services) — this suite requires
// DynamoDB Local running (docker-compose.integration.yml) and is not part of test:pre-pr.
export default defineConfig({
  test: {
    globals: true,
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['tests/integration/setup-env.ts'],
    testTimeout: 15000,
  },
})
