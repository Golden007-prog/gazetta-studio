/**
 * Tests for the GET /api/targets route in `admin-api/routes/publish.ts`:
 * how each target's config entry (or the lack of one) maps onto the
 * response the admin UI renders target badges from.
 */
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import type { StorageProvider, TargetConfig } from '../src/types.js'

interface BuildOpts {
  /** Target configs; drives the per-target config lookup in the route. */
  targetConfigs?: Record<string, TargetConfig>
  /**
   * Pre-initialized providers (deprecated path). When supplied, `getTargets`
   * short-circuits on this map, so names here drive `/api/targets` while
   * `targetConfigs` drives the per-target config lookup.
   */
  preInitTargets?: Map<string, StorageProvider>
}

function buildApp(opts: BuildOpts = {}): { app: Hono; sourceStorage: MemoryStorage } {
  const sourceStorage = memoryStorage()

  const targetConfigs = opts.targetConfigs

  const source = createSourceContext({
    storage: sourceStorage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: { name: 'test-site', ...(targetConfigs ? { targets: targetConfigs } : {}) },
  })

  const app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    ...(targetConfigs ? { targetConfigs } : {}),
    ...(opts.preInitTargets ? { targets: opts.preInitTargets } : {}),
    disableCacheStatsLogger: true,
  })

  return { app, sourceStorage }
}

describe('GET /api/targets response mapping', () => {
  it('maps explicit environment, type and editable from each target config', async () => {
    // A target with a config entry is reported with that entry's own
    // environment, type and editable, never the route's defaults.
    const localStorage = memoryStorage()
    const stagingStorage = memoryStorage()
    const { app } = buildApp({
      targetConfigs: {
        local: { storage: localStorage, type: 'dynamic', environment: 'local', editable: true },
        staging: { storage: stagingStorage, type: 'static', environment: 'staging', editable: false },
      },
      preInitTargets: new Map<string, StorageProvider>([
        ['local', localStorage],
        ['staging', stagingStorage],
      ]),
    })

    const res = await app.request('/api/targets')

    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ name: string; environment: string; type: string; editable: boolean }>
    const byName = Object.fromEntries(body.map(t => [t.name, t]))
    expect(Object.keys(byName).sort()).toEqual(['local', 'staging'])
    expect(byName.local).toMatchObject({ environment: 'local', type: 'dynamic', editable: true })
    expect(byName.staging).toMatchObject({ environment: 'staging', type: 'static', editable: false })
  })

  it('applies the documented defaults when a config omits environment, type and alt-text', async () => {
    // A config that omits environment and type is reported with the
    // documented defaults ('local', 'static'). With no alt-text
    // provider configured at any layer the route reports
    // altText { available: false, auto: false }, so the UI never
    // implies auto-fire for an unconfigured target.
    const bareStorage = memoryStorage()
    const { app } = buildApp({
      targetConfigs: { bare: { storage: bareStorage, editable: true } },
      preInitTargets: new Map<string, StorageProvider>([['bare', bareStorage]]),
    })

    const res = await app.request('/api/targets')

    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{
      name: string
      environment: string
      type: string
      altText: { available: boolean; auto: boolean }
    }>
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({
      name: 'bare',
      environment: 'local',
      type: 'static',
      altText: { available: false, auto: false },
    })
  })

  it('falls back to route-level defaults for a target with no config entry', async () => {
    // A target with no config entry is reported as local, static and
    // editable, with no capabilities.
    const knownStorage = memoryStorage()
    const ghostStorage = memoryStorage()
    const { app } = buildApp({
      targetConfigs: {
        known: { storage: knownStorage, type: 'static', environment: 'local', editable: true },
      },
      preInitTargets: new Map<string, StorageProvider>([
        ['known', knownStorage],
        ['ghost', ghostStorage],
      ]),
    })

    const res = await app.request('/api/targets')

    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{
      name: string
      environment: string
      type: string
      editable: boolean
      capabilities: { has: string[]; gaps: Array<{ capability: string; reason: string }> }
    }>
    const ghost = body.find(t => t.name === 'ghost')
    expect(ghost).toMatchObject({
      environment: 'local',
      type: 'static',
      editable: true,
      capabilities: { has: [], gaps: [] },
    })
  })

  it('reports runtime capability has/gaps per target from inspectTarget', async () => {
    // Each target reports the runtime capabilities derived from its
    // config: `has` lists what the target can do, `gaps` lists what it
    // cannot, each with the human-readable reason the admin modal
    // renders.
    const cdnStorage = memoryStorage()
    const plainStorage = memoryStorage()
    const { app } = buildApp({
      targetConfigs: {
        cdn: { storage: cdnStorage, type: 'static', editable: true, redirects: { format: 'cloudflare' } },
        plain: { storage: plainStorage, type: 'static' },
      },
      preInitTargets: new Map<string, StorageProvider>([
        ['cdn', cdnStorage],
        ['plain', plainStorage],
      ]),
    })

    const res = await app.request('/api/targets')

    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{
      name: string
      capabilities: { has: string[]; gaps: Array<{ capability: string; reason: string }> }
    }>
    const byName = Object.fromEntries(body.map(t => [t.name, t]))
    expect(byName.cdn.capabilities.has).toContain('redirects')
    expect(byName.cdn.capabilities.has).not.toContain('gone-status')
    expect(byName.cdn.capabilities.gaps).toEqual([
      expect.objectContaining({ capability: 'gone-status', reason: expect.any(String) }),
    ])
    expect(byName.plain.capabilities.has).toEqual([])
    expect(byName.plain.capabilities.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: 'redirects', reason: expect.any(String) }),
        expect.objectContaining({ capability: 'gone-status', reason: expect.any(String) }),
      ]),
    )
  })
})
