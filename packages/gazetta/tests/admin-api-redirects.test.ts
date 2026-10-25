/**
 * Integration tests for Cut 3 of redirect-ui — POST /api/page-redirects
 * and POST /api/fragment-redirects.
 *
 * Per `design-redirect-ui.md` Q2 (endpoint shape), Q4 (live-name
 * collision + normalize + edge-case rejections), Q7 (audit event),
 * Q8 (capability gate `edit:pages` / `edit:fragments`).
 *
 * Test-tier: API-first per `testing-plan.md`'s shape-per-sub-system
 * row for admin-API. Routes exercised end-to-end via `app.request()`
 * against `createAdminApp`; happy path + every error / branch in the
 * acceptance bullets gets its own test.
 *
 * Per rule 26 (test-isolation paranoia): each test gets a fresh
 * `memoryStorage()` + a fresh `createAdminApp`. No module-level state.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { createHistoryProvider } from '../src/history-provider.js'
import { createHistoryAuditProvider, type AuditEvent } from '../src/audit/index.js'
import type { SiteManifest } from '../src/types.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { memoryCache } from '../src/cache/factories.js'
import type { AdminCache } from '../src/cache/types.js'

let app: Hono
let storage: MemoryStorage
let source: ReturnType<typeof createSourceContext>
let cache: AdminCache

interface SetupOpts {
  seed?: Record<string, string>
  /**
   * Optional auth config to inject under `manifest.admin.auth`.
   * Omitting falls back to `none` mode (admin with `*` capability) —
   * useful for happy-path + non-capability error tests. Supplying a
   * forwarded-user config with a viewer roleMapping is how the 403
   * tests exercise the capability gate.
   */
  auth?: SiteManifest['admin'] extends infer A ? (A extends { auth: infer V } ? V : never) : never
}

function setup(opts: SetupOpts = {}) {
  storage = memoryStorage()
  storage.seed({
    // Live pages used as alias targets + live-name conflicts.
    'pages/home/page.json': JSON.stringify({ template: 'page-default', content: {} }),
    'pages/about/page.json': JSON.stringify({ template: 'page-default', content: {} }),
    'pages/products/featured/page.json': JSON.stringify({ template: 'page-default', content: {} }),
    'pages/products/featured/page.fr.json': JSON.stringify({
      template: 'page-default',
      content: { title: 'En vedette' },
    }),
    // Existing live fragment + alias target for fragment redirects.
    'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout', content: {} }),
    'fragments/footer/fragment.json': JSON.stringify({ template: 'footer-layout', content: {} }),
    ...(opts.seed ?? {}),
  })

  const targetConfigs = {
    local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true },
  }
  // Wire history so the "exactly ONE history revision per success"
  // assertion can read from `.gazetta/history/index.json`.
  const history = createHistoryProvider({ storage })
  const manifest: SiteManifest = {
    name: 'test-site',
    targets: targetConfigs,
    locales: { default: 'en', supported: ['en', 'fr'] },
    ...(opts.auth ? { admin: { auth: opts.auth } } : {}),
  }
  source = createSourceContext({
    storage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest,
    history,
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

async function readAuditEvents(): Promise<AuditEvent[]> {
  const reader = createHistoryAuditProvider({ storage, instance: 'reader' })
  return reader.query!({})
}

async function readHistoryRevisions(): Promise<unknown[]> {
  if (!(await storage.exists('.gazetta/history/index.json'))) return []
  const raw = await storage.readFile('.gazetta/history/index.json')
  const index = JSON.parse(raw) as { revisions?: unknown[] }
  return index.revisions ?? []
}

// Headers a forwarded-user-mode request needs to be admitted.
const FU_HEADERS = {
  'Content-Type': 'application/json',
  'X-Forwarded-User': 'alice@example.com',
  'X-Forwarded-Email': 'alice@example.com',
  'X-Forwarded-Groups': 'somegroup',
}

describe('POST /api/page-redirects — happy paths', () => {
  beforeEach(() => setup())

  it('creates a page redirect with archive fields + 201 + correct response shape', async () => {
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'products/featured' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    // toEqual pins the page branch of the line-212 / line-213 ternaries
    // (`binding.kind === 'page' ? deriveRoute(...) : `/${...}``) — for
    // the fragment branch, see the fragment happy-path test below.
    expect(body).toEqual({
      ok: true,
      from: 'old-products',
      to: 'products/featured',
      kind: 'page',
      route: '/old-products',
      targetRoute: '/products/featured',
    })

    // Manifest written at the normalized path with archive fields, no template.
    const manifest = await readJson('pages/old-products/page.json')
    expect(manifest.archived).toBe(true)
    expect(manifest.aliasOf).toBe('products/featured')
    expect(typeof manifest.archivedAt).toBe('string')
    expect(typeof manifest.archivedBy).toBe('string')
    expect(manifest.template).toBeUndefined()
  })

  it('creates a fragment redirect at fragments/{from}/fragment.json', async () => {
    const res = await app.request('/api/fragment-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-header', to: 'header' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.kind).toBe('fragment')
    expect(body.from).toBe('old-header')
    expect(body.to).toBe('header')
    // Pin the fragment branch of the line-212 / line-213 ternaries
    // (`binding.kind === 'page' ? deriveRoute(...) : `/${...}``).
    // For simple non-'home' names, `deriveRoute(name)` and `` `/${name}` ``
    // produce the same result, so this test primarily documents the
    // fragment response shape — but it also fully pins the
    // ConditionalExpression contract by keeping `route` / `targetRoute`
    // asserted on both branches (page happy path above, fragment here).
    expect(body.route).toBe('/old-header')
    expect(body.targetRoute).toBe('/header')

    const manifest = await readJson('fragments/old-header/fragment.json')
    expect(manifest.archived).toBe(true)
    expect(manifest.aliasOf).toBe('header')
    expect(manifest.template).toBeUndefined()
  })
})

describe('POST /api/fragment-redirects — collision handling (symmetric with pages)', () => {
  beforeEach(() => setup())

  it('rejects with 409 LIVE_NAME_CONFLICT when from is a live fragment', async () => {
    // `header` is a live fragment in the seed.
    const res = await app.request('/api/fragment-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'header', to: 'footer' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('LIVE_NAME_CONFLICT')
    // Pin the exact string with lowercase `fragment`. Kills the
    // MethodExpression mutant on line 167 (`binding.label.toLowerCase()`
    // → `binding.label.toUpperCase()`) for the FRAGMENT binding
    // specifically — the page-side test above pins the `page` casing,
    // this test pins the `fragment` casing, so a mutant that broke
    // either binding's casing would surface.
    expect(body.error).toContain('The fragment "header" already exists as live content')
    expect(body.error).toContain('first archive or rename "header"')
  })

  it('rejects with 409 ALIAS_TARGET_NOT_FOUND when to does not resolve to a fragment', async () => {
    const res = await app.request('/api/fragment-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-header', to: 'nonexistent-fragment' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('ALIAS_TARGET_NOT_FOUND')
    // Pin BOTH lowercase `fragment` occurrences. Kills the TWIN
    // MethodExpression mutants on line 192 for the fragment binding,
    // completing the symmetric coverage against the page-side test.
    expect(body.error).toContain('The fragment "nonexistent-fragment" does not exist as live content')
    expect(body.error).toContain('The alias target must be a live fragment.')
  })
})

describe('POST /api/page-redirects — from-route normalization (Q4 lock)', () => {
  beforeEach(() => setup())

  it('strips leading slash — /old-products and old-products produce same manifest path', async () => {
    const r1 = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '/old-products', to: 'products/featured' }),
    })
    expect(r1.status).toBe(201)
    const b1 = (await r1.json()) as Record<string, unknown>
    expect(b1.from).toBe('old-products')

    // Manifest path is the normalized name.
    expect(await storage.exists('pages/old-products/page.json')).toBe(true)
  })
})

