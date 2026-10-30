/**
 * Route-level contracts for `admin-api/routes/fragments.ts`: the list's
 * summary cache and error handling, the `target` query on reads, POST / PUT response bodies and error
 * mapping, the GET-by-name locale + archive + afterLoad branches, and
 * DELETE's archive-vs-purge dispatch.
 *
 * Two behaviours can't be told apart over HTTP and so have no test:
 * - Issue paths are joined with '.', but the create schema is flat, so
 *   every path has at most one segment.
 * - The If-Match unquoting regex is anchored, but the route only checks
 *   whether the unquoted value equals the current etag, and no header
 *   value unquotes to the etag with the anchors and not without them.
 *
 * Each test builds a fresh `memoryStorage()` + app (rule 26).
 */
import { describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import type { AdminCache, CacheStats, InvalidationEvent } from '../src/cache/types.js'
import { HookCancellation, HookRegistry } from '../src/hooks/index.js'
import { createValidatorRegistry } from '../src/validation/registry.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

const SITE_NAME = 'fragments-997'
const JSON_HEADERS = { 'Content-Type': 'application/json' }

interface Harness {
  app: Hono
  storage: MemoryStorage
  source: ReturnType<typeof createSourceContext>
}

interface SetupOptions {
  hooks?: HookRegistry
  staging?: Record<string, string>
  validators?: boolean
  cache?: AdminCache
  /** Build the source without a site manifest, so loading the site throws. */
  withoutManifest?: boolean
  /** No target registry: every request reads the source, as single-target setups do. */
  sourceOnly?: boolean
}

function setup(files: Record<string, string>, opts: SetupOptions = {}): Harness {
  const storage = memoryStorage()
  storage.seed(files)
  const staging = memoryStorage()
  if (opts.staging) staging.seed(opts.staging)
  const targetConfigs = {
    local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true },
    staging: { storage: staging, type: 'esi' as const, environment: 'staging' as const, editable: true },
  }
  const source = createSourceContext({
    storage,
    siteDir: '',
    projectSiteDir: '/test-project',
    ...(opts.withoutManifest ? { siteName: SITE_NAME } : { manifest: { name: SITE_NAME, targets: targetConfigs } }),
    ...(opts.cache ? { cache: opts.cache } : {}),
  })
  const app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    ...(opts.sourceOnly
      ? {}
      : {
          targets: new Map([
            ['local', storage],
            ['staging', staging],
          ]),
          targetConfigs,
        }),
    disableCacheStatsLogger: true,
    hooks: opts.hooks,
    ...(opts.validators ? {} : { validators: createValidatorRegistry([]) }),
  }) as unknown as Hono
  return { app, storage, source }
}

const frag = (m: Record<string, unknown>) => JSON.stringify(m)
const HEADER = { 'fragments/header/fragment.json': frag({ template: 'header-layout', content: { title: 'Hi' } }) }
const ALPHA_BETA = {
  'fragments/alpha/fragment.json': frag({ template: 'footer-layout', content: {} }),
  'fragments/beta/fragment.json': frag({ template: 'footer-layout', content: {} }),
}
const SOURCE_SUMMARY_KEY = 'fragments:summary:target:__source__'

function post(app: Hono, body: unknown, query = '') {
  return app.request(`/api/fragments${query}`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) })
}

function put(app: Hono, name: string, body: unknown, opts: { query?: string; headers?: Record<string, string> } = {}) {
  return app.request(`/api/fragments/${name}${opts.query ?? ''}`, {
    method: 'PUT',
    headers: { ...JSON_HEADERS, ...opts.headers },
    body: JSON.stringify(body),
  })
}

