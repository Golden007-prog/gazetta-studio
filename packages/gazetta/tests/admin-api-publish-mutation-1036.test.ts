/**
 * Mutation-coverage tests for `src/admin-api/routes/publish.ts` (#1036).
 *
 * The GET /api/targets response-mapping block (publish.ts:255-296) runs on
 * every call, but prior tests only asserted the `name` field, leaving the
 * environment/type/editable ternaries, the altText defaults and the
 * capabilities mapping as surviving mutants. Each test below names the
 * mutants it was verified to kill with the mutation applied by hand.
 *
 * Scope per the issue's current-maintainer note: only code still in the
 * route on current main is covered here; post-publish steps moved to
 * `publish-target.ts` by #1430 belong to that file's own mutation scope.
 *
 * Per [team-preferences.md rule 31](.claude/rules/team-preferences.md):
 * API-first tier for the admin-api surface; mutation testing is the
 * discovery tool, route handlers are the test subject.
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

describe('publish route — GET /api/targets response mapping (#1036)', () => {
  // The response-mapping block (publish.ts:255-296) runs on every
  // `/api/targets` call, but prior tests only asserted the `name`
  // field, leaving the environment/type/editable ternaries, the
  // altText defaults and the capabilities mapping as surviving
  // mutants. Each test below names the mutants it was verified to
  // kill with the mutation applied by hand.

  it('maps explicit environment, type and editable from each target config', async () => {
    // Kills the ConditionalExpression -> `false` mutant on each of the
    // three `cfg ? ... : <default>` ternaries: with the mutation the
    // configured values are ignored and every target reports the
    // route-level default, so `staging` would read
    // environment 'local' / editable true and `local` would read
    // type 'static'.
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
    // Kills the BooleanLiteral `?? false` -> `?? true` mutant on
    // altText.auto: with no alt provider configured anywhere, the
    // resolved config is null and the route must surface auto:false so
    // the UI doesn't imply auto-fire for an unconfigured target. The
    // 'local'/'static' values asserted here come from the
    // getEnvironment/getType defaults (types.ts), not the route's
    // ternary fallbacks — `bare` has a config entry, so those
    // fallbacks never run in this test (the no-config-entry test
    // covers them).
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
    // A pre-initialized provider whose name is absent from
    // `targetConfigs` makes `getTargetConfig(name)` return undefined,
    // exercising every `cfg ? ... : <default>` fallback at once.
    // Kills the ConditionalExpression -> `true` mutants (which call
    // getEnvironment/getType/isEditable/inspectTarget on undefined and
    // throw, turning the route into a 500) and the BooleanLiteral
    // `editable: ... : true` -> `false` fallback mutation.
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
    // Kills:
    //   - ArrayDeclaration `has: [...inspection.has]` -> `[]` — the
    //     redirects-capable target would report no capabilities.
    //   - ConditionalExpression on the `cfg ? inspectTarget(cfg) :
    //     { empty }` fallback -> `false` — configured targets would
    //     report empty capability sets.
    //   - ObjectLiteral mutants on the gaps map — the gap entries must
    //     carry both the capability name and the human reason.
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