describe('POST /api/page-redirects — edge-case rejections (absorbs old Cut 5)', () => {
  beforeEach(() => setup())

  it('rejects from="home" with 400 INVALID and a clear message', async () => {
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'home', to: 'about' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('INVALID')
    expect(typeof body.error).toBe('string')
    expect((body.error as string).toLowerCase()).toContain('home')
  })

  it('rejects from="blog/[slug]" with 400 INVALID — wildcards not supported', async () => {
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'blog/[slug]', to: 'about' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('INVALID')
    expect((body.error as string).toLowerCase()).toMatch(/wildcard|param|slug/)
  })

  it('rejects from="blog/:slug" with 400 INVALID — normalizes to wildcard then rejects', async () => {
    // Q4 normalize: `:param` → `[param]`. Per the acceptance bullet,
    // `from: 'blog/:slug'` normalizes to `blog/[slug]` which IS a
    // wildcard pattern → reject.
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'blog/:slug', to: 'about' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('INVALID')
  })
})

describe('POST /api/page-redirects — collision handling', () => {
  beforeEach(() => setup())

  it('rejects with 409 LIVE_NAME_CONFLICT when from is a live page', async () => {
    // `about` is a live page in the seed.
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'about', to: 'products/featured' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('LIVE_NAME_CONFLICT')
    // Pin the exact user-facing string. Kills MethodExpression mutant on
    // line 167 (`binding.label.toLowerCase()` → `binding.label.toUpperCase()`)
    // — with the mutant, the message becomes `The Page "about"...` (with
    // uppercase `Page`), breaking user-facing display.
    expect(body.error).toContain('The page "about" already exists as live content')
    expect(body.error).toContain('first archive or rename "about"')
  })

  it('rejects with 409 ALIAS_TARGET_NOT_FOUND when to does not resolve', async () => {
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'does-not-exist' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('ALIAS_TARGET_NOT_FOUND')
    // Pin BOTH lowercase `page` occurrences. Kills the TWIN MethodExpression
    // mutants on line 192 (`binding.label.toLowerCase()` — appears twice on
    // the same line, once in each message half). Both mutants survived on
    // the last mutation run because the prior assertion only checked that
    // the `to` name appeared in the error, not the casing of `page`.
    expect(body.error).toContain('The page "does-not-exist" does not exist as live content')
    expect(body.error).toContain('The alias target must be a live page.')
  })

  it('rejects with 409 ALIAS_TARGET_NOT_FOUND when to points at an ARCHIVED page', async () => {
    // The default beforeEach setup seeded no archived pages; re-run setup
    // with an archived alias target to exercise the second half of the
    // line-188 branch (`|| aliasTarget.archived === true`).
    //
    // Kills BooleanLiteral mutant on line 188 (`archived === true` →
    // `archived === false`). Under the mutant, an archived alias target
    // would slip past the check, and the redirect would be silently
    // written with `aliasOf` pointing at an archived page — returning 201
    // instead of 409. The happy-path tests already cover the
    // `!aliasTarget` half of the OR (aliasTarget=null); this test covers
    // the archived-target half.
    setup({
      seed: {
        'pages/archived-target/page.json': JSON.stringify({
          archived: true,
          archivedAt: '2026-01-01T00:00:00Z',
          archivedBy: 'setup@example.com',
          aliasOf: 'home',
        }),
      },
    })
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-promo', to: 'archived-target' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('ALIAS_TARGET_NOT_FOUND')
    // Manifest must NOT have been written — no side effect on 409.
    expect(await storage.exists('pages/old-promo/page.json')).toBe(false)
  })

  it('rejects with 409 ARCHIVED_NAME_CONFLICT when from is already archived', async () => {
    // Archive 'old-products' first by creating a redirect, then try to re-create.
    await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'home' }),
    })

    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'products/featured' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; archive: Record<string, unknown> }
    expect(body.code).toBe('ARCHIVED_NAME_CONFLICT')
    expect(body.archive.kind).toBe('page')
    expect(body.archive.name).toBe('old-products')
    expect(body.archive.aliasOf).toBe('home')
  })

  it('?onConflict=restore on a Manual Redirect answers 409 and writes nothing (#1343)', async () => {
    // Create the first redirect pointing at 'home'.
    await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'home' }),
    })
    const before = await storage.readFile('pages/old-products/page.json')
    // Retry with restore — the existing archive is itself a redirect:
    // unarchiving would strip its manifest to `{}` and lose it.
    const res = await app.request('/api/page-redirects?onConflict=restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'products/featured' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('This is a redirect: delete it or change where it points')
    expect(await storage.readFile('pages/old-products/page.json')).toBe(before)
  })

  it('?onConflict=restore still unarchives an archived content item', async () => {
    // An archived page (template + content, no alias) restores normally
    // when a redirect create names it.
    setup({
      seed: {
        'pages/old-products/page.json': JSON.stringify({
          template: 'page-default',
          content: { title: 'Old products' },
          archived: true,
          archivedAt: '2026-10-20T10:00:00.000Z',
          archivedBy: 'tester',
        }),
      },
    })
    const res = await app.request('/api/page-redirects?onConflict=restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'products/featured' }),
    })
    expect(res.status).toBe(201)
    const manifest = await readJson('pages/old-products/page.json')
    expect(manifest.archived).toBeUndefined()
    expect(manifest.template).toBe('page-default')
  })

  it('?onConflict=replace purges old archive + creates new redirect atomically', async () => {
    await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'home' }),
    })
    const res = await app.request('/api/page-redirects?onConflict=replace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'products/featured' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)

    // New redirect — points at products/featured, NOT home.
    const manifest = await readJson('pages/old-products/page.json')
    expect(manifest.archived).toBe(true)
    expect(manifest.aliasOf).toBe('products/featured')
  })

  it('?onConflict=moveAside renames old archive with date suffix + creates new', async () => {
    await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'home' }),
    })
    const res = await app.request('/api/page-redirects?onConflict=moveAside', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'products/featured' }),
    })
    expect(res.status).toBe(201)

    // New redirect lives at the original name.
    const manifest = await readJson('pages/old-products/page.json')
    expect(manifest.aliasOf).toBe('products/featured')
    // Old archive lives at `<name>-archived-<YYYYMMDD>`.
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    expect(await storage.exists(`pages/old-products-archived-${today}/page.json`)).toBe(true)
  })
})

