/**
 * Regression tests for #1139 — derived-index reads replaced by
 * in-memory scans of the loaded site.
 *
 * The `.gazetta/` dependency indices are derived state and aren't
 * committed, so a fresh clone or a `git pull` can leave them missing
 * or stale. Every test below runs with the relevant index missing,
 * empty, or deliberately lying, and asserts the operation still sees
 * the real state from the loaded site. Each test fails on pre-#1139
 * code, where the route read the index instead.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { resolveArchivedNameConflict } from '../src/admin-api/archived-name-conflict.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

let app: Hono
let storage: MemoryStorage

function setup(seed: Record<string, string> = {}) {
  storage = memoryStorage()
  storage.seed({
    'pages/home/page.json': JSON.stringify({ template: 'page-default', content: {} }),
    'pages/about/page.json': JSON.stringify({ template: 'page-default', content: {} }),
    ...seed,
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
  })
}

function makeSource() {
  return createSourceContext({
    storage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: {
      name: 'test-site',
      targets: {
        local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true },
      },
    },
  })
}

const archivedWithAlias = (aliasOf: string) =>
  JSON.stringify({
    template: 'page-default',
    content: {},
    archived: true,
    archivedAt: '2026-10-01T00:00:00.000Z',
    archivedBy: 'tester',
    aliasOf,
  })

describe('stale derived indices (#1139)', () => {
  beforeEach(() => setup())

  it('purge refuses when the alias-targets index is empty but an archive aliases the name', async () => {
    // `landing` is archived with aliasOf: home, but the
    // `.gazetta/alias-targets/` index was never built (fresh clone).
    storage.seed({ 'pages/landing/page.json': archivedWithAlias('home') })

    const res = await app.request('/api/pages/home/purge', { method: 'DELETE' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      code: string
      aliases: Array<{ kind: string; name: string }>
    }
    expect(body.code).toBe('DELETE_BLOCKED')
    expect(body.aliases).toEqual([{ kind: 'page', name: 'landing' }])

    // Refusal must not have purged anything.
    expect(await storage.exists('pages/home/page.json')).toBe(true)
    expect(await storage.exists('pages/landing/page.json')).toBe(true)
  })

  it('purge refuses when the fragment-deps index is empty but a page references the fragment', async () => {
    // Page references @header via its components; no
    // `.gazetta/fragment-deps/` sidecars exist.
    storage.seed({
      'fragments/header/fragment.json': JSON.stringify({
        template: 'header-layout',
        content: {},
        archived: true,
        archivedAt: '2026-10-01T00:00:00.000Z',
        archivedBy: 'tester',
      }),
      'pages/home/page.json': JSON.stringify({
        template: 'page-default',
        content: {},
        components: ['@header'],
      }),
    })

    const res = await app.request('/api/fragments/header/purge', { method: 'DELETE' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { liveRefs: Array<{ kind: string; name: string }> }
    expect(body.liveRefs).toEqual([{ kind: 'page', name: 'home' }])
    expect(await storage.exists('fragments/header/fragment.json')).toBe(true)
  })

  it('rename cascades to aliasing archives when the alias-targets index was never built', async () => {
    storage.seed({ 'pages/landing/page.json': archivedWithAlias('home') })

    const res = await app.request('/api/pages/home/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'front' }),
    })
    expect(res.status).toBe(200)

    // The aliasing archive now points at the new name.
    const manifest = JSON.parse(await storage.readFile('pages/landing/page.json')) as { aliasOf?: string }
    expect(manifest.aliasOf).toBe('front')
  })

  it('conflict Replace reports the flatten cascade from the site when the alias-targets index was never built', async () => {
    // `home` is archived; `landing` aliases it. The Replace cascade
    // reports the archives that aliased the name — on a fresh clone the
    // index is empty, so pre-#1139 code reported nothing.
    storage.seed({
      'pages/home/page.json': archivedWithAlias('about'),
      'pages/landing/page.json': archivedWithAlias('home'),
    })
    const existing = JSON.parse(await storage.readFile('pages/home/page.json')) as Record<string, unknown>

    const result = await resolveArchivedNameConflict({
      source: makeSource(),
      kind: 'page',
      name: 'home',
      existing: { ...existing, dir: 'pages/home' } as never,
      mode: 'replace',
      newTemplate: 'page-default',
      actorId: 'tester',
    })
    expect(result.kind).toBe('replaced')
    if (result.kind === 'replaced') expect(result.flattenedAliases).toEqual(['landing'])
  })

  it('conflict Move-aside reports the flatten cascade from the site when the alias-targets index was never built', async () => {
    storage.seed({
      'pages/home/page.json': archivedWithAlias('about'),
      'pages/landing/page.json': archivedWithAlias('home'),
    })
    const existing = JSON.parse(await storage.readFile('pages/home/page.json')) as Record<string, unknown>

    const result = await resolveArchivedNameConflict({
      source: makeSource(),
      kind: 'page',
      name: 'home',
      existing: { ...existing, dir: 'pages/home' } as never,
      mode: 'moveAside',
      newTemplate: 'page-default',
      actorId: 'tester',
    })
    expect(result.kind).toBe('moved-aside')
    if (result.kind === 'moved-aside') expect(result.flattenedAliases).toEqual(['landing'])
  })

  it('asset delete refuses against a stale asset-refs index and names the page that really uses the asset', async () => {
    // The index claims `contact` uses the asset (it no longer does) and
    // has no entry for `about` (which does). Seed both the manifest and
    // the stale sidecar.
    storage.seed({
      'assets/hero.asset.json': JSON.stringify({
        version: 1,
        name: 'hero',
        kind: 'embedded',
        source: 'internal',
        mime: 'image/jpeg',
        size: 10,
        hash: 'deadbeef',
        width: 16,
        height: 16,
        variants: [],
        alt: null,
        uploadedBy: 'tester',
        uploadedAt: '2026-10-01T00:00:00.000Z',
      }),
      'pages/about/page.json': JSON.stringify({
        template: 'page-default',
        content: { image: { _asset: 'hero' } },
      }),
      '.gazetta/asset-refs/hero/pages.contact': JSON.stringify({ refs: [] }),
    })

    const res = await app.request('/api/assets/hero', { method: 'DELETE' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { refs: Array<{ path?: string }> }
    const paths = body.refs.map(r => r.path ?? '')
    expect(paths.some(p => p.includes('about'))).toBe(true)
    expect(paths.some(p => p.includes('contact'))).toBe(false)
    // Refusal must not have deleted the asset manifest.
    expect(await storage.exists('assets/hero.asset.json')).toBe(true)
  })
})
