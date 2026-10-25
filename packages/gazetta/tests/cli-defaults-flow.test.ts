/**
 * #1373: `gazetta.config.ts` `defaults.cache` / `defaults.audit` were
 * silently ignored by the CLI's site-loading path (dev, admin,
 * publish). Only `discoverSites` / `loadProjectConfig` applied them,
 * and no CLI command calls those. `buildSourceContext` and
 * `bootstrapFromSiteYaml` now hoist the project defaults into the
 * site manifest.
 *
 * End-to-end per the issue's acceptance criteria: a real project on
 * disk (gazetta.config.ts + site.config.ts) loaded through
 * `buildSourceContext` + `createAdminApp` reports the default cache's
 * `instance` from `/api/system/cache/stats`, and a site-level
 * `cache:` still overrides the project default.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { buildSourceContext } from '../src/cli/bootstrap.js'

// The project lives under the tests dir so the written configs can
// import the factories with the same relative style as the fixtures.
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-defaults-flow-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeProject(siteCacheLine: string) {
  writeFileSync(
    join(dir, 'gazetta.config.ts'),
    `import { memoryCache } from '../../src/cache/factories.js'
import { defineGazetta } from '../../src/config/define.js'

export default defineGazetta({
  defaults: {
    cache: memoryCache({ instance: 'from-gazetta-defaults' }),
    audit: { provider: 'history' },
  },
})
`,
  )
  writeFileSync(
    join(dir, 'site.config.ts'),
    `import { filesystemStorage } from '../../src/providers/factories.js'
import { memoryCache } from '../../src/cache/factories.js'
import { defineSite } from '../../src/config/define.js'

export default defineSite({
  name: 'test-site',
  ${siteCacheLine}
  targets: {
    local: { storage: filesystemStorage({ path: './local' }), type: 'esi', environment: 'local', editable: true },
  },
})
`,
  )
}

async function statsInstance(): Promise<unknown> {
  const { source, manifest, targetConfigs } = await buildSourceContext({ projectSiteDir: dir })
  expect(manifest.admin?.audit).toEqual({ provider: 'history' })
  const app = createAdminApp({
    source,
    siteDir: dir,
    templatesDir: join(dir, 'templates'),
    targets: new Map(),
    targetConfigs,
    disableCacheStatsLogger: true,
  })
  const res = await app.request('/api/system/cache/stats')
  expect(res.status).toBe(200)
  const body = (await res.json()) as { instance?: string }
  return body.instance
}

describe('CLI loading path applies gazetta.config.ts defaults (#1373)', { timeout: 30000 }, () => {
  it('a site without cache: inherits defaults.cache through buildSourceContext', async () => {
    writeProject('')
    expect(await statsInstance()).toBe('from-gazetta-defaults')
  })

  it('a site-level cache: still overrides the project default', async () => {
    writeProject("cache: memoryCache({ instance: 'from-site-config' }),")
    expect(await statsInstance()).toBe('from-site-config')
  })
})