describe('POST /api/page-redirects — audit + history (Q7 lock)', () => {
  beforeEach(() => setup())

  it('emits exactly ONE audit event with action create-redirect + correct metadata', async () => {
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'products/featured' }),
    })
    expect(res.status).toBe(201)

    const events = await readAuditEvents()
    const matched = events.filter(
      e => e.action === 'create-redirect' && e.scope.kind === 'page' && e.scope.name === 'old-products',
    )
    expect(matched).toHaveLength(1)
    const event = matched[0]
    expect(event.outcome).toBe('success')
    expect(event.metadata?.aliasOf).toBe('products/featured')
    // Default `none`-mode wiring → admin actor.
    expect(event.actor.role).toBe('admin')
  })

  it('emits exactly ONE audit event for fragment redirect with scope.kind: fragment', async () => {
    const res = await app.request('/api/fragment-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-header', to: 'header' }),
    })
    expect(res.status).toBe(201)

    const events = await readAuditEvents()
    const matched = events.filter(
      e => e.action === 'create-redirect' && e.scope.kind === 'fragment' && e.scope.name === 'old-header',
    )
    expect(matched).toHaveLength(1)
    expect(matched[0].metadata?.aliasOf).toBe('header')
  })

  it('records exactly ONE history revision per success', async () => {
    // Pre-warm history with a baseline write so the redirect creation
    // produces exactly ONE NEW revision (not 2 — `recordWrite` creates
    // a baseline revision on the very first write to a target, capturing
    // pre-write state; subsequent writes record one revision each).
    await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'warmup-redirect', to: 'home' }),
    })
    const before = (await readHistoryRevisions()).length

    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'products/featured' }),
    })
    expect(res.status).toBe(201)

    const after = (await readHistoryRevisions()).length
    expect(after - before).toBe(1)
  })
})

describe('POST /api/page-redirects — locale-variant alias target (Q4 verification)', () => {
  beforeEach(() => setup())

  it('accepts alias target that has locale variants (aliasOf is locale-agnostic per soft-delete Q1)', async () => {
    // `products/featured` has both default + French variants in the seed.
    // The redirect's `aliasOf` resolves to the name (not the URL or locale).
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-promo', to: 'products/featured' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.aliasOf === undefined || body.aliasOf === 'products/featured').toBe(true)
    expect(body.to).toBe('products/featured')

    const manifest = await readJson('pages/old-promo/page.json')
    expect(manifest.aliasOf).toBe('products/featured')
  })
})

