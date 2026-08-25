import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/setup-localstorage.ts'],
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
  },
})
