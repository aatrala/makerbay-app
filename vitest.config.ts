import { defineConfig } from 'vitest/config'

// Only pure logic is tested here: slot computation, money arithmetic, CSV
// parsing, contact normalisation. Anything needing AWS belongs in an
// integration test against the deployed stack, not in this suite.
export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/cdk.out/**'],
  },
})
