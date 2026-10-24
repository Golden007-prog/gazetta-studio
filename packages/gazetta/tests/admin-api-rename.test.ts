/**
 * Integration tests for Cut 6 — rename routes.
 *
 * Pins the locked behavior:
 *   - Q2 B1: 3-step composition (create-new → archive-old → flatten)
 *   - Q3 C1: two distinct 409 codes (NAME_COLLISION, ARCHIVED_NAME_CONFLICT)
 *   - Q4 D1: synchronous flatten cascade (Q3 G1 invariant: no chains)
 *   - Q5 E1+E5: whole-directory move; metadata.localeVariants in audit
 *   - Q6 F1: edit:* capability gates rename
 *   - Q8 H1: single composite `action: 'rename'` event
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import type { SiteManifest } from '../src/types.js'

let app: Hono
let storage: MemoryStorage

function setup(seed: Record<string, string> = {}, auth?: NonNullable<SiteManifest['admin']>['auth']) {
  storage = memoryStorage()
  storage.seed({
    'pages/home/page.json': JSON.stringify({ template: 'page-default', content: { title: 'Home' } }),
    'pages/landing/page.json': JSON.stringify({ template: 'page-default', content: { title: 'Landing' } }),
    'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout', content: {} }),
    ...seed,
  })

  const targetConfigs = {
    local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true },
  }
  const source = createSourceContext({
    storage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: { name: 'test-site', targets: targetConfigs, ...(auth ? { admin: { auth } } : {}) },
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

async function readJson(path: string): Promise<Record<string, unknown>> {
  const raw = await storage.readFile(path)
  return JSON.parse(raw) as Record<string, unknown>
}

async function postRename(name: string, body: Record<string, unknown>) {
  return app.request(`/api/pages/${name}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/pages/:name/rename — happy path', () => {
  beforeEach(() => setup())

  it('renames A → B: new manifest at B (live), old archived with aliasOf=B', async () => {
    const res = await postRename('landing', { to: 'new-landing' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      name: string
      fromName: string
      flattenedAliases: string[]
      localeVariants: string[]
    }
    expect(body.ok).toBe(true)
    expect(body.name).toBe('new-landing')
    expect(body.fromName).toBe('landing')
    expect(body.flattenedAliases).toEqual([])
    expect(body.localeVariants).toEqual([])

    // New name has live manifest with copied content.
    const newManifest = await readJson('pages/new-landing/page.json')
    expect(newManifest.archived).toBeUndefined()
    expect(newManifest.content).toEqual({ title: 'Landing' })

    // Old name is archived with aliasOf set.
    const oldManifest = await readJson('pages/landing/page.json')
    expect(oldManifest.archived).toBe(true)
    expect(oldManifest.aliasOf).toBe('new-landing')
    expect(typeof oldManifest.archivedAt).toBe('string')

    // Per-edge sidecar exists at .gazetta/alias-targets/new-landing/pages.landing.
    expect(await storage.exists('.gazetta/alias-targets/new-landing/pages.landing')).toBe(true)
  })

  it('keepAlias=false produces pure soft-delete (no aliasOf, no sidecar)', async () => {
    const res = await postRename('landing', { to: 'new-landing', keepAlias: false })
    expect(res.status).toBe(200)
    const oldManifest = await readJson('pages/landing/page.json')
    expect(oldManifest.archived).toBe(true)
    expect(oldManifest.aliasOf).toBeUndefined()
    // No alias-targets sidecar (no aliasOf).
    const dirEntries = await storage.readDir('.gazetta/alias-targets').catch(() => [])
    expect(dirEntries).toEqual([])
  })

  it('no-op rename (to === from) returns 200 without mutation', async () => {
    const res = await postRename('landing', { to: 'landing' })
    expect(res.status).toBe(200)
    const manifest = await readJson('pages/landing/page.json')
    expect(manifest.archived).toBeUndefined()
  })
})

describe('POST /api/pages/:name/rename — conflict shapes', () => {
  beforeEach(() => setup())

  it('409 NAME_COLLISION when the target is a live page', async () => {
    const res = await postRename('landing', { to: 'home' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; conflictKind: string; toName: string }
    expect(body.code).toBe('NAME_COLLISION')
    expect(body.conflictKind).toBe('live')
    expect(body.toName).toBe('home')
    // Source manifest unchanged.
    const landing = await readJson('pages/landing/page.json')
    expect(landing.archived).toBeUndefined()
  })

  it('409 ARCHIVED_NAME_CONFLICT when the target is archived', async () => {
    // Archive `home` first.
    await app.request('/api/pages/home/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'landing' }),
    })
    // Try to rename `landing → home` — refuses with the prompt body.
    const res = await postRename('landing', { to: 'home' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      code: string
      conflictKind: string
      toName: string
      archive: { archivedAt: string; archivedBy: string; aliasOf: string }
    }
    expect(body.code).toBe('ARCHIVED_NAME_CONFLICT')
    expect(body.conflictKind).toBe('archived')
    expect(body.toName).toBe('home')
    expect(body.archive.aliasOf).toBe('landing')
  })

  it('404 when source does not exist', async () => {
    const res = await postRename('missing', { to: 'whatever' })
    expect(res.status).toBe(404)
  })

  it('400 on missing `to` field', async () => {
    const res = await postRename('landing', {})
    expect(res.status).toBe(400)
  })
})

describe('POST /api/pages/:name/rename — flatten cascade', () => {
  beforeEach(() => setup())

  it('rewrites archive aliases when renaming the alias target', async () => {
    // Archive `landing` aliasing `home` → home now has an alias-pointer.
    await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    expect(await storage.exists('.gazetta/alias-targets/home/pages.landing')).toBe(true)

    // Rename `home` → `welcome` — flatten should rewrite landing's
    // aliasOf from 'home' to 'welcome'.
    const res = await postRename('home', { to: 'welcome' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { flattenedAliases: string[] }
    expect(body.flattenedAliases).toEqual(['landing'])

    // Landing's manifest now points at welcome (Q3 G1 invariant: no chains).
    const landingManifest = await readJson('pages/landing/page.json')
    expect(landingManifest.aliasOf).toBe('welcome')

    // Sidecar moved: old at home/pages.landing gone; new at welcome/pages.landing exists.
    expect(await storage.exists('.gazetta/alias-targets/home/pages.landing')).toBe(false)
    expect(await storage.exists('.gazetta/alias-targets/welcome/pages.landing')).toBe(true)
    // Plus the rename's own sidecar — home (archived with aliasOf=welcome).
    expect(await storage.exists('.gazetta/alias-targets/welcome/pages.home')).toBe(true)
  })

  it('handles multiple flattened aliases in one rename', async () => {
    setup({
      'pages/v1/page.json': JSON.stringify({ template: 'page-default', content: {} }),
      'pages/v2/page.json': JSON.stringify({ template: 'page-default', content: {} }),
      'pages/v3/page.json': JSON.stringify({ template: 'page-default', content: {} }),
    })
    // Archive v1, v2, v3 — all aliasing 'home'.
    for (const name of ['v1', 'v2', 'v3']) {
      await app.request(`/api/pages/${name}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aliasOf: 'home' }),
      })
    }
    // Rename home → welcome — all three flatten.
    const res = await postRename('home', { to: 'welcome' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { flattenedAliases: string[] }
    expect(body.flattenedAliases.sort()).toEqual(['v1', 'v2', 'v3'])
    // Each archive now points at welcome.
    for (const name of ['v1', 'v2', 'v3']) {
      const manifest = await readJson(`pages/${name}/page.json`)
      expect(manifest.aliasOf).toBe('welcome')
    }
  })
})

describe('POST /api/fragments/:name/rename', () => {
  beforeEach(() => setup())

  it('renames a fragment with the same shape as pages', async () => {
    const res = await app.request('/api/fragments/header/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'top-bar' }),
    })
    expect(res.status).toBe(200)
    expect(await storage.exists('fragments/top-bar/fragment.json')).toBe(true)
    const old = await readJson('fragments/header/fragment.json')
    expect(old.archived).toBe(true)
    expect(old.aliasOf).toBe('top-bar')
  })
})

describe('rename without keeping an alias', () => {
  // Same role mapping as the redirect capability tests: the built-in
  // editor role has edit:* but no delete:*.
  const editorAuth = {
    trust: 'forwarded-user' as const,
    allowAnyOrigin: true,
    roleMapping: { claim: 'groups', map: { editors: 'editor' }, defaultRole: 'viewer' },
  }
  const asEditor = {
    'Content-Type': 'application/json',
    'X-Forwarded-User': 'ed@example.com',
    'X-Forwarded-Email': 'ed@example.com',
    'X-Forwarded-Groups': 'editors',
  }

  it('needs delete:pages, so an editor gets 403 and nothing changes', async () => {
    setup({}, editorAuth)
    const res = await app.request('/api/pages/landing/rename', {
      method: 'POST',
      headers: asEditor,
      body: JSON.stringify({ to: 'welcome', keepAlias: false }),
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { missing?: string[] }).missing).toEqual(['delete:pages'])
    expect((await readJson('pages/landing/page.json')).archived).toBeUndefined()
    expect(await storage.exists('pages/welcome/page.json')).toBe(false)
  })

  it('still lets an editor rename with an alias', async () => {
    setup({}, editorAuth)
    const res = await app.request('/api/pages/landing/rename', {
      method: 'POST',
      headers: asEditor,
      body: JSON.stringify({ to: 'welcome' }),
    })
    expect(res.status).toBe(200)
  })

  it('refuses while pages still use the fragment, as archiving does, and changes nothing', async () => {
    setup({
      'pages/about/page.json': JSON.stringify({ template: 'page-default', content: {}, components: ['@header'] }),
    })
    const res = await app.request('/api/fragments/header/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'masthead', keepAlias: false }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code?: string; liveRefs?: Array<{ kind: string; name: string }> }
    expect(body.code).toBe('ARCHIVE_HAS_LIVE_REFS')
    expect(body.liveRefs).toContainEqual({ kind: 'page', name: 'about' })
    expect((await readJson('fragments/header/fragment.json')).archived).toBeUndefined()
    expect(await storage.exists('fragments/masthead/fragment.json')).toBe(false)
  })

  it('goes ahead with ?force=true, as archiving does', async () => {
    setup({
      'pages/about/page.json': JSON.stringify({ template: 'page-default', content: {}, components: ['@header'] }),
    })
    const res = await app.request('/api/fragments/header/rename?force=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'masthead', keepAlias: false }),
    })
    expect(res.status).toBe(200)
    expect((await readJson('fragments/header/fragment.json')).archived).toBe(true)
  })
})
