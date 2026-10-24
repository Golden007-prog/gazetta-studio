/**
 * #1152 cut 1: every publish to a static target writes `404.html` at the
 * target root — plain hosts show it for paths with no file. ESI targets
 * get none: `gazetta serve` and the worker answer with the site's /404
 * page themselves.
 */
import { describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { MINIMAL_404_HTML } from '../src/static-404.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

const notFoundPage = (body: string) =>
  JSON.stringify({
    template: 'page-default',
    metadata: { title: 'Not here' },
    components: [{ name: 'message', template: 'text-block', content: { body } }],
  })

function buildApp(opts: { type: 'static' | 'esi'; with404?: boolean }): {
  app: Hono
  sourceStorage: MemoryStorage
  targetStorage: MemoryStorage
} {
  const sourceStorage = memoryStorage()
  const targetStorage = memoryStorage()
  sourceStorage.seed({
    'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout' }),
    ...(opts.with404 ? { 'pages/404/page.json': notFoundPage('<p>Lost-marker-one</p>') } : {}),
  })
  const targetConfig = { storage: targetStorage, type: opts.type, environment: 'staging' as const }
  const localConfig = { storage: sourceStorage, type: 'esi' as const, environment: 'local' as const, editable: true }
  const source = createSourceContext({
    storage: sourceStorage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: { name: 'test-site', targets: { local: localConfig, staging: targetConfig } },
  })
  const app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: starterTemplatesDir,
    targets: new Map([
      ['local', sourceStorage],
      ['staging', targetStorage],
    ]),
    targetConfigs: { local: localConfig, staging: targetConfig },
    disableCacheStatsLogger: true,
  })
  return { app, sourceStorage, targetStorage }
}

async function publish(app: Hono, items: string[]): Promise<void> {
  const res = await app.request('/api/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, targets: ['staging'] }),
  })
  expect(res.status).toBeLessThan(300)
}

describe('publish route — 404.html at a static target root (#1152)', { timeout: 30000 }, () => {
  it("writes the site's /404 page as 404.html on a static target", async () => {
    const { app, targetStorage } = buildApp({ type: 'static', with404: true })
    await publish(app, ['pages/404'])

    const html = await targetStorage.readFile('404.html')
    expect(html).toContain('Lost-marker-one')
    expect(html).toBe(await targetStorage.readFile('404/index.html'))
  })

  it('writes the minimal noindex page when the site has no /404 page', async () => {
    const { app, targetStorage } = buildApp({ type: 'static' })
    await publish(app, ['fragments/header'])

    expect(await targetStorage.readFile('404.html')).toBe(MINIMAL_404_HTML)
  })

  it('writes 404.html even when the publish renders no page', async () => {
    const { app, targetStorage } = buildApp({ type: 'static', with404: true })
    // On a static target a fragment with no users renders nothing.
    await publish(app, ['fragments/header'])

    expect(await targetStorage.readFile('404.html')).toContain('Lost-marker-one')
  })

  it('updates 404.html when the 404 page changes', async () => {
    const { app, sourceStorage, targetStorage } = buildApp({ type: 'static', with404: true })
    await publish(app, ['pages/404'])
    await sourceStorage.writeFile('pages/404/page.json', notFoundPage('<p>Lost-marker-two</p>'))
    await publish(app, ['pages/404'])

    const html = await targetStorage.readFile('404.html')
    expect(html).toContain('Lost-marker-two')
    expect(html).not.toContain('Lost-marker-one')
  })

  it('writes no 404.html on an ESI target', async () => {
    const { app, targetStorage } = buildApp({ type: 'esi', with404: true })
    await publish(app, ['pages/404'])

    expect(await targetStorage.exists('404.html')).toBe(false)
  })
})