describe('POST /api/page-redirects — capability gate (Q8 lock: edit:pages)', () => {
  it('returns 403 FORBIDDEN with code FORBIDDEN when principal lacks edit:pages', async () => {
    // Forwarded-user trust with a roleMapping that resolves to viewer
    // (built-in viewer has `read:*` only — no `edit:pages`).
    setup({
      auth: {
        trust: 'forwarded-user',
        allowAnyOrigin: true,
        roleMapping: {
          claim: 'groups',
          map: { admins: 'admin', editors: 'editor', viewers: 'viewer' },
          defaultRole: 'viewer',
        },
      },
    })

    // X-Forwarded-Groups: somegroup → no match → defaultRole 'viewer' →
    // viewer lacks edit:pages.
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: FU_HEADERS,
      body: JSON.stringify({ from: 'old-products', to: 'products/featured' }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('FORBIDDEN')
    expect(body.missing).toEqual(['edit:pages'])
    expect(body.role).toBe('viewer')
  })
})

describe('POST /api/fragment-redirects — capability gate (Q8 lock: edit:fragments)', () => {
  it('returns 403 FORBIDDEN with code FORBIDDEN when principal lacks edit:fragments', async () => {
    setup({
      auth: {
        trust: 'forwarded-user',
        allowAnyOrigin: true,
        roleMapping: {
          claim: 'groups',
          map: { admins: 'admin', editors: 'editor', viewers: 'viewer' },
          defaultRole: 'viewer',
        },
      },
    })

    const res = await app.request('/api/fragment-redirects', {
      method: 'POST',
      headers: FU_HEADERS,
      body: JSON.stringify({ from: 'old-header', to: 'header' }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('FORBIDDEN')
    expect(body.missing).toEqual(['edit:fragments'])
    expect(body.role).toBe('viewer')
  })
})

/**
 * Request-validation prologue tests — backfill coverage for the JSON-parse
 * + Zod-safeParse branches at the top of `handleCreateRedirect`
 * (`packages/gazetta/src/admin-api/routes/redirects.ts` lines 105-123).
 *
 * Mutation testing surfaced 8 surviving NoCoverage mutants in this prologue
 * (Stryker run 26744337081, captured in issue #484): empty catch block,
 * collapsed JSON-error body, empty INVALID code/error literals, and a
 * `issues.map(...)` arrow-function whose projection was untested. The
 * production code is already correct; this block pins the shape so the
 * mutants can no longer survive silently.
 *
 * Both routes share `handleCreateRedirect`, so each scenario runs through
 * both `/api/page-redirects` and `/api/fragment-redirects` — keeps a single
 * source of truth for the prologue's contract.
 */
describe('POST /api/page-redirects — request validation (kills NoCoverage mutants)', () => {
  beforeEach(() => setup())

  it('returns 400 INVALID with "Invalid JSON body" when the body is not valid JSON', async () => {
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{',
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    // Kills StringLiteral mutants on lines 111: code and error must be
    // the exact strings the production code emits.
    expect(body.code).toBe('INVALID')
    expect(body.error).toBe('Invalid JSON body')
  })

  it('returns 400 INVALID with "Invalid request body" + issues[] when both fields are missing', async () => {
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    // Kills StringLiteral mutants on lines 117-118 + ObjectLiteral on 116-120.
    expect(body.code).toBe('INVALID')
    expect(body.error).toBe('Invalid request body')
    // Kills the ArrowFunction mutant on line 119
    // (`issues.map(i => ({ path: i.path.join('.'), message: i.message }))`
    // → `() => undefined`). The projection MUST yield typed entries with
    // path + message strings, not nulls / undefineds.
    expect(Array.isArray(body.issues)).toBe(true)
    const issues = body.issues as Array<{ path: string; message: string }>
    expect(issues).toHaveLength(2)
    const paths = issues.map(i => i.path).sort()
    expect(paths).toEqual(['from', 'to'])
    for (const issue of issues) {
      expect(typeof issue.message).toBe('string')
      expect(issue.message.length).toBeGreaterThan(0)
    }
  })

  it('returns 400 INVALID with a single issue when only "from" is missing', async () => {
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'products/featured' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('INVALID')
    expect(body.error).toBe('Invalid request body')
    const issues = body.issues as Array<{ path: string; message: string }>
    expect(issues).toHaveLength(1)
    expect(issues[0].path).toBe('from')
    expect(typeof issues[0].message).toBe('string')
    expect(issues[0].message.length).toBeGreaterThan(0)
  })

  it('returns 400 INVALID with a single issue when only "to" is missing', async () => {
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('INVALID')
    expect(body.error).toBe('Invalid request body')
    const issues = body.issues as Array<{ path: string; message: string }>
    expect(issues).toHaveLength(1)
    expect(issues[0].path).toBe('to')
    expect(typeof issues[0].message).toBe('string')
    expect(issues[0].message.length).toBeGreaterThan(0)
  })

  it('returns 400 INVALID with issues[] when "from" is an empty string (min(1) violation)', async () => {
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '', to: 'products/featured' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('INVALID')
    expect(body.error).toBe('Invalid request body')
    const issues = body.issues as Array<{ path: string; message: string }>
    expect(issues).toHaveLength(1)
    expect(issues[0].path).toBe('from')
    expect(typeof issues[0].message).toBe('string')
    expect(issues[0].message.length).toBeGreaterThan(0)
  })

  it('returns 400 INVALID with issues[] when "from" is not a string (wrong type)', async () => {
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 42, to: 'products/featured' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('INVALID')
    expect(body.error).toBe('Invalid request body')
    const issues = body.issues as Array<{ path: string; message: string }>
    expect(issues).toHaveLength(1)
    expect(issues[0].path).toBe('from')
    expect(typeof issues[0].message).toBe('string')
    expect(issues[0].message.length).toBeGreaterThan(0)
  })
})

describe('POST /api/fragment-redirects — request validation (kills NoCoverage mutants)', () => {
  beforeEach(() => setup())

  it('returns 400 INVALID with "Invalid JSON body" when the body is not valid JSON', async () => {
    const res = await app.request('/api/fragment-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{',
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('INVALID')
    expect(body.error).toBe('Invalid JSON body')
  })

  it('returns 400 INVALID with "Invalid request body" + issues[] when both fields are missing', async () => {
    const res = await app.request('/api/fragment-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('INVALID')
    expect(body.error).toBe('Invalid request body')
    const issues = body.issues as Array<{ path: string; message: string }>
    expect(issues).toHaveLength(2)
    const paths = issues.map(i => i.path).sort()
    expect(paths).toEqual(['from', 'to'])
    for (const issue of issues) {
      expect(typeof issue.message).toBe('string')
      expect(issue.message.length).toBeGreaterThan(0)
    }
  })
})

/**
 * Kind-discriminant ternary coverage for the success response's `route`
 * and `targetRoute` fields — kills the surviving ConditionalExpression +
 * EqualityOperator mutants on line 213 of `redirects.ts` (per issue #687).
 *
 * The ternary is:
 *   targetRoute: binding.kind === 'page' ? deriveRoute(to) : `/${to}`
 *
 * For most `to` values the two branches produce identical output
 * (`deriveRoute(x) === `/${x}`` for any x that isn't `'home'` and doesn't
 * contain `[...]`), which is why prior mutation runs left these mutants
 * uncaught: existing symmetric happy-path tests used `to: 'products/featured'`
 * / `to: 'header'`, where both branches emit the same string.
 *
 * `to: 'home'` is the ONE `to` value that admits the distinction — a live
 * page name that's structurally invalid as a `from` (rejected earlier at
 * `from === 'home'`), so it's forced to appear ONLY as `to`:
 *   - deriveRoute('home')  === '/'
 *   - `/${'home'}`         === '/home'
 *
 * Two tests below assert both branches independently. Together they kill:
 *   - ConditionalExpression → true  (always deriveRoute — fragment test fails)
 *   - ConditionalExpression → false (always `/${to}` — page test fails)
 *   - EqualityOperator (kind !== 'page') (swaps branches — both tests fail)
 *
 * Line 212 (`route: ... deriveRoute(from) : `/${from}``) is NOT similarly
 * killable within v1's validation contract: `from === 'home'` is rejected
 * at line 135 (`if (from === 'home')`) and wildcard `from` (`[...]`) is
 * rejected at line 145 (`containsWildcard(from)`). Every valid `from`
 * satisfies `deriveRoute(from) === `/${from}``, making the two branches
 * behaviorally equivalent for all accepted inputs. Those mutants are
 * accepted as equivalent-mutants under the current validation rules.
 */
describe('POST /api/{page,fragment}-redirects — kind-discriminant ternary on targetRoute (kills line-213 mutants)', () => {
  beforeEach(() => setup())

  it('page redirect with to: "home" pins the deriveRoute branch → targetRoute === "/"', async () => {
    // 'home' is a live page in the seed; from is a novel name so the
    // happy-path proceeds to write the redirect.
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-landing', to: 'home' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    // Kills the page branch of line 213's ternary. deriveRoute('home') is
    // the sole `to`-input where the two branches diverge — asserting `/`
    // (not `/home`) proves the deriveRoute branch fired.
    expect(body.targetRoute).toBe('/')
    // The response also pins `from` handling for line 212 as much as v1
    // validation allows: deriveRoute('old-landing') and `/${'old-landing'}`
    // are equal, so this asserts the SHARED value (not the branch).
    expect(body.route).toBe('/old-landing')
    // Round out the shape to protect against a regression that would
    // drop other response fields.
    expect(body.ok).toBe(true)
    expect(body.kind).toBe('page')
    expect(body.from).toBe('old-landing')
    expect(body.to).toBe('home')
  })

  it('fragment redirect with to: "home" pins the `/${to}` branch → targetRoute === "/home"', async () => {
    // Fragments and pages have separate namespaces (per design-concepts.md),
    // so a fragment named 'home' is technically valid even though the page
    // route 'home' is reserved. Seed it inline for this test — the default
    // `setup()` seed has only 'header' / 'footer' fragments where the two
    // ternary branches would produce the same output.
    setup({
      seed: {
        'fragments/home/fragment.json': JSON.stringify({
          template: 'header-layout',
          content: {},
        }),
      },
    })
    const res = await app.request('/api/fragment-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-nav', to: 'home' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    // Kills the fragment branch of line 213's ternary. `/${'home'}` is the
    // sole `to`-input where the fragment branch diverges from the page
    // branch — asserting `/home` (not `/`) proves `/${to}` fired.
    expect(body.targetRoute).toBe('/home')
    // Same rationale for `route` as the page test above.
    expect(body.route).toBe('/old-nav')
    expect(body.ok).toBe(true)
    expect(body.kind).toBe('fragment')
    expect(body.from).toBe('old-nav')
    expect(body.to).toBe('home')
  })
})

/**
 * Archived-name-conflict short-circuit — pins the branch on line 180
 * (`if (existing && existing.archived === true)`) which must intercept
 * BEFORE the alias-target existence check on line 188.
 *
 * Under a mutation that flips this condition to false (or inverts the
 * equality to `archived !== true`), the branch is skipped and execution
 * falls through to the alias-target check — which would return
 * `ALIAS_TARGET_NOT_FOUND` (409) for a missing `to`, not
 * `ARCHIVED_NAME_CONFLICT`. Asserting the specific `code` value
 * distinguishes the two 409 outcomes and pins which branch fired.
 *
 * Existing archived-name-conflict tests use a valid alias target
 * (`to: 'products/featured'`), so under a branch-skipping mutant the
 * alias-target check would succeed and the code would proceed to WRITE
 * the redirect — surfacing as an unexpected 201 instead of the correct
 * 409. This scenario forces the assertion to specifically distinguish
 * `ARCHIVED_NAME_CONFLICT` from `ALIAS_TARGET_NOT_FOUND` (both 409),
 * catching the mutant more sharply.
 */
describe('POST /api/page-redirects — archived-name-conflict precedes alias-target check (kills line-180 mutants)', () => {
  beforeEach(() => setup())

  it('archived from + missing alias target → 409 ARCHIVED_NAME_CONFLICT (not ALIAS_TARGET_NOT_FOUND)', async () => {
    // Establish 'old-blog' as an archive via a first POST pointing at a
    // valid alias target. After this, 'old-blog' exists on disk as an
    // archived manifest with aliasOf: 'home'.
    const seedRes = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-blog', to: 'home' }),
    })
    expect(seedRes.status).toBe(201)

    // Retry with the same archived `from` and a MISSING `to`. The
    // archived-conflict branch (line 180) MUST short-circuit here — the
    // alias-target check would otherwise fire on 'does-not-exist' and
    // return ALIAS_TARGET_NOT_FOUND. Pinning the exact code proves the
    // short-circuit.
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-blog', to: 'does-not-exist' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as Record<string, unknown>
    // The load-bearing assertion. Kills mutants that would skip the
    // archived branch and fall through to the alias-target check:
    //   - ConditionalExpression → false: branch skipped → ALIAS_TARGET_NOT_FOUND
    //   - EqualityOperator (archived !== true): archived items skip too
    //   - BooleanLiteral (archived === true → archived === false): same
    // All three would produce ALIAS_TARGET_NOT_FOUND for the missing 'to'.
    expect(body.code).toBe('ARCHIVED_NAME_CONFLICT')
    // Belt-and-suspenders: the archive detail block must reflect the
    // original archive's aliasOf (not the retry attempt's non-existent to).
    const archive = body.archive as Record<string, unknown>
    expect(archive.kind).toBe('page')
    expect(archive.name).toBe('old-blog')
    expect(archive.aliasOf).toBe('home')
    // No side effect: the manifest still points at 'home' (the original
    // archive target), not the retry's non-existent 'does-not-exist'.
    const manifest = await readJson('pages/old-blog/page.json')
    expect(manifest.aliasOf).toBe('home')
  })
})

/**
 * Mutation-coverage backfill from Stryker run 34020034858 (issue #773).
 *
 * The tests below pin invariants that surviving mutants would otherwise
 * silently violate. Each test is anchored to a specific mutant and
 * asserts an observable behavior the production code emits today.
 *
 * ## Mutants targeted
 *
 * - **Line 229 regex** — `/:([a-zA-Z_][a-zA-Z0-9_]*)/g` normalizes
 *   `:param` → `[param]`. Two surviving mutations:
 *     1. Dropped `*` quantifier (`[a-zA-Z_][a-zA-Z0-9_]` matches only
 *        2-char params) — for `:slug` produces `[sl]ug` instead of `[slug]`
 *     2. Negated char class (`[^a-zA-Z0-9_]*`) — for `:slug` produces
 *        `[s]lug` instead of `[slug]`
 *   Prior tests asserted only `body.code === 'INVALID'`; both mutants
 *   still trigger the wildcard-rejection code path, so they survived.
 *   The wildcard-rejection error message interpolates the normalized
 *   `from` value verbatim — asserting `"blog/[slug]"` in the message
 *   pins the exact normalization and kills both mutants.
 *
 * - **Line 271 trailing newline** — `JSON.stringify(manifest, null, 2) + '\n'`.
 *   Stripping the `\n` still produces valid JSON that round-trips through
 *   `JSON.parse` — asserting `manifest.aliasOf === 'x'` won't fail without
 *   the newline. Assert the raw byte string ends with `\n` to pin the
 *   POSIX text-file convention.
 *
 * - **Line 212 / 213 kind-discriminant ternaries** in the restore /
 *   replace / moveAside paths (lines 350-351, 370-371, 391-392). Existing
 *   tests assert only `body.ok === true` on these paths — the response's
 *   `route` and `targetRoute` fields aren't pinned. The ternary
 *   `binding.kind === 'page' ? deriveRoute(to) : `/${to}`` diverges only
 *   when `to === 'home'` (deriveRoute('home') = '/'; `/${to}` = '/home').
 *   Each path needs a page test AND a fragment test with `to: 'home'` to
 *   kill all three ternary mutants (→ true, → false, `===` → `!==`) on
 *   that specific line.
 */
describe('POST /api/page-redirects — mutation-coverage backfill (issue #773)', () => {
  beforeEach(() => setup())

  it('trailing newline on serialized manifest — kills line-271 StringLiteral mutant', async () => {
    // The production code emits: `JSON.stringify(manifest, null, 2) + '\n'`.
    // Stripping the '\n' still produces syntactically valid JSON that
    // round-trips through JSON.parse, so field-level assertions (like
    // manifest.aliasOf === 'x') won't fail. The invariant is byte-level:
    // manifests end with a newline. Common POSIX convention; pinning it
    // prevents accidental drift.
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-marketing', to: 'products/featured' }),
    })
    expect(res.status).toBe(201)

    const raw = await storage.readFile('pages/old-marketing/page.json')
    // Load-bearing assertion for the mutant.
    expect(raw.endsWith('\n')).toBe(true)
    // Belt-and-suspenders: exactly one trailing newline (not zero, not two).
    expect(raw.endsWith('\n\n')).toBe(false)
  })

  it('wildcard rejection message contains the exact normalized from — kills line-229 regex mutants', async () => {
    // Input `blog/:slug` → normalize → `blog/[slug]` → wildcard reject.
    // The rejection message interpolates the normalized `from` verbatim:
    //   `Wildcard from-routes (e.g. "${from}") are not supported in v1. ...`
    //
    // Mutation-per-branch trace:
    //   - Original regex → `blog/[slug]` in message → assertion PASSES
    //   - Mutant 1 (dropped `*`, matches 2 chars): captures `sl`, replaces
    //     `:sl` with `[sl]` → `blog/[sl]ug` in message → assertion FAILS
    //   - Mutant 2 (negated char class): after `s` (in `[a-zA-Z_]`),
    //     `[^a-zA-Z0-9_]*` matches 0 chars because `lug` are alphanumeric,
    //     so captures `s` → `blog/[s]lug` in message → assertion FAILS
    //
    // Both regex mutants killed with a single load-bearing assertion.
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'blog/:slug', to: 'about' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('INVALID')
    // The exact normalized form of `blog/:slug` MUST appear in the
    // error message. Kills mutant 1 (`blog/[sl]ug`) + mutant 2
    // (`blog/[s]lug`) — neither contains the substring `[slug]`.
    expect(body.error).toContain('"blog/[slug]"')
  })

  it('multi-char param + underscore normalization — belt-and-suspenders for line-229 regex', async () => {
    // `:post_id` covers the underscore branch of `[a-zA-Z0-9_]*` — the
    // underscore is a common route-param character. Mutant 1 would
    // capture `po` (2 chars only) and mutant 2 would capture just `p`
    // (next char `o` is alphanumeric, terminates the `[^...]*` match).
    // Both would produce a message NOT containing `[post_id]`.
    //
    // The `blog/:slug` test above already kills both mutants; this test
    // adds a second load-bearing input covering a different character
    // class (underscore) so a future regex refactor that broke
    // underscore handling would surface immediately rather than silently.
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'blog/:post_id', to: 'about' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('INVALID')
    expect(body.error).toContain('"blog/[post_id]"')
  })

  it('restore path response body pins the ternary — kills line-350/351 page-branch mutants', async () => {
    // Seed an archived CONTENT page; the retry uses `to: 'home'` which
    // is the ONE `to` value that distinguishes `deriveRoute(to)` (returns
    // `/`) from `` `/${to}` `` (returns `/home`). Prior tests only
    // asserted `body.ok === true`, so ternary mutants on lines 350-351
    // survived. Seeds a content archive (not a redirect archive) because
    // restoring a Manual Redirect is refused per #1343.
    setup({
      seed: {
        'pages/old-restore-page/page.json': JSON.stringify({
          template: 'page-default',
          content: {},
          archived: true,
          archivedAt: '2026-10-20T10:00:00.000Z',
          archivedBy: 'tester',
        }),
      },
    })
    const res = await app.request('/api/page-redirects?onConflict=restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-restore-page', to: 'home' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    // Kills 2 of 3 mutants on the restore path's targetRoute ternary
    // (`false` branch would produce `/home`; `!==` flip would produce
    // `/home` for `kind === 'page'`). The `true` mutant is equivalent
    // for pages (both branches produce `/` for to='home' via the page
    // path, since deriveRoute IS the page branch).
    expect(body.targetRoute).toBe('/')
    // Route branch for from='old-restore-page' is equivalent under v1
    // guards (deriveRoute + `/${from}` collapse for non-'home' non-
    // wildcard names) — asserted to prevent regression on response shape.
    expect(body.route).toBe('/old-restore-page')
  })

  it('restore path fragment response pins the ternary — kills line-350/351 fragment-branch mutants', async () => {
    // Symmetric with the page test — fragment named 'home' is valid
    // (fragments and pages have separate namespaces per design-concepts.md).
    // Retry with `to: 'home'` on the fragment path forces the `/${to}`
    // branch, producing `/home` instead of `/`.
    setup({
      seed: {
        'fragments/home/fragment.json': JSON.stringify({
          template: 'header-layout',
          content: {},
        }),
        // Archived CONTENT fragment (not a redirect archive) — restoring
        // a Manual Redirect is refused per #1343.
        'fragments/old-restore-frag/fragment.json': JSON.stringify({
          template: 'header-layout',
          content: {},
          archived: true,
          archivedAt: '2026-10-20T10:00:00.000Z',
          archivedBy: 'tester',
        }),
      },
    })
    const res = await app.request('/api/fragment-redirects?onConflict=restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-restore-frag', to: 'home' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    // Kills 2 of 3 mutants on the restore path's targetRoute ternary
    // for fragments (`true` mutant would produce `/`; `!==` flip would
    // produce `/` for `kind === 'fragment'`). The `false` mutant is
    // equivalent for fragments (both branches produce `/home` via the
    // fragment path since `/${to}` IS the fragment branch).
    expect(body.targetRoute).toBe('/home')
    expect(body.route).toBe('/old-restore-frag')
  })

  it('replace path response body pins the ternary — kills line-370/371 page-branch mutants', async () => {
    await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-replace-page', to: 'about' }),
    })
    const res = await app.request('/api/page-redirects?onConflict=replace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-replace-page', to: 'home' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    // Kills 2 of 3 mutants on the replace path's targetRoute ternary.
    // Rationale identical to the restore-path page test above.
    expect(body.targetRoute).toBe('/')
    expect(body.route).toBe('/old-replace-page')
    // Belt-and-suspenders on manifest state: replace REWRITES aliasOf to
    // the new `to`. Without this, a mutant that skipped the write and
    // left the old aliasOf in place could slip past the response body.
    const manifest = await readJson('pages/old-replace-page/page.json')
    expect(manifest.aliasOf).toBe('home')
  })

  it('replace path fragment response pins the ternary — kills line-370/371 fragment-branch mutants', async () => {
    setup({
      seed: {
        'fragments/home/fragment.json': JSON.stringify({
          template: 'header-layout',
          content: {},
        }),
      },
    })
    await app.request('/api/fragment-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-replace-frag', to: 'header' }),
    })
    const res = await app.request('/api/fragment-redirects?onConflict=replace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-replace-frag', to: 'home' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.targetRoute).toBe('/home')
    expect(body.route).toBe('/old-replace-frag')
  })

  it('moveAside path response body pins the ternary — kills line-391/392 page-branch mutants', async () => {
    await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-aside-page', to: 'about' }),
    })
    const res = await app.request('/api/page-redirects?onConflict=moveAside', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-aside-page', to: 'home' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    // Kills 2 of 3 mutants on the moveAside path's targetRoute ternary.
    expect(body.targetRoute).toBe('/')
    expect(body.route).toBe('/old-aside-page')
    // Belt-and-suspenders: original archive should have been renamed
    // with today's date suffix. Without this, a mutant that skipped the
    // rename could still produce the correct response body.
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    expect(await storage.exists(`pages/old-aside-page-archived-${today}/page.json`)).toBe(true)
  })

  it('moveAside path fragment response pins the ternary — kills line-391/392 fragment-branch mutants', async () => {
    setup({
      seed: {
        'fragments/home/fragment.json': JSON.stringify({
          template: 'header-layout',
          content: {},
        }),
      },
    })
    await app.request('/api/fragment-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-aside-frag', to: 'header' }),
    })
    const res = await app.request('/api/fragment-redirects?onConflict=moveAside', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-aside-frag', to: 'home' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.targetRoute).toBe('/home')
    expect(body.route).toBe('/old-aside-frag')
  })
})

