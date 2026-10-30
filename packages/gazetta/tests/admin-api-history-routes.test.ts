/**
 * Route-level tests for `admin-api/routes/history.ts`:
 * `GET /api/history`, `POST /api/history/undo`, `POST /api/history/restore`.
 *
 * The routes are mounted directly (not through `createAdminApp`) so each
 * test controls the three constructor inputs the handlers branch on:
 * pre-initialised target storages, target configs, and the source's
 * `targetName` (which decides whether the source cache is invalidated).
 * The principal middleware runs in `none` mode (`*` capabilities); a stub
 * audit context collects recorded events.
 *
 * Not testable through HTTP: `resolveHistory`'s own missing-target guard.
 * Every route rejects an empty `target` query before calling it, so that
 * branch and its message are unreachable from a request. The
 * empty-configs short-circuit in `getTargets` gives the same answer as
 * the registry path it skips: with no configs the registry init rejects,
 * and its `.catch` also yields an empty map ("Unknown target").
 *
 * Per rule 26: every test builds fresh memory storages and a fresh app.
 */
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { historyRoutes } from '../src/admin-api/routes/history.js'
import { createSourceContext, staticSourceResolver } from '../src/admin-api/source-context.js'
import { principalMiddleware } from '../src/admin-api/middleware/principal.js'
import type { AuditEnv } from '../src/admin-api/middleware/audit.js'
import type { AuditContext, RecordEventInput } from '../src/audit/index.js'
import { createHistoryProvider } from '../src/history-provider.js'
import type { AdminCache } from '../src/cache/types.js'
import type { StorageProvider, TargetConfig } from '../src/types.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

const HOME = 'pages/home/page.json'
const v1 = JSON.stringify({ template: 'page-default', content: { title: 'one' } })
const v2 = JSON.stringify({ template: 'page-default', content: { title: 'two' } })
const v3 = JSON.stringify({ template: 'page-default', content: { title: 'three' } })

interface MountOptions {
  /** Passed as `preInitTargets`; omit to exercise lazy registry init. */
  preInit?: Map<string, StorageProvider>
  /** Passed as `targetConfigs`; `null` passes undefined. */
  configs?: Record<string, TargetConfig> | null
  /** The source context's target name (cache invalidation compares it). */
  sourceTargetName?: string
}

interface Mounted {
  app: Hono<AuditEnv>
  events: RecordEventInput[]
  invalidated: string[]
}

function mount(opts: MountOptions): Mounted {
  const events: RecordEventInput[] = []
  const invalidated: string[] = []
  const source = createSourceContext({ storage: memoryStorage(), siteDir: '', projectSiteDir: '/test-project' })
  const cache: AdminCache = {
    ...source.cache,
    invalidatePrefix: async (prefix: string) => {
      invalidated.push(prefix)
      return 0
    },
  }
  const resolve = staticSourceResolver({ ...source, cache, targetName: opts.sourceTargetName })
  const app = new Hono<AuditEnv>()
  app.use('/api/*', principalMiddleware())
  app.use('/api/*', async (c, next) => {
    const audit = {
      strict: false,
      record: async (e: RecordEventInput) => {
        events.push(e)
        return { succeeded: 1, failed: 0 }
      },
    } as unknown as AuditContext
    c.set('audit', audit)
    await next()
  })
  app.route('/', historyRoutes(resolve, opts.preInit, opts.configs === null ? undefined : opts.configs))
  return { app, events, invalidated }
}

function config(storage: StorageProvider, extra: Partial<TargetConfig> = {}): TargetConfig {
  return { storage, ...extra } as TargetConfig
}

