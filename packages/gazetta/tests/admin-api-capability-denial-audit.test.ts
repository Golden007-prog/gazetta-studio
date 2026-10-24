/**
 * #1192: denied admin requests (401 and 403) were not recorded in the
 * audit log. design-audit.md "Recording scope (v1)" records denied
 * WRITE attempts (`forbidden` / `unauthenticated` for save, publish,
 * delete, restore); `requireCapability` returned its 401/403 without
 * recording anything, and docs/audit.md told operators the events
 * exist ("which editor tried to publish to prod last Friday?").
 *
 * These tests pin the middleware-level recording through
 * createAdminApp + GET /api/audit (the forensic surface operators
 * use), per #1192's acceptance criteria:
 *
 *   - editor deleting a page: 403 + one event
 *     { action: 'delete', outcome: 'forbidden', scope: page scope,
 *       metadata.missingCapabilities: ['delete:pages'] } with the
 *     editor as actor
 *   - viewer publishing: 403 + { action: 'publish', outcome:
 *     'forbidden' }
 *   - anonymous save: 401 + outcome 'unauthenticated'
 *   - denied read (editor querying the audit log): records NOTHING
 *     (reads are out of v1's recording scope)
 *
 * Strategy mirrors auth-integration.test.ts and the publish-gate
 * tests: real createAdminApp with forwarded-user auth; editor is the
 * default role, groups map to admin/viewer.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'
import type { Principal } from '../src/auth/index.js'
import { requireCapability } from '../src/admin-api/middleware/capability.js'

const EDITOR_HEADERS = {
  'X-Forwarded-User': 'alice',
  'X-Forwarded-For': '10.0.0.5',
}
const VIEWER_HEADERS = {
  'X-Forwarded-User': 'carol',
  'X-Forwarded-For': '10.0.0.5',
  'X-Forwarded-Groups': 'viewers',
}
const ADMIN_HEADERS = {
  'X-Forwarded-User': 'bob',
  'X-Forwarded-For': '10.0.0.5',
  'X-Forwarded-Groups': 'admins',
}

function buildApp(): { app: Hono; sourceStorage: MemoryStorage } {
  const sourceStorage = memoryStorage()
  sourceStorage.seed({
    'pages/home/page.json': JSON.stringify({
      template: 'page-default',
      metadata: { title: 'Home' },
      components: [],
    }),
  })
  const targetConfigs = {
    local: { storage: sourceStorage, type: 'esi' as const, environment: 'local' as const, editable: true },
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
          roleMapping: {
            claim: 'groups',
            map: { admins: 'admin', viewers: 'viewer' },
            defaultRole: 'editor',
          },
        },
      },
    },
  })
  const app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: starterTemplatesDir,
    targets: new Map([['local', sourceStorage]]),
    targetConfigs,
    disableCacheStatsLogger: true,
  })
  return { app, sourceStorage }
}

async function auditLog(app: Hono): Promise<Array<Record<string, unknown>>> {
  const res = await app.request('/api/audit', { headers: ADMIN_HEADERS })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { events: Array<Record<string, unknown>> }
  return body.events
}

describe('capability denial audit records (#1192)', { timeout: 30000 }, () => {
  let app: Hono
  beforeEach(() => {
    ;({ app } = buildApp())
  })

  it('records one forbidden delete event with page scope and the editor as actor', async () => {
    const res = await app.request('/api/pages/home', { method: 'DELETE', headers: EDITOR_HEADERS })
    expect(res.status).toBe(403)

    const events = await auditLog(app)
    const denied = events.filter(e => e.action === 'delete' && e.outcome === 'forbidden')
    expect(denied).toHaveLength(1)
    expect(denied[0].scope).toEqual({ kind: 'page', name: 'home' })
    expect((denied[0].metadata as Record<string, unknown>).missingCapabilities).toEqual(['delete:pages'])
    expect((denied[0].actor as Record<string, unknown>).id).toBe('alice')
  })

  it('keeps item scope when the app is mounted under a path prefix', async () => {
    // The CLI serves the CMS at /admin (cli/index.ts `app.route('/admin',
    // cmsApp)`), so c.req.path arrives as /admin/api/pages/home. Pin the
    // item scope against that production mount shape.
    const outer = new Hono()
    outer.route('/admin', app)
    const res = await outer.request('/admin/api/pages/home', { method: 'DELETE', headers: EDITOR_HEADERS })
    expect(res.status).toBe(403)

    const auditRes = await outer.request('/admin/api/audit', { headers: ADMIN_HEADERS })
    expect(auditRes.status).toBe(200)
    const body = (await auditRes.json()) as { events: Array<Record<string, unknown>> }
    const denied = body.events.filter(e => e.action === 'delete' && e.outcome === 'forbidden')
    expect(denied).toHaveLength(1)
    expect(denied[0].scope).toEqual({ kind: 'page', name: 'home' })
  })

  it('records a forbidden publish event for a viewer', async () => {
    const res = await app.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...VIEWER_HEADERS },
      body: JSON.stringify({ items: ['pages/home'], targets: ['local'] }),
    })
    expect(res.status).toBe(403)

    const events = await auditLog(app)
    const denied = events.filter(e => e.action === 'publish' && e.outcome === 'forbidden')
    expect(denied).toHaveLength(1)
    expect((denied[0].metadata as Record<string, unknown>).missingCapabilities).toEqual(['publish:non-production'])
  })

  it('records an unauthenticated event for an anonymous save attempt', async () => {
    const res = await app.request('/api/pages/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.0.5' },
      body: JSON.stringify({ content: { title: 'Hi' } }),
    })
    expect(res.status).toBe(401)

    const events = await auditLog(app)
    const denied = events.filter(e => e.action === 'save' && e.outcome === 'unauthenticated')
    expect(denied).toHaveLength(1)
    expect(denied[0].scope).toEqual({ kind: 'page', name: 'home' })
  })

  it('still denies when requireCapability is wired without auditMiddleware', async () => {
    // Consumers (and the mutation-coverage harnesses) can wire
    // requireCapability without auditMiddleware; the denial response
    // must not depend on the audit context being present.
    const bare = new Hono<{ Variables: { principal: Principal } }>()
    bare.use('/api/*', async (c, next) => {
      c.set('principal', {
        id: 'alice',
        role: 'editor',
        capabilities: ['read:*', 'edit:*', 'publish:non-production', 'review:submit'],
      })
      await next()
    })
    bare.delete('/api/pages/:name', requireCapability('delete:pages'), c => c.json({ ok: true }))

    const res = await bare.request('/api/pages/home', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  it('records nothing for a denied read', async () => {
    const res = await app.request('/api/audit', { headers: EDITOR_HEADERS })
    expect(res.status).toBe(403)

    const events = await auditLog(app)
    expect(events.filter(e => e.outcome === 'forbidden' || e.outcome === 'unauthenticated')).toHaveLength(0)
  })
})
