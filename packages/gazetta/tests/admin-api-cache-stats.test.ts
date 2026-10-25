/**
 * #1400: GET /api/system/cache/stats reported `lastInvalidation.prefix`
 * in the inner provider's wrapped terms (`site:<name>:pages:`), while
 * the invalidation stream and docs/cache.md show the consumer-facing
 * `pages:`. forSite now strips its own prefix in stats().
 *
 * Route test per the issue's acceptance criteria: after a page save,
 * the stats route's `lastInvalidation.prefix` is `pages:`.
 */
import { describe, expect, it } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

describe('GET /api/system/cache/stats (#1400)', { timeout: 30000 }, () => {
  it('reports lastInvalidation.prefix without the internal site prefix after a page save', async () => {
    const storage = memoryStorage()
    storage.seed({
      'pages/home/page.json': JSON.stringify({
        template: 'page-default',
        content: { title: 'Home' },
        components: [],
      }),
    })
    const targetConfigs = {
      local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true },
    }
    const source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: { name: 'test-site', targets: targetConfigs },
    })
    const app = createAdminApp({
      source,
      siteDir: '/test-project',
      templatesDir: starterTemplatesDir,
      targets: new Map([['local', storage]]),
      targetConfigs,
      disableCacheStatsLogger: true,
    })

    const save = await app.request('/api/pages/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { title: 'Changed' } }),
    })
    expect(save.status).toBe(200)

    const res = await app.request('/api/system/cache/stats')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      lastInvalidation?: { prefix: string; at: string; source: string }
    }
    expect(body.lastInvalidation?.prefix).toBe('pages:')
  })
})
