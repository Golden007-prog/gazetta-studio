/**
 * #1191: an editor could publish to production — `publish:production`
 * was listed as a capability but nothing checked it. The publish
 * endpoints gated on the `publish:non-production` baseline only, so a
 * principal the design says must NOT reach a production target
 * (docs/auth.md: "Editor explicitly does NOT have
 * `publish:production`") could copy the site into one.
 *
 * These tests pin the per-target gate on all three write routes
 * (POST /api/publish, POST /api/publish/stream, POST /api/fetch):
 * a request that would write a target with `environment:
 * 'production'` gets the design's 403 body before any hook fires or
 * anything is written, and a mixed staging + production request
 * writes to NEITHER. `/api/publish/audit` only reads and keeps its
 * baseline gate.
 *
 * Strategy mirrors auth-integration.test.ts: a real createAdminApp
 * with the manifest's admin.auth block set to forwarded-user, so the
 * principal comes from the same wiring production operators use.
 * Editor is the default role; the `admins` group maps to admin.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

const EDITOR_HEADERS = {
  'X-Forwarded-User': 'alice',
  'X-Forwarded-For': '10.0.0.5',
}
const ADMIN_HEADERS = {
  'X-Forwarded-User': 'bob',
  'X-Forwarded-For': '10.0.0.5',
  'X-Forwarded-Groups': 'admins',
}

function buildApp(opts: { defaultEditableProduction?: boolean } = {}): {
  app: Hono
  sourceStorage: MemoryStorage
  stagingStorage: MemoryStorage
  productionStorage: MemoryStorage
} {
  const sourceStorage = memoryStorage()
  const stagingStorage = memoryStorage()
  const productionStorage = memoryStorage()
  sourceStorage.seed({
    'pages/home/page.json': JSON.stringify({
      template: 'page-default',
      metadata: { title: 'Home' },
      components: [{ name: 'message', template: 'text-block', content: { body: 'Hi' } }],
    }),
    'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout', content: {} }),
  })
  stagingStorage.seed({
    'pages/home/page.json': JSON.stringify({
      template: 'page-default',
      metadata: { title: 'Home (staging)' },
      components: [],
    }),
  })

  const targetConfigs = {
    // With `editable: false` here, the registry's defaultEditable() is the
    // editable production target below (hotfix pattern): an omitted fetch
    // destination resolves to production.
    local: {
      storage: sourceStorage,
      type: 'esi' as const,
      environment: 'local' as const,
      editable: !opts.defaultEditableProduction,
    },
    staging: { storage: stagingStorage, type: 'static' as const, environment: 'staging' as const },
    production: {
      storage: productionStorage,
      type: 'static' as const,
      environment: 'production' as const,
      editable: true,
    },
  }
  const source = createSourceContext({
    storage: sourceStorage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: {
      name: 'test-site',
      targets: targetConfigs,
      admin: {
        auth: {
          trust: 'forwarded-user',
          trustedProxies: ['10.0.0.0/8'],
          roleMapping: { claim: 'groups', map: { admins: 'admin' }, defaultRole: 'editor' },
        },
      },
    },
  })
  const app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: starterTemplatesDir,
    targets: new Map([
      ['local', sourceStorage],
      ['staging', stagingStorage],
      ['production', productionStorage],
    ]),
    targetConfigs,
    disableCacheStatsLogger: true,
  })
  return { app, sourceStorage, stagingStorage, productionStorage }
}

function post(app: Hono, path: string, headers: Record<string, string>, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('publish production gate (#1191)', { timeout: 30000 }, () => {
  let app: Hono
  let sourceStorage: MemoryStorage
  let stagingStorage: MemoryStorage
  let productionStorage: MemoryStorage
  beforeEach(() => {
    ;({ app, sourceStorage, stagingStorage, productionStorage } = buildApp())
  })

  async function readAuditEvents(): Promise<Array<Record<string, unknown>>> {
    // HistoryAuditProvider (zero-config default) appends one JSONL
    // event per record under the SOURCE storage's .gazetta/audit/.
    const entries = await sourceStorage.readDir('.gazetta/audit').catch(() => [])
    const names = entries.filter(e => !e.isDirectory && e.name.endsWith('.jsonl')).map(e => e.name)
    const events: Array<Record<string, unknown>> = []
    for (const name of names) {
      const content = await sourceStorage.readFile(`.gazetta/audit/${name}`)
      for (const line of content.split('\n')) {
        if (line.trim()) events.push(JSON.parse(line))
      }
    }
    return events
  }

  function forbiddenPublishEvents(events: Array<Record<string, unknown>>) {
    return events.filter(e => e.action === 'publish' && e.outcome === 'forbidden')
  }

  it('refuses an editor publishing to a production target, and the target stays empty', async () => {
    const res = await post(app, '/api/publish', EDITOR_HEADERS, {
      items: ['pages/home'],
      targets: ['production'],
    })

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('FORBIDDEN')
    expect(body.missing).toEqual(['publish:production'])
    expect(body.role).toBe('editor')
    expect(await productionStorage.exists('index.html')).toBe(false)
  })

  it('lets the same editor publish to a staging target', async () => {
    const res = await post(app, '/api/publish', EDITOR_HEADERS, {
      items: ['pages/home'],
      targets: ['staging'],
    })

    expect(res.status).toBeLessThan(300)
    expect(await stagingStorage.exists('index.html')).toBe(true)
  })

  it('lets an admin publish to the production target', async () => {
    const res = await post(app, '/api/publish', ADMIN_HEADERS, {
      items: ['pages/home'],
      targets: ['production'],
    })

    expect(res.status).toBeLessThan(300)
    expect(await productionStorage.exists('index.html')).toBe(true)
  })

  it('refuses a mixed staging + production request and writes to NEITHER', async () => {
    const res = await post(app, '/api/publish', EDITOR_HEADERS, {
      items: ['pages/home'],
      targets: ['staging', 'production'],
    })

    expect(res.status).toBe(403)
    expect((await res.json()).missing).toEqual(['publish:production'])
    expect(await stagingStorage.exists('index.html')).toBe(false)
    expect(await productionStorage.exists('index.html')).toBe(false)
  })

  it('refuses an editor on the SSE route before the stream opens', async () => {
    const res = await post(app, '/api/publish/stream', EDITOR_HEADERS, {
      items: ['pages/home'],
      targets: ['production'],
    })

    expect(res.status).toBe(403)
    expect((await res.json()).missing).toEqual(['publish:production'])
    expect(await productionStorage.exists('index.html')).toBe(false)
  })

  it('refuses an editor fetching INTO an editable production target', async () => {
    const res = await post(app, '/api/fetch', EDITOR_HEADERS, {
      source: 'staging',
      destination: 'production',
    })

    expect(res.status).toBe(403)
    expect((await res.json()).missing).toEqual(['publish:production'])
  })

  it('gates the resolved default destination when no destination is named', async () => {
    // Review on #1253: with the local target not editable, the default
    // editable target IS the editable production one, and an omitted
    // `destination` used to skip the gate (it only saw the named value).
    ;({ app, stagingStorage, productionStorage } = buildApp({ defaultEditableProduction: true }))
    const res = await post(app, '/api/fetch', EDITOR_HEADERS, {
      source: 'staging',
      items: ['pages/home'],
    })

    expect(res.status).toBe(403)
    expect((await res.json()).missing).toEqual(['publish:production'])
    expect(await productionStorage.exists('pages/home/page.json')).toBe(false)
  })

  it('records a forbidden event for a denied production publish (#1192)', async () => {
    const res = await post(app, '/api/publish', EDITOR_HEADERS, {
      items: ['pages/home'],
      targets: ['production'],
    })

    expect(res.status).toBe(403)
    const denied = forbiddenPublishEvents(await readAuditEvents())
    expect(denied).toHaveLength(1)
    expect((denied[0].metadata as Record<string, unknown>).missingCapabilities).toEqual([
      'publish:production',
    ])
  })

  it('records a forbidden event for a denied production stream publish (#1192)', async () => {
    const res = await post(app, '/api/publish/stream', EDITOR_HEADERS, {
      items: ['pages/home'],
      targets: ['production'],
    })

    expect(res.status).toBe(403)
    expect(forbiddenPublishEvents(await readAuditEvents())).toHaveLength(1)
  })

  it('records a forbidden event for a denied production fetch (#1192)', async () => {
    const res = await post(app, '/api/fetch', EDITOR_HEADERS, {
      source: 'staging',
      destination: 'production',
    })

    expect(res.status).toBe(403)
    expect(forbiddenPublishEvents(await readAuditEvents())).toHaveLength(1)
  })

  it('keeps the read-only audit route on its baseline gate', async () => {
    const res = await post(app, '/api/publish/audit', EDITOR_HEADERS, {
      target: 'production',
      items: [{ kind: 'page', name: 'home' }],
    })

    // Editor holds the baseline publish:non-production, so the read
    // goes through; the production gate must not change this route.
    expect(res.status).toBe(200)
  })
})
