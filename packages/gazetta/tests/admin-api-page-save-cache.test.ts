/**
 * #982 — `PUT /api/pages/:name` must keep the manifest's `cache` field.
 * The publisher reads `page.cache` for Cache-Control, so a save that
 * drops it silently resets the page to the target's defaults.
 *
 * Per rule 26: every test builds a fresh `memoryStorage()` + app.
 */
import { describe, expect, it } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { createValidatorRegistry } from '../src/validation/registry.js'
import { memoryStorage } from './_helpers/memory-storage.js'

function setup(files: Record<string, unknown>) {
  const storage = memoryStorage()
  storage.seed(Object.fromEntries(Object.entries(files).map(([p, v]) => [p, JSON.stringify(v)])))
  const targetConfigs = {
    local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true },
  }
  const source = createSourceContext({
    storage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: {
      name: 'test-site',
      targets: targetConfigs,
      locales: { default: 'en', supported: ['en', 'fr'] },
    },
  })
  const app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    targets: new Map([['local', storage]]),
    targetConfigs,
    disableCacheStatsLogger: true,
    validators: createValidatorRegistry([]),
  })
  return { app, storage }
}

async function put(app: ReturnType<typeof setup>['app'], url: string, body: unknown) {
  return app.request(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('page save keeps cache (#982)', () => {
  it('a content-only save keeps page.json cache', async () => {
    const { app, storage } = setup({
      'pages/home/page.json': {
        template: 'page-default',
        content: { title: 'Home' },
        components: [],
        cache: { browser: 60 },
      },
    })
    const res = await put(app, '/api/pages/home', { content: { title: 'Changed' } })
    expect(res.status).toBe(200)
    const saved = JSON.parse(await storage.readFile('pages/home/page.json'))
    expect(saved.content).toEqual({ title: 'Changed' })
    expect(saved.cache).toEqual({ browser: 60 })
  })

  it('a locale-variant save keeps page.fr.json its own cache', async () => {
    const { app, storage } = setup({
      'pages/home/page.json': {
        template: 'page-default',
        content: { title: 'Home' },
        components: [],
        cache: { browser: 60 },
      },
      'pages/home/page.fr.json': {
        template: 'page-default',
        content: { title: 'Accueil' },
        components: [],
        cache: { edge: 300 },
      },
    })
    const res = await put(app, '/api/pages/home?locale=fr', { content: { title: 'Changé' } })
    expect(res.status).toBe(200)
    const saved = JSON.parse(await storage.readFile('pages/home/page.fr.json'))
    expect(saved.content).toEqual({ title: 'Changé' })
    expect(saved.cache).toEqual({ edge: 300 })
  })

  it('a save without cache in file or body writes no cache key', async () => {
    const { app, storage } = setup({
      'pages/home/page.json': { template: 'page-default', content: { title: 'Home' }, components: [] },
    })
    const res = await put(app, '/api/pages/home', { content: { title: 'Changed' } })
    expect(res.status).toBe(200)
    const saved = JSON.parse(await storage.readFile('pages/home/page.json'))
    expect('cache' in saved).toBe(false)
  })

  it("the body's cache replaces the file's", async () => {
    const { app, storage } = setup({
      'pages/home/page.json': {
        template: 'page-default',
        content: { title: 'Home' },
        components: [],
        cache: { browser: 60 },
      },
    })
    const res = await put(app, '/api/pages/home', { cache: { browser: 5 } })
    expect(res.status).toBe(200)
    const saved = JSON.parse(await storage.readFile('pages/home/page.json'))
    expect(saved.cache).toEqual({ browser: 5 })
  })
})
