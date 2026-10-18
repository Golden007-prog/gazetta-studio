import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30000,
  // expect() default is 5s — too tight on CI where compare + walk runs
  // 8-12s per test. Individual expect() calls can still override lower.
  expect: { timeout: 15000 },
  retries: 0,
  // Local runs use multiple workers — each gets its own temp site copy
  // and dev server on port 3100+workerIdx (see tests/e2e/fixtures.ts).
  // On CI we shard across matrix jobs instead (one worker per shard),
  // so fix it to 1 there to avoid doubly-parallelising. Locally, 2 workers
  // is the reliable sweet spot — 4 hits timing races under load.
  workers: process.env.CI ? 1 : 2,
  fullyParallel: true,
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'dev',
      // Feature suites use `.spec.ts` (see the Phase 1 restructure that
      // split the old editor.test.ts). a11y.test.ts predates the rename
      // and stays on `.test.ts`. Production runs against pre-built admins
      // on fixed ports in their own projects — exclude them here. Matrix
      // runs against its own fixture site (tests/fixtures/sites/target-
      // matrix) so `matrix/**` is excluded too.
      // testIgnore applies to basenames consistently; a negative-lookahead
      // on testMatch would match the full path and wouldn't catch
      // `tests/e2e/production-esi.test.ts`.
      testMatch: ['**/*.test.ts', '**/*.spec.ts'],
      testIgnore: ['**/production.test.ts', '**/production-*.test.ts', '**/matrix/**'],
      // baseURL is set per-worker by the testSite fixture in tests/e2e/fixtures.ts
    },
    {
      name: 'prod-admin',
      testMatch: ['production.test.ts', 'production-offline.test.ts'],
      use: { baseURL: 'http://localhost:4002' },
    },
    {
      name: 'prod-static',
      testMatch: 'production-static.test.ts',
      use: { baseURL: 'http://localhost:4003' },
    },
    {
      name: 'prod-esi',
      testMatch: 'production-esi.test.ts',
      use: { baseURL: 'http://localhost:4004' },
    },
    {
      name: 'matrix',
      // Parameterized env × editable × type tests against the target-matrix
      // fixture site. The site under tests/fixtures/sites/target-matrix/
      // ships 8 targets — one per meaningful axis-value combination — so
      // matrix tests assert on admin UI chrome reactions to those props
      // without spinning up a per-row dev server.
      testMatch: ['**/matrix/**/*.spec.ts'],
      use: { baseURL: 'http://localhost:4005' },
    },
  ],
  webServer: [
    // The dev server for editor.test.ts is no longer global — the testSite
    // fixture spawns one per worker against a temp site copy. See tests/e2e/fixtures.ts.
    {
      command:
        'cd examples/starter && node ../../packages/gazetta/dist/cli/index.js build sites/main && node ../../packages/gazetta/dist/cli/index.js admin sites/main -p 4002',
      url: 'http://localhost:4002/admin',
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
    {
      command:
        'cd examples/starter && npx tsx ../../packages/gazetta/src/cli/index.ts publish staging sites/main && node ../../packages/gazetta/dist/cli/index.js serve staging sites/main -p 4003',
      url: 'http://localhost:4003/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
    {
      command:
        'cd examples/starter && npx tsx ../../packages/gazetta/src/cli/index.ts publish esi-test sites/main && node ../../packages/gazetta/dist/cli/index.js serve esi-test sites/main -p 4004',
      url: 'http://localhost:4004/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
    {
      // Matrix fixture site — 8 targets covering env × editable × type.
      // Runs as a dev server (not a prod serve) because matrix tests
      // exercise the admin UI, not the rendered site.
      command:
        'cd tests/fixtures/sites/target-matrix && npx tsx ../../../../packages/gazetta/src/cli/index.ts dev sites/main --port 4005',
      url: 'http://localhost:4005/admin',
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
  ],
})
