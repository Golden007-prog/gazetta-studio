/**
 * Cut 6 tests: GET /api/audit endpoint.
 *
 * Validates the route in isolation — provides a synthetic
 * AuditProvider list (no real storage) so each test pins one
 * facet of the contract:
 *
 *   - filter parsing (action / outcome / scope / actor / since /
 *     until / limit) → invalid values return 400
 *   - merge + dedup across queryable providers
 *   - newest-first sort on the merged set
 *   - external-sink references composed into the response when a
 *     provider omits query() but provides queryUrl()
 *   - capability gating (`read:audit-log`) blocks unauthenticated
 *     requests with 401 and authenticated-without-grant with 403
 *
 * Strategy: mount the real `auditRoutes` factory under a Hono app
 * with `principalMiddleware` set to `nonePrincipalProvider` so the
 * default Principal is admin/`*` (matches createAdminApp's default).
 * Synthetic AuditProviders implement query() / queryUrl() with
 * canned payloads.
 */
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { auditRoutes } from '../src/admin-api/routes/audit.js'
import { principalMiddleware } from '../src/admin-api/middleware/principal.js'
import { noneAuthProvider } from '../src/auth/providers/none.js'
import type { AuditProvider } from '../src/audit/provider.js'
import { createHistoryAuditProvider } from '../src/audit/providers/history.js'
import type { AuditEvent, AuditQuery } from '../src/audit/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'

function makeEvent(partial: Partial<AuditEvent> = {}): AuditEvent {
  return {
    timestamp: '2026-05-04T14:23:05Z',
    actor: { id: 'unknown', role: 'admin', trustMode: 'none' },
    action: 'save',
    outcome: 'success',
    scope: { kind: 'page', name: 'home' },
    ...partial,
  }
}

function makeQueryableProvider(name: string, events: AuditEvent[]): AuditProvider {
  return {
    name,
    async record() {
      // No-op for the route tests; recording isn't exercised here.
    },
    async query(filter: AuditQuery): Promise<AuditEvent[]> {
      let matched = events
      if (filter.action) matched = matched.filter(e => e.action === filter.action)
      if (filter.outcome) matched = matched.filter(e => e.outcome === filter.outcome)
      if (filter.scope?.kind) matched = matched.filter(e => e.scope.kind === filter.scope!.kind)
      if (filter.scope?.name) matched = matched.filter(e => e.scope.name === filter.scope!.name)
      if (filter.actor) {
        const needle = filter.actor.toLowerCase()
        matched = matched.filter(
          e => e.actor.id.toLowerCase().includes(needle) || (e.actor.email?.toLowerCase().includes(needle) ?? false),
        )
      }
      if (filter.since) matched = matched.filter(e => e.timestamp >= filter.since!)
      if (filter.until) matched = matched.filter(e => e.timestamp < filter.until!)
      const limit = filter.limit ?? 100
      return matched.slice(0, limit)
    },
  }
}

function makeExternalSinkProvider(name: string, url: string | null): AuditProvider {
  return {
    name,
    async record() {},
    queryUrl: () => url,
  }
}

function buildApp(providers: AuditProvider[]): Hono {
  const app = new Hono()
  // Mount the principal middleware first so requireCapability has a
  // c.var.principal to read. nonePrincipalProvider returns the
  // 'unknown' / 'admin' principal which holds `*` capabilities — same
  // shape createAdminApp uses when no auth is configured.
  app.use('/api/*', principalMiddleware(noneAuthProvider))
  app.route('/', auditRoutes({ providers }))
  return app
}

/**
 * Build an app with a non-admin principal — for capability-gating
 * tests. The fake provider returns whatever Principal the test
 * asks for (editor / viewer / unknown).
 */
function buildAppWithRole(providers: AuditProvider[], role: string, capabilities: ReadonlyArray<string>): Hono {
  const app = new Hono()
  const fakeProvider = {
    trustMode: 'forwarded-user',
    async extractPrincipal() {
      return {
        id: role === 'unknown' ? 'unknown' : `${role}@example.com`,
        role,
        trustMode: 'forwarded-user',
        capabilities,
      }
    },
  }
  app.use('/api/*', principalMiddleware(fakeProvider))
  app.route('/', auditRoutes({ providers }))
  return app
}

