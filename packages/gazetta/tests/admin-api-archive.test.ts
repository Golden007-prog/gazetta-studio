/**
 * Integration tests for Cut 5b/5c — archive / unarchive / purge routes.
 *
 * Per `team-preferences.md` rule 24, the per-edge sidecar pattern that
 * archive-aliases uses (Cut 5a) must hold at the 5K-page envelope; the
 * unit tests in `archive-aliases.test.ts` already validate the
 * per-edge writer end-to-end. This file pins the route-level surface:
 * authority gates, response shapes, sidecar invariants on each
 * lifecycle transition, and the purge-blocked 409 body shape.
 *
 * Per rule 26 (test-isolation paranoia): each test gets a fresh
 * `memoryStorage()` + a fresh `createAdminApp`. No module-level state.
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
    'pages/home/page.json': JSON.stringify({ template: 'page-default', content: {} }),
    'pages/landing/page.json': JSON.stringify({ template: 'page-default', content: {} }),
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

describe('POST /api/pages/:name/archive', () => {
  beforeEach(() => setup())

  it('archives a page with aliasOf and writes the per-edge sidecar', async () => {
    const res = await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; name: string; aliasOf?: string }
    expect(body.ok).toBe(true)
    expect(body.name).toBe('landing')
    expect(body.aliasOf).toBe('home')

    // Manifest carries the archive fields.
    const manifest = await readJson('pages/landing/page.json')
    expect(manifest.archived).toBe(true)
    expect(manifest.aliasOf).toBe('home')
    expect(typeof manifest.archivedAt).toBe('string')
    expect(typeof manifest.archivedBy).toBe('string')

    // Per-edge sidecar exists at .gazetta/alias-targets/home/pages.landing.
    expect(await storage.exists('.gazetta/alias-targets/home/pages.landing')).toBe(true)
  })

  it('returns 400 for an aliasOf with markup or whitespace, leaving the page live', async () => {
    for (const aliasOf of ['x--><b>bold</b><!--', 'x\n/*  /elsewhere  200!\n/y']) {
      const res = await app.request('/api/pages/landing/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aliasOf }),
      })
      expect(res.status).toBe(400)
    }
    expect((await readJson('pages/landing/page.json')).archived).toBeUndefined()
  })

  it('archives without aliasOf (pure soft-delete) — no sidecar written', async () => {
    const res = await app.request('/api/pages/landing/archive', { method: 'POST' })
    expect(res.status).toBe(200)
    const manifest = await readJson('pages/landing/page.json')
    expect(manifest.archived).toBe(true)
    expect(manifest.aliasOf).toBeUndefined()
    // No alias-targets entries exist for this archive (aliasOf absent).
    const dirEntries = await storage.readDir('.gazetta/alias-targets').catch(() => [])
    expect(dirEntries).toEqual([])
  })

  it('returns 404 when the page does not exist', async () => {
    const res = await app.request('/api/pages/missing/archive', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('is idempotent on a second archive — same archivedAt preserved', async () => {
    await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    const first = await readJson('pages/landing/page.json')
    const archivedAt = first.archivedAt as string

    // Second archive — same shape; archivedAt preserved (not bumped).
    const res2 = await app.request('/api/pages/landing/archive', { method: 'POST' })
    expect(res2.status).toBe(200)
    const second = await readJson('pages/landing/page.json')
    expect(second.archivedAt).toBe(archivedAt)
  })
})

describe('POST /api/pages/:name/unarchive — Manual Redirect refusal (#1343)', () => {
  // A Manual Redirect manifest carries only archive fields + aliasOf;
  // restoring it would write `{}` and lose the redirect.
  const redirectManifest = JSON.stringify({
    archived: true,
    archivedAt: '2026-10-20T10:00:00.000Z',
    archivedBy: 'tester',
    aliasOf: 'home',
  })

  it('answers 409 and leaves the manifest byte-identical (page)', async () => {
    setup({ 'pages/old-products/page.json': redirectManifest })
    const res = await app.request('/api/pages/old-products/unarchive', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('This is a redirect: delete it or change where it points')
    expect(await storage.readFile('pages/old-products/page.json')).toBe(redirectManifest)
  })

  it('answers 409 and leaves the manifest byte-identical (fragment)', async () => {
    setup({ 'fragments/old-promo/fragment.json': redirectManifest })
    const res = await app.request('/api/fragments/old-promo/unarchive', { method: 'POST' })
    expect(res.status).toBe(409)
    expect(await storage.readFile('fragments/old-promo/fragment.json')).toBe(redirectManifest)
  })

  it('answers 409 for a template-less archive whose alias was dropped (page)', async () => {
    // Dropping a redirect's alias leaves archived + no aliasOf + no
    // template; restoring would still write `{}` (#1343 review).
    const dropped = JSON.stringify({
      archived: true,
      archivedAt: '2026-10-20T10:00:00.000Z',
      archivedBy: 'tester',
    })
    setup({ 'pages/old-products/page.json': dropped })
    const res = await app.request('/api/pages/old-products/unarchive', { method: 'POST' })
    expect(res.status).toBe(409)
    expect(await storage.readFile('pages/old-products/page.json')).toBe(dropped)
  })

  it('drop-alias then restore: full flow refuses with 409 + manifest unchanged', async () => {
    // End-to-end per the #1440 review request: create a redirect, drop
    // its alias via PATCH alias (the purge-blocked dialog's "Drop
    // alias"), then attempt restore.
    setup()
    await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'home' }),
    })
    const patch = await app.request('/api/pages/old-products/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: null }),
    })
    expect(patch.status).toBe(200)
    const afterDrop = await storage.readFile('pages/old-products/page.json')
    expect(afterDrop).not.toContain('aliasOf')

    const res = await app.request('/api/pages/old-products/unarchive', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('This is a redirect: delete it or change where it points')
    expect(await storage.readFile('pages/old-products/page.json')).toBe(afterDrop)
  })

  it('still restores an archived content item that aliases elsewhere', async () => {
    // aliasOf + template = an archived page with an alias, not a Manual
    // Redirect — restore stays legal.
    setup({
      'pages/old-landing/page.json': JSON.stringify({
        template: 'page-default',
        content: { title: 'Old' },
        archived: true,
        archivedAt: '2026-10-20T10:00:00.000Z',
        archivedBy: 'tester',
        aliasOf: 'home',
      }),
    })
    const res = await app.request('/api/pages/old-landing/unarchive', { method: 'POST' })
    expect(res.status).toBe(200)
    const manifest = await readJson('pages/old-landing/page.json')
    expect(manifest.archived).toBeUndefined()
    expect(manifest.template).toBe('page-default')
  })
})

describe('POST /api/pages/:name/unarchive', () => {
  beforeEach(() => setup())

  it('strips archive fields and tears down the alias sidecar', async () => {
    // Archive first.
    await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    expect(await storage.exists('.gazetta/alias-targets/home/pages.landing')).toBe(true)

    // Unarchive.
    const res = await app.request('/api/pages/landing/unarchive', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; name: string }
    expect(body.ok).toBe(true)

    // Manifest no longer has archive fields.
    const manifest = await readJson('pages/landing/page.json')
    expect(manifest.archived).toBeUndefined()
    expect(manifest.archivedAt).toBeUndefined()
    expect(manifest.archivedBy).toBeUndefined()
    expect(manifest.aliasOf).toBeUndefined()

    // Sidecar removed.
    expect(await storage.exists('.gazetta/alias-targets/home/pages.landing')).toBe(false)
  })

  it('returns 404 when the page does not exist', async () => {
    const res = await app.request('/api/pages/missing/unarchive', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('is idempotent on a live page', async () => {
    const res = await app.request('/api/pages/home/unarchive', { method: 'POST' })
    expect(res.status).toBe(200)
  })
})

describe('DELETE /api/pages/:name/purge', () => {
  beforeEach(() => setup())

  it('purges an archive with no blockers — manifest gone, sidecars torn down', async () => {
    await app.request('/api/pages/landing/archive', { method: 'POST' })
    expect(await storage.exists('pages/landing/page.json')).toBe(true)

    const res = await app.request('/api/pages/landing/purge', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; name: string }
    expect(body.ok).toBe(true)

    expect(await storage.exists('pages/landing/page.json')).toBe(false)
  })

  it('refuses purge of a target name with aliases pointing at it (no force)', async () => {
    // Archive `landing` aliasing `home` — `home` now has an alias-pointer.
    await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    // Try to purge `home` — should refuse with the structured 409 body.
    const res = await app.request('/api/pages/home/purge', { method: 'DELETE' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      code: string
      aliases: Array<{ kind: string; name: string }>
      liveRefs: Array<{ kind: string; name: string }>
    }
    expect(body.code).toBe('DELETE_BLOCKED')
    expect(body.aliases).toHaveLength(1)
    expect(body.aliases[0]).toEqual({ kind: 'page', name: 'landing' })
    expect(body.liveRefs).toEqual([])
    // Manifest still present — refusal didn't accidentally purge.
    expect(await storage.exists('pages/home/page.json')).toBe(true)
  })

  it('?force=true bypasses both alias-pointers and live-refs', async () => {
    await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    // Force bypasses the blockers only; the target must still be archived.
    await app.request('/api/pages/home/archive', { method: 'POST' })
    const res = await app.request('/api/pages/home/purge?force=true', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await storage.exists('pages/home/page.json')).toBe(false)
    // The dangling alias survives — validator P3 surfaces it later.
    expect(await storage.exists('.gazetta/alias-targets/home/pages.landing')).toBe(true)
  })

  it('?force=true still refuses purge of a live page with NOT_ARCHIVED (#1341)', async () => {
    const res = await app.request('/api/pages/home/purge?force=true', { method: 'DELETE' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; error: string }
    expect(body.code).toBe('NOT_ARCHIVED')
    expect(await storage.exists('pages/home/page.json')).toBe(true)
  })

  it('returns 404 when the page does not exist', async () => {
    const res = await app.request('/api/pages/missing/purge', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('refuses purge of a live page with NOT_ARCHIVED (#1341)', async () => {
    const res = await app.request('/api/pages/home/purge', { method: 'DELETE' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; error: string }
    expect(body.code).toBe('NOT_ARCHIVED')
    // The admin client's deletePurge surfaces `error` on 409.
    expect(body.error).toContain('archive it first')
    // The refusal wrote nothing - the live page is untouched.
    expect(await storage.exists('pages/home/page.json')).toBe(true)
  })

  it('answers DELETE_BLOCKED for an archived item with alias-pointers', async () => {
    // Archive landing aliasing home, then archive home itself: purge
    // of the archived home is still blocked by landing's alias-pointer.
    await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    await app.request('/api/pages/home/archive', { method: 'POST' })
    const res = await app.request('/api/pages/home/purge', { method: 'DELETE' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('DELETE_BLOCKED')
    expect(await storage.exists('pages/home/page.json')).toBe(true)
  })
})

describe('PATCH /api/{kind}/:name/alias (Cut 12 — set / drop alias)', () => {
  beforeEach(() => setup())

  it('sets aliasOf on an archived page', async () => {
    await app.request('/api/pages/landing/archive', { method: 'POST' })
    const res = await app.request('/api/pages/landing/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; aliasOf?: string }
    expect(body.ok).toBe(true)
    expect(body.aliasOf).toBe('home')
    const manifest = await readJson('pages/landing/page.json')
    expect(manifest.aliasOf).toBe('home')
    // Sidecar materialized at the new target.
    expect(await storage.exists('.gazetta/alias-targets/home/pages.landing')).toBe(true)
  })

  it('drops aliasOf when set to null', async () => {
    await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    expect(await storage.exists('.gazetta/alias-targets/home/pages.landing')).toBe(true)

    const res = await app.request('/api/pages/landing/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: null }),
    })
    expect(res.status).toBe(200)
    const manifest = await readJson('pages/landing/page.json')
    expect(manifest.aliasOf).toBeUndefined()
    expect(manifest.archived).toBe(true) // still archived, alias dropped
    // Sidecar removed.
    expect(await storage.exists('.gazetta/alias-targets/home/pages.landing')).toBe(false)
  })

  it('moves the sidecar when alias target changes', async () => {
    await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    expect(await storage.exists('.gazetta/alias-targets/home/pages.landing')).toBe(true)

    await app.request('/api/pages/landing/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'about' }),
    })
    expect(await storage.exists('.gazetta/alias-targets/home/pages.landing')).toBe(false)
    expect(await storage.exists('.gazetta/alias-targets/about/pages.landing')).toBe(true)
  })

  it('returns 409 when called on a live item', async () => {
    const res = await app.request('/api/pages/home/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'landing' }),
    })
    expect(res.status).toBe(409)
  })

  it('returns 404 when the page does not exist', async () => {
    const res = await app.request('/api/pages/missing/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: null }),
    })
    expect(res.status).toBe(404)
  })

  it.each([
    ['markup', 'x--><b>bold</b><!--'],
    ['a newline', 'x\n/*  /elsewhere  200!\n/y'],
    ['a space', 'two words'],
  ])('returns 400 for an alias with %s, leaving the manifest unchanged', async (_what, aliasOf) => {
    await app.request('/api/pages/landing/archive', { method: 'POST' })
    const res = await app.request('/api/pages/landing/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf }),
    })
    expect(res.status).toBe(400)
    expect((await readJson('pages/landing/page.json')).aliasOf).toBeUndefined()
  })

  it('returns 400 for a fragment alias with markup', async () => {
    await app.request('/api/fragments/header/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const res = await app.request('/api/fragments/header/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'x--><b>bold</b><!--' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 on missing aliasOf field', async () => {
    await app.request('/api/pages/landing/archive', { method: 'POST' })
    const res = await app.request('/api/pages/landing/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('idempotent — same alias returns 200 without rewriting', async () => {
    await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    const res = await app.request('/api/pages/landing/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    expect(res.status).toBe(200)
  })

  it('works for fragments (parity with pages)', async () => {
    await app.request('/api/fragments/header/archive', { method: 'POST' })
    const res = await app.request('/api/fragments/header/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'top-bar' }),
    })
    expect(res.status).toBe(200)
    const manifest = await readJson('fragments/header/fragment.json')
    expect(manifest.aliasOf).toBe('top-bar')
  })
})

describe('Fragment archive lifecycle (parity with pages)', () => {
  beforeEach(() => setup())

  it('archives a fragment with aliasOf and writes the sidecar', async () => {
    const res = await app.request('/api/fragments/header/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'top-bar' }),
    })
    expect(res.status).toBe(200)
    expect(await storage.exists('.gazetta/alias-targets/top-bar/fragments.header')).toBe(true)
  })

  it('unarchive restores the fragment manifest', async () => {
    await app.request('/api/fragments/header/archive', { method: 'POST' })
    const res = await app.request('/api/fragments/header/unarchive', { method: 'POST' })
    expect(res.status).toBe(200)
    const manifest = await readJson('fragments/header/fragment.json')
    expect(manifest.archived).toBeUndefined()
  })

  it('purge tears down the fragment manifest', async () => {
    await app.request('/api/fragments/header/archive', { method: 'POST' })
    const res = await app.request('/api/fragments/header/purge', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await storage.exists('fragments/header/fragment.json')).toBe(false)
  })

  it('refuses purge of a live fragment with NOT_ARCHIVED (#1341)', async () => {
    const res = await app.request('/api/fragments/header/purge', { method: 'DELETE' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; error: string }
    expect(body.code).toBe('NOT_ARCHIVED')
    expect(await storage.exists('fragments/header/fragment.json')).toBe(true)
  })
})

describe('P8 — archive-blocked: archive without aliasOf when live refs exist', () => {
  beforeEach(() => {
    // Page references @header. archive of `header` without aliasOf
    // should be blocked because pages.home would silently break.
    setup({
      'pages/home/page.json': JSON.stringify({
        template: 'page-default',
        content: {},
        components: ['@header'],
      }),
      // Pre-existing fragment-deps sidecar — header is referenced.
      '.gazetta/fragment-deps/header/pages.home': '',
    })
  })

  it('refuses archive without aliasOf when live refs exist (409 ARCHIVE_HAS_LIVE_REFS)', async () => {
    const res = await app.request('/api/fragments/header/archive', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; liveRefs: Array<{ kind: string; name: string }> }
    expect(body.code).toBe('ARCHIVE_HAS_LIVE_REFS')
    expect(body.liveRefs).toEqual([{ kind: 'page', name: 'home' }])
    // Manifest unchanged — the refusal preserved live state.
    const manifest = await readJson('fragments/header/fragment.json')
    expect(manifest.archived).toBeUndefined()
  })

  it('allows archive with aliasOf even when live refs exist (alias is the resolution)', async () => {
    // Need a target for the alias to point at.
    storage.seed({
      'fragments/top-bar/fragment.json': JSON.stringify({ template: 'header-layout', content: {} }),
    })
    const res = await app.request('/api/fragments/header/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'top-bar' }),
    })
    expect(res.status).toBe(200)
  })

  it('?force=true bypasses the live-refs check', async () => {
    const res = await app.request('/api/fragments/header/archive?force=true', { method: 'POST' })
    expect(res.status).toBe(200)
    const manifest = await readJson('fragments/header/fragment.json')
    expect(manifest.archived).toBe(true)
  })
})

describe('Purge-blocked: live refs from page → fragment', () => {
  beforeEach(() => {
    // A page that references the fragment via @header. Seed both the
    // page manifest AND the fragment-deps sidecar directly — bypassing
    // the PUT handler's validation pipeline keeps this test focused on
    // the purge-blocked check (which reads the sidecar regardless of
    // how it got there).
    setup({
      'pages/home/page.json': JSON.stringify({
        template: 'page-default',
        content: {},
        components: ['@header'],
      }),
      // Pre-existing sidecar — `pages.home` references `@header`.
      '.gazetta/fragment-deps/header/pages.home': '',
    })
  })

  it('refuses fragment purge when a live page references it', async () => {
    expect(await storage.exists('.gazetta/fragment-deps/header/pages.home')).toBe(true)

    const res = await app.request('/api/fragments/header/purge', { method: 'DELETE' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      code: string
      aliases: Array<{ kind: string; name: string }>
      liveRefs: Array<{ kind: string; name: string }>
    }
    expect(body.code).toBe('DELETE_BLOCKED')
    expect(body.liveRefs).toEqual([{ kind: 'page', name: 'home' }])
  })
})

describe('archive-blocked without the derived fragment-deps index', () => {
  beforeEach(() => {
    // The archive live-refs check scans the loaded site; the
    // `.gazetta/fragment-deps/` index is derived state and is not
    // required for the refusal. Seed the page ref WITHOUT any sidecar.
    setup({
      'pages/home/page.json': JSON.stringify({
        template: 'page-default',
        content: {},
        components: ['@header'],
      }),
    })
  })

  it('refuses archive without aliasOf when a live page references the fragment (no sidecar)', async () => {
    expect(await storage.exists('.gazetta/fragment-deps/header/pages.home')).toBe(false)

    const res = await app.request('/api/fragments/header/archive', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; liveRefs: Array<{ kind: string; name: string }> }
    expect(body.code).toBe('ARCHIVE_HAS_LIVE_REFS')
    expect(body.liveRefs).toEqual([{ kind: 'page', name: 'home' }])
    // Manifest unchanged — the refusal preserved live state.
    const manifest = await readJson('fragments/header/fragment.json')
    expect(manifest.archived).toBeUndefined()
  })
})