describe('GET /api/fragments — summary cache', () => {
  it('stores the list under the source key when no target is named', async () => {
    const { app, source } = setup(ALPHA_BETA, { sourceOnly: true })
    expect(await source.cache.get(SOURCE_SUMMARY_KEY)).toBeNull()

    const res = await app.request('/api/fragments')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ name: string }>
    expect(body.map(f => f.name).sort()).toEqual(['alpha', 'beta'])
    expect(await source.cache.get(SOURCE_SUMMARY_KEY)).toEqual(body)
  })

  it('serves a cached list as is, without reading storage', async () => {
    const { app, source } = setup(ALPHA_BETA, { sourceOnly: true })
    // A name that isn't in storage, so only the cache can supply it.
    await source.cache.set(SOURCE_SUMMARY_KEY, [{ name: 'only-in-cache', template: 'footer-layout' }])

    const res = await app.request('/api/fragments')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ name: 'only-in-cache', template: 'footer-layout' }])
  })
})

describe('GET /api/fragments — errors', () => {
  it('returns an empty list when the site can not be loaded', async () => {
    const { app } = setup(ALPHA_BETA, { withoutManifest: true, sourceOnly: true })
    const res = await app.request('/api/fragments')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('answers 500 for any other error instead of an empty list', async () => {
    const throwingCache: AdminCache = {
      async get<T>(_key: string): Promise<T | null> {
        throw new Error('cache-provider unavailable: connection reset')
      },
      async set<T>(_key: string, _value: T): Promise<void> {},
      async invalidate(_key: string): Promise<void> {},
      async invalidatePrefix(_prefix: string): Promise<number> {
        return 0
      },
      subscribe(_handler: (event: InvalidationEvent) => void): () => void {
        return () => {}
      },
      async stats(): Promise<CacheStats> {
        return { hits: 0, misses: 0, size: 0 }
      },
    }
    const { app } = setup(ALPHA_BETA, { cache: throwingCache, sourceOnly: true })
    const res = await app.request('/api/fragments')
    expect(res.status).toBe(500)
  })
})

describe('GET /api/fragments — target query', () => {
  it('lists the fragments of the target named in ?target=', async () => {
    const { app } = setup(HEADER, {
      staging: { 'fragments/staging-only/fragment.json': frag({ template: 'footer-layout' }) },
    })
    const res = await app.request('/api/fragments?target=staging')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ name: string }>
    expect(body.map(f => f.name)).toEqual(['staging-only'])
  })
})

describe('POST /api/fragments — response bodies', () => {
  it('400 on an invalid body names the failing field', async () => {
    const { app } = setup({})
    const res = await post(app, { name: 'x' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; issues: Array<{ path: string; message: string }> }
    expect(body.error).toBe('Invalid request body')
    expect(body.issues).toHaveLength(1)
    expect(body.issues[0]?.path).toBe('template')
    expect(typeof body.issues[0]?.message).toBe('string')
    expect(body.issues[0]?.message.length).toBeGreaterThan(0)
  })

  it('200 on create returns exactly { ok, name }', async () => {
    const { app } = setup({})
    const res = await post(app, { name: 'fresh', template: 'footer-layout' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, name: 'fresh' })
  })

  it('200 with ?onConflict=restore returns { ok, name, resolution }', async () => {
    const { app } = setup({
      'fragments/header/fragment.json': frag({ template: 'header-layout', archived: true }),
    })
    const res = await post(app, { name: 'header', template: 'header-layout' }, '?onConflict=restore')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, name: 'header', resolution: 'restored' })
  })

  it('409 on a live name names the fragment', async () => {
    const { app } = setup(HEADER)
    const res = await post(app, { name: 'header', template: 'header-layout' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Fragment "header" already exists' })
  })

  it('400 on an unknown onConflict mode names the mode', async () => {
    const { app } = setup({
      'fragments/header/fragment.json': frag({ template: 'header-layout', archived: true }),
    })
    const res = await post(app, { name: 'header', template: 'header-layout' }, '?onConflict=frobnicate')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid onConflict mode "frobnicate"' })
  })
})

describe('GET /api/fragments/:name — locale, target, archive fields', () => {
  const LOCALIZED = {
    ...HEADER,
    'fragments/header/fragment.fr.json': frag({ template: 'header-layout', content: { title: 'Salut' } }),
  }

  it('serves the locale variant, normalizing the code to lowercase', async () => {
    const { app } = setup(LOCALIZED)
    const res = await app.request('/api/fragments/header?locale=FR')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { content: { title: string }; locale: string; locales: string[] }
    expect(body.content.title).toBe('Salut')
    expect(body.locale).toBe('fr')
    expect(body.locales).toEqual(['fr'])
  })

  it('falls back to the default fragment when the locale has no variant', async () => {
    const { app } = setup(LOCALIZED)
    const res = await app.request('/api/fragments/header?locale=de')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { content: { title: string }; locale: string }
    expect(body.content.title).toBe('Hi')
    expect(body.locale).toBe('de')
  })

  it('omits locale from the body when none was requested', async () => {
    const { app } = setup(LOCALIZED)
    const body = (await (await app.request('/api/fragments/header')).json()) as Record<string, unknown>
    expect('locale' in body).toBe(false)
    expect(body.locales).toEqual(['fr'])
  })

  it('400 on an invalid locale code', async () => {
    const { app } = setup(HEADER)
    const res = await app.request('/api/fragments/header?locale=not_a_locale!')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid locale code: "not_a_locale!"' })
  })

  it('404 names the locale when neither the fragment nor its variant exists', async () => {
    const { app } = setup(HEADER)
    const res = await app.request('/api/fragments/missing?locale=fr')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Fragment "missing" locale "fr" not found' })
  })

  it('404 names the fragment when it does not exist', async () => {
    const { app } = setup(HEADER)
    const res = await app.request('/api/fragments/missing')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Fragment "missing" not found' })
  })

  it('reads from the target named in ?target=', async () => {
    const { app } = setup(HEADER, {
      staging: { 'fragments/header/fragment.json': frag({ template: 'header-layout', content: { title: 'Stg' } }) },
    })
    const body = (await (await app.request('/api/fragments/header?target=staging')).json()) as {
      content: { title: string }
    }
    expect(body.content.title).toBe('Stg')
  })

  it('surfaces every archive field of an archived fragment', async () => {
    const { app } = setup({
      ...HEADER,
      'fragments/old/fragment.json': frag({
        archived: true,
        archivedAt: '2026-01-01T00:00:00Z',
        archivedBy: 'alice@example.com',
        aliasOf: 'header',
      }),
    })
    const body = (await (await app.request('/api/fragments/old')).json()) as Record<string, unknown>
    expect(body.archived).toBe(true)
    expect(body.archivedAt).toBe('2026-01-01T00:00:00Z')
    expect(body.archivedBy).toBe('alice@example.com')
    expect(body.aliasOf).toBe('header')
  })

  it('a live fragment carries no archive fields', async () => {
    const { app } = setup(HEADER)
    const body = (await (await app.request('/api/fragments/header')).json()) as Record<string, unknown>
    for (const key of ['archived', 'archivedAt', 'archivedBy', 'aliasOf']) expect(key in body).toBe(false)
  })
})

describe('GET /api/fragments/:name — afterLoad hooks', () => {
  it('returns the hook-enriched body and passes request id, site name and locale to the hook', async () => {
    const seen: Array<{ requestId: string; site: string | undefined; locale: string | undefined }> = []
    const hooks = new HookRegistry()
    hooks.register(
      'afterLoad',
      async (scope, result, ctx) => {
        seen.push({ requestId: ctx.requestId, site: ctx.site.name, locale: scope.locale })
        return { ...(result as Record<string, unknown>), enriched: true }
      },
      { name: 'enrich' },
    )
    hooks.seal()
    const { app } = setup(
      { ...HEADER, 'fragments/header/fragment.fr.json': frag({ template: 'header-layout' }) },
      { hooks },
    )
    const res = await app.request('/api/fragments/header?locale=fr', { headers: { 'x-request-id': 'req-123' } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { enriched?: boolean }
    expect(body.enriched).toBe(true)
    expect(seen).toEqual([{ requestId: 'req-123', site: SITE_NAME, locale: 'fr' }])
  })
})

describe('PUT /api/fragments/:name — response bodies + error mapping', () => {
  it('200 returns { ok, etag } and the same etag in the ETag header', async () => {
    const { app } = setup(HEADER)
    const res = await put(app, 'header', { content: { title: 'New' } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; etag: string }
    expect(body.ok).toBe(true)
    expect(body.etag).toMatch(/\S/)
    expect(res.headers.get('ETag')).toBe(`"${body.etag}"`)
  })

  it('accepts a quoted If-Match equal to the current etag', async () => {
    const { app } = setup(HEADER)
    const etag = (await app.request('/api/fragments/header')).headers.get('ETag')!
    const res = await put(app, 'header', { content: { title: 'New' } }, { headers: { 'If-Match': etag } })
    expect(res.status).toBe(200)
  })

  it('409 STALE carries the current manifest and its etag in body and header', async () => {
    const { app } = setup(HEADER)
    const current = (await app.request('/api/fragments/header')).headers.get('ETag')!
    const res = await put(app, 'header', { content: { title: 'New' } }, { headers: { 'If-Match': '"stale"' } })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; current: { content: { title: string } }; currentEtag: string }
    expect(body.code).toBe('STALE')
    expect(body.current.content.title).toBe('Hi')
    expect(`"${body.currentEtag}"`).toBe(current)
    expect(res.headers.get('ETag')).toBe(current)
  })

  it('400 on an invalid locale', async () => {
    const { app } = setup(HEADER)
    const res = await put(app, 'header', { content: {} }, { query: '?locale=not_a_locale!' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('not_a_locale!')
  })

  it('404 on a missing fragment', async () => {
    const { app } = setup(HEADER)
    const res = await put(app, 'missing', { content: {} })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('missing')
  })

  it('409 VALIDATION_FAILED carries the issues', async () => {
    const { app } = setup(HEADER, { validators: true })
    const res = await put(app, 'header', { components: ['@does-not-exist'] })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; issues: Array<{ message: string }> }
    expect(body.code).toBe('VALIDATION_FAILED')
    expect(body.issues.length).toBeGreaterThan(0)
  })

  it('409 HOOK_CANCELLED names the hook and reason; the hook sees the request id', async () => {
    const seen: string[] = []
    const hooks = new HookRegistry()
    hooks.register(
      'beforeSave',
      async (_scope, _payload, ctx) => {
        seen.push(ctx.requestId)
        throw new HookCancellation({ hookName: 'deny', phase: 'beforeSave', message: 'nope' })
      },
      { name: 'deny' },
    )
    hooks.seal()
    const { app } = setup(HEADER, { hooks })
    const res = await put(app, 'header', { content: { title: 'New' } }, { headers: { 'x-request-id': 'req-9' } })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ code: 'HOOK_CANCELLED', hook: 'deny', reason: 'nope' })
    expect(seen).toEqual(['req-9'])
  })
})

describe('DELETE /api/fragments/:name — archive vs purge', () => {
  it('?permanent=true removes the manifest', async () => {
    const { app, storage } = setup(HEADER)
    const res = await app.request('/api/fragments/header?permanent=true', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await storage.exists('fragments/header/fragment.json')).toBe(false)
  })

  it('without ?permanent=true the fragment is archived, not removed', async () => {
    const { app, storage } = setup(HEADER)
    const res = await app.request('/api/fragments/header?permanent=yes', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const manifest = JSON.parse(await storage.readFile('fragments/header/fragment.json')) as { archived?: boolean }
    expect(manifest.archived).toBe(true)
  })
})