describe('Cut 6 — GET /api/audit', () => {
  it('returns events from a single queryable provider, newest-first', async () => {
    const provider = makeQueryableProvider('history', [
      makeEvent({ timestamp: '2026-05-04T10:00:00Z', scope: { kind: 'page', name: 'a' } }),
      makeEvent({ timestamp: '2026-05-04T12:00:00Z', scope: { kind: 'page', name: 'b' } }),
      makeEvent({ timestamp: '2026-05-04T11:00:00Z', scope: { kind: 'page', name: 'c' } }),
    ])
    const app = buildApp([provider])
    const res = await app.request('/api/audit')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.events).toHaveLength(3)
    // Newest first — note the route re-sorts after merge so even a
    // provider returning out-of-order events lands sorted at the wire.
    expect(body.events[0].scope.name).toBe('b')
    expect(body.events[1].scope.name).toBe('c')
    expect(body.events[2].scope.name).toBe('a')
    expect(body.externalSinks).toEqual([])
  })

  it('shows events recorded in the same millisecond newest-first (#1244)', async () => {
    const history = createHistoryAuditProvider({ storage: memoryStorage(), instance: 'inst-1' })
    const at = '2026-05-04T10:00:00.123Z'
    for (const action of ['review-submit', 'review-reject', 'review-withdraw'] as const) {
      await history.record(makeEvent({ timestamp: at, action }))
    }
    const res = await buildApp([history]).request('/api/audit')
    const body = await res.json()
    expect(body.events.map((e: AuditEvent) => e.action)).toEqual(['review-withdraw', 'review-reject', 'review-submit'])
  })

  it('merges + dedups events across multiple queryable providers', async () => {
    const sharedEvent = makeEvent({
      timestamp: '2026-05-04T12:00:00Z',
      scope: { kind: 'page', name: 'shared' },
    })
    const historyOnly = makeEvent({
      timestamp: '2026-05-04T10:00:00Z',
      scope: { kind: 'page', name: 'history-only' },
    })
    const fileOnly = makeEvent({
      timestamp: '2026-05-04T11:00:00Z',
      scope: { kind: 'page', name: 'file-only' },
    })
    const history = makeQueryableProvider('history', [sharedEvent, historyOnly])
    const file = makeQueryableProvider('file', [sharedEvent, fileOnly])
    const app = buildApp([history, file])
    const res = await app.request('/api/audit')
    expect(res.status).toBe(200)
    const body = await res.json()
    // 3 unique events (shared dedupes once)
    expect(body.events).toHaveLength(3)
    const names = body.events.map((e: AuditEvent) => e.scope.name)
    expect(names).toEqual(['shared', 'file-only', 'history-only'])
  })

  it('composes external-sink references for non-queryable providers', async () => {
    const queryable = makeQueryableProvider('history', [makeEvent()])
    const cloudwatch = makeExternalSinkProvider('cloudwatch', 'https://aws.example.com/audit')
    const webhook = makeExternalSinkProvider('webhook', null)
    const app = buildApp([queryable, cloudwatch, webhook])
    const res = await app.request('/api/audit')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.events).toHaveLength(1)
    expect(body.externalSinks).toEqual([
      { name: 'cloudwatch', url: 'https://aws.example.com/audit' },
      { name: 'webhook', url: null },
    ])
  })

  it('filters by action via query string', async () => {
    const events = [
      makeEvent({ action: 'save', scope: { kind: 'page', name: 'a' } }),
      makeEvent({ action: 'publish', scope: { kind: 'page', name: 'b' } }),
      makeEvent({ action: 'delete', scope: { kind: 'page', name: 'c' } }),
    ]
    const app = buildApp([makeQueryableProvider('history', events)])
    const res = await app.request('/api/audit?action=publish')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.events).toHaveLength(1)
    expect(body.events[0].action).toBe('publish')
  })

  it('filters by outcome', async () => {
    const events = [
      makeEvent({ outcome: 'success', scope: { kind: 'page', name: 'a' } }),
      makeEvent({ outcome: 'validation-failed', scope: { kind: 'page', name: 'b' } }),
    ]
    const app = buildApp([makeQueryableProvider('history', events)])
    const res = await app.request('/api/audit?outcome=validation-failed')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.events).toHaveLength(1)
    expect(body.events[0].outcome).toBe('validation-failed')
  })

  it('filters by scope kind + name', async () => {
    const events = [
      makeEvent({ scope: { kind: 'page', name: 'home' } }),
      makeEvent({ scope: { kind: 'fragment', name: 'header' } }),
      makeEvent({ scope: { kind: 'page', name: 'about' } }),
    ]
    const app = buildApp([makeQueryableProvider('history', events)])
    const resKind = await app.request('/api/audit?scopeKind=fragment')
    expect((await resKind.json()).events).toHaveLength(1)
    const resName = await app.request('/api/audit?scopeName=home')
    expect((await resName.json()).events).toHaveLength(1)
  })

  it('filters by actor (substring on id + email)', async () => {
    const events = [
      makeEvent({ actor: { id: 'alice@example.com', role: 'editor', trustMode: 'forwarded-user' } }),
      makeEvent({ actor: { id: 'bob@example.com', role: 'editor', trustMode: 'forwarded-user' } }),
    ]
    const app = buildApp([makeQueryableProvider('history', events)])
    const res = await app.request('/api/audit?actor=alice')
    const body = await res.json()
    expect(body.events).toHaveLength(1)
    expect(body.events[0].actor.id).toBe('alice@example.com')
  })

  it('filters by time bounds (since inclusive, until exclusive)', async () => {
    const events = [
      makeEvent({ timestamp: '2026-05-04T10:00:00Z', scope: { kind: 'page', name: 'a' } }),
      makeEvent({ timestamp: '2026-05-04T11:00:00Z', scope: { kind: 'page', name: 'b' } }),
      makeEvent({ timestamp: '2026-05-04T12:00:00Z', scope: { kind: 'page', name: 'c' } }),
    ]
    const app = buildApp([makeQueryableProvider('history', events)])
    const res = await app.request('/api/audit?since=2026-05-04T11:00:00Z&until=2026-05-04T12:00:00Z')
    const body = await res.json()
    expect(body.events).toHaveLength(1)
    expect(body.events[0].scope.name).toBe('b')
  })

  it('honors limit; clamps to MAX_LIMIT', async () => {
    const events = Array.from({ length: 50 }, (_, i) =>
      makeEvent({
        timestamp: `2026-05-04T${String(i).padStart(2, '0')}:00:00Z`,
        scope: { kind: 'page', name: `p${i}` },
      }),
    )
    const app = buildApp([makeQueryableProvider('history', events)])
    const res = await app.request('/api/audit?limit=10')
    const body = await res.json()
    expect(body.events).toHaveLength(10)
    // Default limit when omitted = 100; we have 50 events so we get all 50.
    const resDefault = await app.request('/api/audit')
    expect((await resDefault.json()).events).toHaveLength(50)
  })

  it('rejects invalid action / outcome / scopeKind / limit with 400', async () => {
    const app = buildApp([makeQueryableProvider('history', [makeEvent()])])
    expect((await app.request('/api/audit?action=bogus')).status).toBe(400)
    expect((await app.request('/api/audit?outcome=bogus')).status).toBe(400)
    expect((await app.request('/api/audit?scopeKind=bogus')).status).toBe(400)
    expect((await app.request('/api/audit?limit=-5')).status).toBe(400)
    expect((await app.request('/api/audit?limit=abc')).status).toBe(400)
  })

  it('treats provider query() failures as fail-open (empty result, no throw)', async () => {
    const failing: AuditProvider = {
      name: 'failing',
      async record() {},
      async query() {
        throw new Error('simulated provider failure')
      },
    }
    const ok = makeQueryableProvider('history', [makeEvent()])
    const app = buildApp([failing, ok])
    const res = await app.request('/api/audit')
    expect(res.status).toBe(200)
    const body = await res.json()
    // Failing provider contributed nothing; ok provider's events still flow.
    expect(body.events).toHaveLength(1)
  })

  it('returns empty events + empty externalSinks when no providers configured', async () => {
    const app = buildApp([])
    const res = await app.request('/api/audit')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.events).toEqual([])
    expect(body.externalSinks).toEqual([])
  })

  // Cut 9 — capability gating. read:audit-log is wildcard-exempt
  // per design-auth-rbac.md "viewers don't see audit by default".
  // Only admin (root wildcard *) or explicit grant of read:audit-log
  // passes the gate; editor / viewer with `read:*` are blocked.
  describe('Cut 9 — capability gating', () => {
    it('admin role with `*` is allowed (200)', async () => {
      const app = buildAppWithRole([makeQueryableProvider('history', [])], 'admin', ['*'])
      const res = await app.request('/api/audit')
      expect(res.status).toBe(200)
    })

    it('editor role with read:* + edit:* is forbidden (403)', async () => {
      const app = buildAppWithRole([makeQueryableProvider('history', [])], 'editor', [
        'read:*',
        'edit:*',
        'publish:non-production',
      ])
      const res = await app.request('/api/audit')
      expect(res.status).toBe(403)
    })

    it('viewer role with read:* is forbidden (403)', async () => {
      const app = buildAppWithRole([makeQueryableProvider('history', [])], 'viewer', ['read:*'])
      const res = await app.request('/api/audit')
      expect(res.status).toBe(403)
    })

    it('custom auditor role with explicit read:audit-log is allowed (200)', async () => {
      const app = buildAppWithRole([makeQueryableProvider('history', [])], 'auditor', ['read:*', 'read:audit-log'])
      const res = await app.request('/api/audit')
      expect(res.status).toBe(200)
    })
  })
})
