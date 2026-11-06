import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Unit tests for the logic that doesn't need Electron or a window: parsers, rules and helpers of
 * main, shared and the renderer. Tests live next to their module as `*.test.ts`, so the typecheck
 * covers them too. Modules that import `electron` get it mocked with `vi.mock('electron', …)`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@': resolve('src/renderer/src'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Dates in labels ("Reset Mo. 04:00") depend on the time zone; the same everywhere, CI included.
    env: { TZ: 'Europe/Berlin' },
  },
})