/** Record three save revisions of `pages/home/page.json` on `storage`. */
async function seedRevisions(storage: MemoryStorage, retention?: number) {
  const history = createHistoryProvider({ storage, retention })
  const r1 = await history.recordRevision({ operation: 'save', items: new Map([[HOME, v1]]) })
  const r2 = await history.recordRevision({ operation: 'publish', items: new Map([[HOME, v2]]) })
  const r3 = await history.recordRevision({ operation: 'save', items: new Map([[HOME, v3]]) })
  storage.seed({ [HOME]: v3 })
  return { history, r1, r2, r3 }
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

describe('target resolution', () => {
  it('lists revisions when targets are only configured (lazy registry init)', async () => {
    const storage = memoryStorage()
    await seedRevisions(storage)
    const { app } = mount({ configs: { staging: config(storage) } })
    const res = await app.request('/api/history?target=staging')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect((body.revisions as unknown[]).length).toBe(3)
  })

  it('initialises the registry once for concurrent first requests', async () => {
    const storage = memoryStorage()
    await seedRevisions(storage)
    let inits = 0
    const counted = Object.assign(Object.create(storage) as StorageProvider, {
      init: async () => {
        inits++
      },
    })
    const { app } = mount({ configs: { staging: config(counted) } })
    const [a, b] = await Promise.all([
      app.request('/api/history?target=staging'),
      app.request('/api/history?target=staging'),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(inits).toBe(1)
    // A later request reuses the resolved registry without re-initialising.
    expect((await app.request('/api/history?target=staging')).status).toBe(200)
    expect(inits).toBe(1)
  })

  it('400 "Unknown target" when no target configs exist', async () => {
    const { app } = mount({ configs: null })
    const res = await app.request('/api/history?target=staging')
    expect(res.status).toBe(400)
    expect(await json(res)).toEqual({ error: 'Unknown target: staging' })
  })

  it('400 "Unknown target" when target configs are empty', async () => {
    const { app } = mount({ configs: {} })
    const res = await app.request('/api/history?target=staging')
    expect(res.status).toBe(400)
    expect(await json(res)).toEqual({ error: 'Unknown target: staging' })
  })

  it('400 "Unknown target" when storage exists but the target has no config', async () => {
    const storage = memoryStorage()
    const { app } = mount({ preInit: new Map([['staging', storage]]), configs: {} })
    const res = await app.request('/api/history?target=staging')
    expect(res.status).toBe(400)
    expect(await json(res)).toEqual({ error: 'Unknown target: staging' })
  })

  it('400 "Unknown target" when the config exists but no storage was initialised for it', async () => {
    const storage = memoryStorage()
    const { app } = mount({ preInit: new Map(), configs: { staging: config(storage) } })
    const res = await app.request('/api/history?target=staging')
    expect(res.status).toBe(400)
    expect(await json(res)).toEqual({ error: 'Unknown target: staging' })
  })

  it('409 when history is disabled for the target', async () => {
    const storage = memoryStorage()
    const { app } = mount({ configs: { staging: config(storage, { history: { enabled: false } }) } })
    const res = await app.request('/api/history?target=staging')
    expect(res.status).toBe(409)
    expect(await json(res)).toEqual({ error: 'History disabled for target "staging"' })
  })
})

describe('GET /api/history', () => {
  it('400 when the target query is missing or empty', async () => {
    const { app } = mount({ configs: {} })
    for (const url of ['/api/history', '/api/history?target=']) {
      const res = await app.request(url)
      expect(res.status).toBe(400)
      expect(await json(res)).toEqual({ error: 'Missing "target" query parameter' })
    }
  })

  it('lists revisions newest first, honouring ?limit', async () => {
    const storage = memoryStorage()
    const { r2, r3 } = await seedRevisions(storage)
    const { app } = mount({ configs: { staging: config(storage) } })
    const res = await app.request('/api/history?target=staging&limit=2')
    expect(res.status).toBe(200)
    const revisions = (await json(res)).revisions as { id: string }[]
    expect(revisions.map(r => r.id)).toEqual([r3.id, r2.id])
  })

  it('defaults to 50 revisions', async () => {
    const storage = memoryStorage()
    const history = createHistoryProvider({ storage, retention: 100 })
    for (let i = 0; i < 52; i++) {
      await history.recordRevision({ operation: 'save', items: new Map([[HOME, String(i)]]) })
    }
    const { app } = mount({ configs: { staging: config(storage, { history: { retention: 100 } }) } })
    const res = await app.request('/api/history?target=staging')
    expect(((await json(res)).revisions as unknown[]).length).toBe(50)
  })
})

describe('POST /api/history/undo', () => {
  it('400 when the target query is missing', async () => {
    const { app } = mount({ configs: {} })
    const res = await app.request('/api/history/undo', { method: 'POST' })
    expect(res.status).toBe(400)
    expect(await json(res)).toEqual({ error: 'Missing "target" query parameter' })
  })

  it('passes resolution errors through', async () => {
    const { app } = mount({ configs: {} })
    const res = await app.request('/api/history/undo?target=staging', { method: 'POST' })
    expect(res.status).toBe(400)
    expect(await json(res)).toEqual({ error: 'Unknown target: staging' })
  })

  it('409 when there is no prior revision', async () => {
    const storage = memoryStorage()
    await createHistoryProvider({ storage }).recordRevision({ operation: 'save', items: new Map([[HOME, v1]]) })
    const { app, events } = mount({ configs: { staging: config(storage) } })
    const res = await app.request('/api/history/undo?target=staging', { method: 'POST' })
    expect(res.status).toBe(409)
    expect(await json(res)).toEqual({ error: 'Nothing to undo — no prior revision on this target' })
    expect(events).toEqual([])
  })

  it('restores the revision before head, records a rollback, and audits', async () => {
    const storage = memoryStorage()
    const { history, r2, r3 } = await seedRevisions(storage)
    const { app, events, invalidated } = mount({ configs: { staging: config(storage) }, sourceTargetName: 'local' })
    const res = await app.request('/api/history/undo?target=staging', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.restoredFrom).toBe(r2.id)
    expect((body.revision as { operation: string }).operation).toBe('rollback')
    expect(await storage.readFile(HOME)).toBe(v2)

    const [head] = await history.listRevisions(1)
    expect(head.message).toBe(`Undo save (rev ${r3.id})`)

    expect(events).toEqual([
      {
        action: 'restore',
        outcome: 'success',
        scope: { kind: 'site' },
        metadata: { targetName: 'staging', restoredFrom: r2.id, undoneOperation: 'save' },
      },
    ])
    // Another target's history shares no cache with the source.
    expect(invalidated).toEqual([])
  })

  it('invalidates the source page and fragment caches when undoing on the source target', async () => {
    const storage = memoryStorage()
    await seedRevisions(storage)
    const { app, invalidated } = mount({ configs: { local: config(storage) }, sourceTargetName: 'local' })
    const res = await app.request('/api/history/undo?target=local', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(invalidated.sort()).toEqual(['fragments:', 'pages:'])
  })

  it('applies the target retention to the rollback revision', async () => {
    const storage = memoryStorage()
    const { history } = await seedRevisions(storage, 100)
    const { app } = mount({ configs: { staging: config(storage, { history: { retention: 2 } }) } })
    expect((await app.request('/api/history/undo?target=staging', { method: 'POST' })).status).toBe(200)
    expect((await history.listRevisions(100)).length).toBe(2)
  })
})

describe('POST /api/history/restore', () => {
  it('400 when the target or id query is missing', async () => {
    const { app } = mount({ configs: {} })
    const noTarget = await app.request('/api/history/restore?id=rev-1', { method: 'POST' })
    expect(noTarget.status).toBe(400)
    expect(await json(noTarget)).toEqual({ error: 'Missing "target" query parameter' })
    const noId = await app.request('/api/history/restore?target=staging', { method: 'POST' })
    expect(noId.status).toBe(400)
    expect(await json(noId)).toEqual({ error: 'Missing "id" query parameter' })
  })

  it('passes resolution errors through', async () => {
    const storage = memoryStorage()
    const { app } = mount({ configs: { staging: config(storage, { history: { enabled: false } }) } })
    const res = await app.request('/api/history/restore?target=staging&id=rev-1', { method: 'POST' })
    expect(res.status).toBe(409)
    expect(await json(res)).toEqual({ error: 'History disabled for target "staging"' })
  })

  it('restores the chosen revision and audits it', async () => {
    const storage = memoryStorage()
    const { history, r1 } = await seedRevisions(storage)
    const { app, events, invalidated } = mount({ configs: { staging: config(storage) }, sourceTargetName: 'local' })
    const res = await app.request(`/api/history/restore?target=staging&id=${r1.id}`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.restoredFrom).toBe(r1.id)
    expect((body.revision as { operation: string }).operation).toBe('rollback')
    expect(await storage.readFile(HOME)).toBe(v1)
    const [head] = await history.listRevisions(1)
    expect(head.message).toBe(`Rollback to ${r1.id}`)
    expect(events).toEqual([
      {
        action: 'restore',
        outcome: 'success',
        scope: { kind: 'site' },
        metadata: { targetName: 'staging', restoredFrom: r1.id },
      },
    ])
    expect(invalidated).toEqual([])
  })

  it('invalidates the source caches when restoring on the source target', async () => {
    const storage = memoryStorage()
    const { r1 } = await seedRevisions(storage)
    const { app, invalidated } = mount({ configs: { local: config(storage) }, sourceTargetName: 'local' })
    const res = await app.request(`/api/history/restore?target=local&id=${r1.id}`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(invalidated.sort()).toEqual(['fragments:', 'pages:'])
  })

  it('404 with the error message for an unknown revision, without auditing', async () => {
    const storage = memoryStorage()
    await seedRevisions(storage)
    const { app, events } = mount({ configs: { staging: config(storage) } })
    const res = await app.request('/api/history/restore?target=staging&id=rev-does-not-exist', { method: 'POST' })
    expect(res.status).toBe(404)
    const body = await json(res)
    expect(typeof body.error).toBe('string')
    expect((body.error as string).length).toBeGreaterThan(0)
    expect(events).toEqual([])
  })
})
