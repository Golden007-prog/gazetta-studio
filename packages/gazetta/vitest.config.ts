import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The suite loads dist/templates-scan-worker.js and imports the built
    // package by name, so it cannot run before `npm run build`. Fail fast
    // with that message instead of an unrelated stack trace. See #1361.
    globalSetup: ['./tests/global-setup.ts'],
  },
})
