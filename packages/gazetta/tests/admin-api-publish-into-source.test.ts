/**
 * #1526: `POST /api/publish` naming the editing source as a destination
 * copied the site onto itself. Parallel copies then read each other's
 * half-written temp files. The route refuses with 400 before writing
 * anything, and publishing to a real destination still works.
 */
import { describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

function buildApp(): { app: Hono; sourceStorage: MemoryStorage; targetStorage: MemoryStorage } {
  const sourceStorage = memoryStorage()
  const targetStorage = memoryStorage()
  sourceStorage.seed({
    'pages/about/page.json': JSON.stringify({
      template: 'page-default',
      route: '/about',
      content: { heading: 'About' },
    }),
  })

  const localConfig = { storage: sourceStorage, type: 'esi' as const, environment: 'local' as const, editable: true }
  const stagingConfig = { storage: targetStorage, type: 'esi' as const, environment: 'staging' as const }

  const source = createSourceContext({
    storage: sourceStorage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: { name: 'test-site', targets: { local: localConfig, staging: stagingConfig } },
  })

  const app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: starterTemplatesDir,
    targets: new Map([
      ['local', sourceStorage],
      ['staging', targetStorage],
    ]),
    targetConfigs: { local: localConfig, staging: stagingConfig },
    disableCacheStatsLogger: true,
  })
  return { app, sourceStorage, targetStorage }
}

/** Every stored path and its bytes, for "nothing was written" checks. */
function contents(storage: MemoryStorage): Record<string, string> {
  return Object.fromEntries([...storage.dump()].map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')]))
}

function publish(app: Hono, targets: string[]) {
  return app.request('/api/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: ['pages/about'], targets }),
  })
}

// In-process publishes through the starter's real templates (see #1525).
describe('publish route — refuses the editing source as a destination (#1526)', { timeout: 30_000 }, () => {
  it('answers 400 and writes nothing to the source', async () => {
    const { app, sourceStorage } = buildApp()
    const before = contents(sourceStorage)

    const res = await publish(app, ['local'])

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('Cannot publish to local: it is the editing source')
    expect(contents(sourceStorage)).toEqual(before)
  })

  it('still publishes to another target', async () => {
    const { app, targetStorage } = buildApp()

    const res = await publish(app, ['staging'])

    expect(res.status).toBeLessThan(300)
    // The rendered page, not only the copied manifest: a failed render can
    // still copy page.json.
    expect(await targetStorage.exists('about/index.html')).toBe(true)
  })
})
