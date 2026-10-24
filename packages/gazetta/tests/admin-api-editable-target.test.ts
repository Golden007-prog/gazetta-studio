/**
 * Content-write routes refuse targets that aren't editable. Every admin
 * route resolves `?target=` to any configured target, so the write routes
 * check editability themselves. Reads, and the routes that move content
 * into targets by design (publish), aren't refused.
 */
import { describe, expect, it } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

function seeded(): MemoryStorage {
  const storage = memoryStorage()
  storage.seed({
    'pages/home/page.json': JSON.stringify({ template: 'page-default', metadata: { title: 'Home' }, components: [] }),
    'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout', components: [] }),
  })
  return storage
}

function buildApp() {
  const local = seeded()
  const production = seeded()
  const targetConfigs = {
    local: { storage: local, type: 'esi' as const, environment: 'local' as const, editable: true },
    production: {
      storage: production,
      type: 'esi' as const,
      environment: 'production' as const,
      editable: false,
      publicStorage: false,
    },
  }
  const source = createSourceContext({
    storage: local,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: { name: 'test-site', targets: targetConfigs },
  })
  const app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: starterTemplatesDir,
    targets: new Map([
      ['local', local],
      ['production', production],
    ]),
    targetConfigs,
    disableCacheStatsLogger: true,
  })
  return { app, production }
}

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

const page = { template: 'page-default', metadata: { title: 'Changed' }, components: [] }

const writes: Array<[string, string, string, unknown?]> = [
  ['create page', 'POST', '/api/pages', { name: 'planted', template: 'page-default' }],
  ['save page', 'PUT', '/api/pages/home', page],
  ['delete page', 'DELETE', '/api/pages/home'],
  ['create fragment', 'POST', '/api/fragments', { name: 'planted', template: 'header-layout' }],
  ['save fragment', 'PUT', '/api/fragments/header', { template: 'header-layout', components: [] }],
  ['delete fragment', 'DELETE', '/api/fragments/header'],
  ['rename page', 'POST', '/api/pages/home/rename', { to: 'renamed' }],
  ['rename fragment', 'POST', '/api/fragments/header/rename', { to: 'renamed' }],
  ['archive page', 'POST', '/api/pages/home/archive', {}],
  ['unarchive page', 'POST', '/api/pages/home/unarchive', {}],
  ['purge page', 'DELETE', '/api/pages/home/purge'],
  ['alias page', 'PATCH', '/api/pages/home/alias', { aliasOf: 'other' }],
  ['archive fragment', 'POST', '/api/fragments/header/archive', {}],
  ['unarchive fragment', 'POST', '/api/fragments/header/unarchive', {}],
  ['purge fragment', 'DELETE', '/api/fragments/header/purge'],
  ['alias fragment', 'PATCH', '/api/fragments/header/alias', { aliasOf: 'other' }],
  ['page redirect', 'POST', '/api/page-redirects', { from: 'old', to: 'home' }],
  ['fragment redirect', 'POST', '/api/fragment-redirects', { from: 'old', to: 'header' }],
  ['upload asset', 'POST', '/api/assets', {}],
  ['edit asset', 'PATCH', '/api/assets/hero', { alt: 'x' }],
  ['delete asset', 'DELETE', '/api/assets/hero'],
  ['rename asset', 'POST', '/api/assets/hero/rename-to/banner', {}],
  ['replace asset', 'POST', '/api/assets/hero/replace-with/banner', {}],
  ['add locale bytes', 'POST', '/api/assets/hero/locale-bytes?locale=fr', {}],
  ['remove locale bytes', 'DELETE', '/api/assets/hero/locale-bytes?locale=fr'],
]

const withTarget = (path: string, target: string) => `${path}${path.includes('?') ? '&' : '?'}target=${target}`

describe('content writes to a target that isn’t editable', { timeout: 30000 }, () => {
  it.each(writes)('%s is refused on production and writes nothing', async (_label, method, path, body) => {
    const { app, production } = buildApp()
    const before = new Map(production.dump())

    const res = await app.request(withTarget(path, 'production'), json(method, body))

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'TARGET_NOT_EDITABLE' })
    expect(production.dump()).toEqual(before)
  })

  it.each(writes)('%s is not refused on the editable target', async (_label, method, path, body) => {
    const { app } = buildApp()

    const res = await app.request(withTarget(path, 'local'), json(method, body))

    const payload = (await res.json().catch(() => ({}))) as { code?: string }
    expect(payload.code).not.toBe('TARGET_NOT_EDITABLE')
  })

  it.each([
    ['list pages', '/api/pages'],
    ['read a page', '/api/pages/home'],
    ['list fragments', '/api/fragments'],
  ])('%s still works on production', async (_label, path) => {
    const { app } = buildApp()

    const res = await app.request(withTarget(path, 'production'))

    expect(res.status).toBe(200)
  })
})
