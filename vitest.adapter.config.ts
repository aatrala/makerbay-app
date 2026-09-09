import { defineConfig } from 'vitest/config'

// The Better Auth adapter conformance suites (packages/auth). Separate from
// the unit config because they need a DynamoDB - Local in Docker, or a
// throwaway table in the account - and the unit suite must stay runnable
// with no AWS at all.
export default defineConfig({
  test: {
    include: ['**/*.itest.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/cdk.out/**'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
})
