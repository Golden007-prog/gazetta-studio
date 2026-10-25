/**
 * Cut 11 — archived-name-conflict prompt UX tests.
 *
 * Pins the locked behavior per design-soft-delete.md Q5 I3:
 *   - POST without onConflict on an archived name → 409 ARCHIVED_NAME_CONFLICT
 *   - POST with `?onConflict=restore` → unarchives existing archive
 *   - POST with `?onConflict=replace` → purges + creates new
 *   - POST with `?onConflict=moveAside` → renames archive to <name>-archived-<date>
 *   - Live conflicts (non-archived) keep the existing 409 message
 *   - Invalid onConflict mode → 400
 *
 * Per rule 26 (test-isolation paranoia): per-test memoryStorage,
 * fresh seeded site per beforeEach.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

let app: Hono
let storage: MemoryStorage

function setup(seed: Record<string, string> = {}) {
  storage = memoryStorage()
  storage.seed({
    'pages/home/page.json': JSON.stringify({ template: 'page-default', content: { title: 'Home' } }),
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

async function readJson(path: string): Promise<Record<string, unknown>> {
  const raw = await storage.readFile(path)
  return JSON.parse(raw) as Record<string, unknown>
}

async function postCreate(name: string, onConflict?: string) {
  const qs = onConflict ? `?onConflict=${onConflict}` : ''
  return app.request(`/api/pages${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, template: 'page-default' }),
  })
}

describe('POST /api/pages — archived-name-conflict (no onConflict flag)', () => {
  beforeEach(() => setup())

  it('returns 409 ARCHIVED_NAME_CONFLICT when target is archived', async () => {
    // Archive `home` first.
    await app.request('/api/pages/home/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'about' }),
    })

    // Try to create at the same name.
    const res = await postCreate('home')
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      code: string
      archive: { kind: string; name: string; aliasOf?: string; archivedAt?: string }
    }
    expect(body.code).toBe('ARCHIVED_NAME_CONFLICT')
    expect(body.archive.kind).toBe('page')
    expect(body.archive.name).toBe('home')
    expect(body.archive.aliasOf).toBe('about')
    expect(typeof body.archive.archivedAt).toBe('string')
  })

  it('returns the existing 409 message for live conflicts (not archived)', async () => {
    const res = await postCreate('home')
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error?: string; code?: string }
    expect(body.code).toBeUndefined()
    expect(body.error).toContain('already exists')
  })
})

describe('POST /api/pages?onConflict=restore', () => {
  beforeEach(() => setup())

  it('unarchives the existing archive and returns the resolution', async () => {
    await app.request('/api/pages/home/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'about' }),
    })
    expect((await readJson('pages/home/page.json')).archived).toBe(true)

    const res = await postCreate('home', 'restore')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; name: string; resolution: string }
    expect(body.ok).toBe(true)
    expect(body.resolution).toBe('restored')

    const manifest = await readJson('pages/home/page.json')
    expect(manifest.archived).toBeUndefined()
    expect(manifest.aliasOf).toBeUndefined()
    // Archive's content survives restore (Q6 D1 lock — no overwrite).
    expect(manifest.content).toEqual({ title: 'Home' })
  })

  it('tears down the archive-aliases sidecar', async () => {
    await app.request('/api/pages/home/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'about' }),
    })
    expect(await storage.exists('.gazetta/alias-targets/about/pages.home')).toBe(true)

    await postCreate('home', 'restore')
    expect(await storage.exists('.gazetta/alias-targets/about/pages.home')).toBe(false)
  })

  it('resets the review sidecar, leaving the restored item in draft (#1344)', async () => {
    await app.request('/api/pages/home/archive', { method: 'POST' })
    // Seed the sidecar AFTER archiving so this isolates the
    // conflict-restore path: the archive route itself also resets
    // review state (#1344), and seeding first would let that path
    // consume it.
    storage.seed({
      '.gazetta/review/page/home/state.json': JSON.stringify({
        state: 'pending-review',
        submitter: 'alice@example.com',
        requiredApprovers: 1,
        submittedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    })

    const res = await postCreate('home', 'restore')
    expect(res.status).toBe(200)

    expect(await storage.exists('.gazetta/review/page/home/state.json')).toBe(false)
  })
})

describe('Manual Redirect restore refusal (#1343)', () => {
  // A redirect manifest is only archive fields + aliasOf; restoring it
  // would write `{}` and lose the redirect. Predicate: archived === true
  // && aliasOf set && no template (an archived content item that happens
  // to alias has a template and restores normally — covered above).
  const redirectManifest = JSON.stringify({
    archived: true,
    archivedAt: '2026-10-20T10:00:00.000Z',
    archivedBy: 'tester',
    aliasOf: 'home',
  })

  it('POST /api/pages?onConflict=restore on a redirect archive answers 409 + writes nothing', async () => {
    setup({ 'pages/old-landing/page.json': redirectManifest })
    const res = await postCreate('old-landing', 'restore')
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('This is a redirect: delete it or change where it points')
    expect(await storage.readFile('pages/old-landing/page.json')).toBe(redirectManifest)
  })

  it('POST /api/fragments?onConflict=restore on a redirect archive answers 409 + writes nothing', async () => {
    setup({ 'fragments/old-promo/fragment.json': redirectManifest })
    const res = await app.request('/api/fragments?onConflict=restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'old-promo', template: 'card' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('This is a redirect: delete it or change where it points')
    expect(await storage.readFile('fragments/old-promo/fragment.json')).toBe(redirectManifest)
  })

  it('ARCHIVED_CONFLICT body marks a redirect archive with `redirect: true`', async () => {
    setup({ 'pages/old-landing/page.json': redirectManifest })
    const res = await postCreate('old-landing')
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      code: string
      archive: { aliasOf?: string; redirect?: boolean }
    }
    expect(body.code).toBe('ARCHIVED_NAME_CONFLICT')
    expect(body.archive.aliasOf).toBe('home')
    expect(body.archive.redirect).toBe(true)
  })

  it('ARCHIVED_CONFLICT body for archived content does not mark `redirect`', async () => {
    setup()
    await app.request('/api/pages/home/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'about' }),
    })
    const res = await postCreate('home')
    expect(res.status).toBe(409)
    const body = (await res.json()) as { archive: { redirect?: boolean } }
    expect(body.archive.redirect).toBeUndefined()
  })
})

describe('POST /api/pages?onConflict=replace', () => {
  beforeEach(() => setup())

  it('purges the archive and creates the new content', async () => {
    await app.request('/api/pages/home/archive', { method: 'POST' })
    const archived = await readJson('pages/home/page.json')
    expect(archived.archived).toBe(true)
    expect(archived.content).toEqual({ title: 'Home' }) // pre-existing archive content

    const res = await app.request('/api/pages?onConflict=replace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'home', template: 'new-template', content: { title: 'New Home' } }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; resolution: string }
    expect(body.resolution).toBe('replaced')

    const manifest = await readJson('pages/home/page.json')
    expect(manifest.archived).toBeUndefined()
    expect(manifest.template).toBe('new-template')
    expect(manifest.content).toEqual({ title: 'New Home' })
  })
})

describe('POST /api/pages?onConflict=moveAside', () => {
  beforeEach(() => setup())

  it('renames the archive to <name>-archived-<date> and creates new content', async () => {
    await app.request('/api/pages/home/archive', { method: 'POST' })

    const res = await postCreate('home', 'moveAside')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; resolution: string }
    expect(body.resolution).toBe('moved-aside')

    // New content at original name.
    const liveManifest = await readJson('pages/home/page.json')
    expect(liveManifest.archived).toBeUndefined()
    expect(liveManifest.template).toBe('page-default')

    // Archive moved to a `home-archived-YYYYMMDD` directory.
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const asidePath = `pages/home-archived-${today}/page.json`
    expect(await storage.exists(asidePath)).toBe(true)
    const asideManifest = await readJson(asidePath)
    expect(asideManifest.archived).toBe(true)
  })
})

describe('POST /api/pages?onConflict=invalid', () => {
  beforeEach(() => setup())

  it('returns 400 for unknown onConflict mode', async () => {
    await app.request('/api/pages/home/archive', { method: 'POST' })
    const res = await postCreate('home', 'frobnicate')
    expect(res.status).toBe(400)
  })
})

describe('POST /api/fragments — archived-name-conflict parity', () => {
  beforeEach(() => {
    setup({
      'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout', content: {} }),
    })
  })

  it('returns ARCHIVED_NAME_CONFLICT for archived fragment names', async () => {
    await app.request('/api/fragments/header/archive', { method: 'POST' })
    const res = await app.request('/api/fragments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'header', template: 'header-layout' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; archive: { kind: string } }
    expect(body.code).toBe('ARCHIVED_NAME_CONFLICT')
    expect(body.archive.kind).toBe('fragment')
  })

  it('?onConflict=restore unarchives the fragment', async () => {
    await app.request('/api/fragments/header/archive', { method: 'POST' })
    const res = await app.request('/api/fragments?onConflict=restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'header', template: 'header-layout' }),
    })
    expect(res.status).toBe(200)
    const manifest = await readJson('fragments/header/fragment.json')
    expect(manifest.archived).toBeUndefined()
  })
})
