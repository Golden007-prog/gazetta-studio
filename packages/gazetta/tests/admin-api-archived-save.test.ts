/**
 * #1340 — saving an archived page or fragment must not silently un-archive
 * it. Archived items are read-only in the editor (design-soft-delete.md),
 * so the save API refuses with 409 ARCHIVED and writes nothing. On the
 * unfixed save path this same valid save answers 200 and rebuilds the
 * manifest without archived/archivedAt/aliasOf — the page silently
 * comes back to live. The fixture uses an empty validator registry so
 * nothing else can fail first and mask that bug.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { createValidatorRegistry } from '../src/validation/registry.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

let app: Hono
let storage: MemoryStorage

beforeEach(() => {
  storage = memoryStorage()
  storage.seed({
    'pages/home/page.json': JSON.stringify({ template: 'page-default', content: { title: 'Home' } }),
    'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout', content: {} }),
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
  app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    targets: new Map([['local', storage]]),
    targetConfigs,
    disableCacheStatsLogger: true,
    validators: createValidatorRegistry([]),
  })
})

describe('PUT on an archived item (#1340)', () => {
  it('answers 409 ARCHIVED for an archived page and writes nothing', async () => {
    const archive = await app.request('/api/pages/home/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(archive.status).toBe(200)
    const before = await storage.readFile('pages/home/page.json')
    expect(JSON.parse(before).archived).toBe(true)

    const res = await app.request('/api/pages/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { title: 'Edited' } }),
    })

    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('ARCHIVED')
    expect(body.message).toBe('Archived. Restore to edit.')
    expect(await storage.readFile('pages/home/page.json')).toBe(before)
  })

  it('answers 409 ARCHIVED for an archived fragment and writes nothing', async () => {
    const archive = await app.request('/api/fragments/header/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(archive.status).toBe(200)
    const before = await storage.readFile('fragments/header/fragment.json')
    expect(JSON.parse(before).archived).toBe(true)

    const res = await app.request('/api/fragments/header', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: {} }),
    })

    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('ARCHIVED')
    expect(body.message).toBe('Archived. Restore to edit.')
    expect(await storage.readFile('fragments/header/fragment.json')).toBe(before)
  })
})