describe('POST redirects - mutation coverage (#1129)', () => {
  beforeEach(() =>
    setup({
      seed: {
        'fragments/home/fragment.json': JSON.stringify({ template: 'header-layout', content: {} }),
      },
    }),
  )

  it('page redirect to "home" answers targetRoute "/" (page branch of the kind ternary)', async () => {
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-root', to: 'home' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    // For 'home' targets the two branches of
    // `binding.kind === 'page' ? deriveRoute(to) : `/${to}`` differ
    // ('/' vs '/home'), so this pins the page branch against the
    // EqualityOperator / ConditionalExpression mutants on that ternary.
    expect(body.targetRoute).toBe('/')
    expect(body.route).toBe('/old-root')
  })

  it('fragment redirect to a fragment named "home" answers targetRoute "/home" (fragment branch)', async () => {
    const res = await app.request('/api/fragment-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-home-frag', to: 'home' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    // The page branch would give deriveRoute('home') === '/'; the
    // fragment branch keeps '/home'. Pins the fragment side of the
    // same ternary.
    expect(body.targetRoute).toBe('/home')
    expect(body.route).toBe('/old-home-frag')
  })

  it('records the redirect manifest path in the history revision items', async () => {
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'products/featured' }),
    })
    expect(res.status).toBe(201)
    const ids = (await readHistoryRevisions()) as string[]
    expect(ids.length).toBeGreaterThan(0)
    const revision = JSON.parse(await storage.readFile(`.gazetta/history/revisions/${ids[ids.length - 1]}.json`)) as {
      items?: string[]
    }
    // Emptying the recordWrite `items` array drops the manifest from
    // the revision while still writing it - this assertion fails then.
    expect(revision.items).toContain('pages/old-products/page.json')
  })

  /**
   * Cache-invalidation tests need the route to run against a cache the
   * test can observe. With targetConfigs set, createAdminApp resolves
   * sources through the registry and each resolved context gets its own
   * internal MemoryCache - so here the app is built WITHOUT
   * targetConfigs (static resolver) over a source with an explicitly
   * injected cache.
   */
  function setupWithCache() {
    storage = memoryStorage()
    storage.seed({
      'pages/home/page.json': JSON.stringify({ template: 'page-default', content: {} }),
      'pages/products/featured/page.json': JSON.stringify({ template: 'page-default', content: {} }),
      'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout', content: {} }),
    })
    const history = createHistoryProvider({ storage })
    cache = memoryCache()
    const manifest: SiteManifest = {
      name: 'test-site',
      targets: {
        local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true },
      },
      locales: { default: 'en', supported: ['en', 'fr'] },
    }
    source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest,
      history,
      cache,
    })
    app = createAdminApp({
      source,
      siteDir: '/test-project',
      templatesDir: '/test-project/templates',
      disableCacheStatsLogger: true,
    })
  }

  it('creating a page redirect invalidates pages: cache entries but not fragments:', async () => {
    setupWithCache()
    await source.cache.set('pages:summary', { warm: true })
    await source.cache.set('fragments:summary', { warm: true })
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'products/featured' }),
    })
    expect(res.status).toBe(201)
    // invalidatePrefix(`${binding.kind}s:`) must clear pages: only;
    // blanking the template string to '' would clear fragments: too.
    expect(await source.cache.get('pages:summary')).toBeNull()
    expect(await source.cache.get('fragments:summary')).not.toBeNull()
  })

  it('creating a fragment redirect invalidates fragments: AND pages: cache entries', async () => {
    setupWithCache()
    await source.cache.set('pages:summary', { warm: true })
    await source.cache.set('fragments:summary', { warm: true })
    const res = await app.request('/api/fragment-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-header', to: 'header' }),
    })
    expect(res.status).toBe(201)
    // Fragment edits also blow pages: (page summaries reflect fragment
    // refs) - dropping that second invalidatePrefix survives otherwise.
    expect(await source.cache.get('fragments:summary')).toBeNull()
    expect(await source.cache.get('pages:summary')).toBeNull()
  })
})
