import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer/src') } },
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      include: ['src/main/**/*.ts', 'src/shared/**/*.ts'],
      // Electron-bound code is covered by the Playwright suites in e2e/
      exclude: ['src/main/index.ts', 'src/main/handlers.ts'],
      thresholds: {
        // Keep a modest floor while the Electron-only wiring remains covered by E2E.
        statements: 25,
        lines: 25,
        functions: 20,
        branches: 20,
      },
    },
  },
})
