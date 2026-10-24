/**
 * Cut 14 — route-level integration tests for review-workflow ↔ archive.
 *
 * Validates the wiring of `archive-review.ts` helpers into
 * `handleArchive` and `handleUnarchive`:
 *   - Archive on pending-review emits review-withdraw THEN archive
 *     (per design-soft-delete.md Q9 N-A.2)
 *   - Archive on approved emits archive only, with priorReviewState
 *     metadata (per Q9 — approved discards via metadata)
 *   - Archive on draft (no reviewState) is unchanged
 *   - Unarchive strips reviewState from the manifest (Q9 N-B.1)
 *
 * Per rule 26 (test-isolation paranoia): each test gets a fresh
 * `memoryStorage()` + a fresh `createAdminApp`. Audit events are
 * read directly from the HistoryAuditProvider's storage entries.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { createHistoryAuditProvider, type AuditEvent } from '../src/audit/index.js'
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

async function readAuditEvents(): Promise<AuditEvent[]> {
  const reader = createHistoryAuditProvider({ storage, instance: 'reader-only' })
  return await reader.query!({})
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const raw = await storage.readFile(path)
  return JSON.parse(raw) as Record<string, unknown>
}

describe('Cut 14 — archive on pending-review', () => {
  beforeEach(() => {
    setup({
      'pages/landing/page.json': JSON.stringify({
        template: 'page-default',
        content: {},
        reviewState: 'pending-review',
      }),
    })
  })

  it('emits review-withdraw THEN archive event in that order', async () => {
    const res = await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    expect(res.status).toBe(200)

    const events = await readAuditEvents()
    // The query returns newest first, events from the same millisecond
    // included (#1244), so reversing gives the order they were recorded in.
    const matched = events.filter(e => e.scope.kind === 'page' && e.scope.name === 'landing').reverse()
    // Expect at least review-withdraw + archive
    const actions = matched.map(e => e.action)
    expect(actions).toContain('review-withdraw')
    expect(actions).toContain('archive')

    // Order: review-withdraw must precede archive
    const withdrawIdx = actions.indexOf('review-withdraw')
    const archiveIdx = actions.indexOf('archive')
    expect(withdrawIdx).toBeLessThan(archiveIdx)

    // review-withdraw metadata
    const withdraw = matched.find(e => e.action === 'review-withdraw')!
    expect(withdraw.outcome).toBe('success')
    expect(withdraw.metadata).toMatchObject({
      autoWithdrawn: true,
      reason: 'archive',
      priorState: 'pending-review',
    })
  })

  it('archive event captures priorReviewState in metadata', async () => {
    await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })

    const events = await readAuditEvents()
    const archiveEvent = events.find(
      e => e.action === 'archive' && e.scope.name === 'landing' && e.outcome === 'success',
    )
    expect(archiveEvent).toBeDefined()
    expect(archiveEvent!.metadata).toMatchObject({
      priorReviewState: 'pending-review',
      aliasOf: 'home',
    })
  })
})

describe('Cut 14 — archive on approved', () => {
  beforeEach(() => {
    setup({
      'pages/landing/page.json': JSON.stringify({
        template: 'page-default',
        content: {},
        reviewState: 'approved',
      }),
    })
  })

  it('does NOT emit review-withdraw (approved discards via priorReviewState only)', async () => {
    await app.request('/api/pages/landing/archive', { method: 'POST' })

    const events = await readAuditEvents()
    const matched = events.filter(e => e.scope.kind === 'page' && e.scope.name === 'landing')
    expect(matched.map(e => e.action)).not.toContain('review-withdraw')
    expect(matched.map(e => e.action)).toContain('archive')
  })

  it('archive event metadata captures priorReviewState: approved', async () => {
    await app.request('/api/pages/landing/archive', { method: 'POST' })

    const events = await readAuditEvents()
    const archiveEvent = events.find(e => e.action === 'archive' && e.scope.name === 'landing')
    expect(archiveEvent!.metadata).toMatchObject({ priorReviewState: 'approved' })
  })
})

describe('Cut 14 — archive on draft (current production)', () => {
  beforeEach(() => setup())

  it('emits archive only, no priorReviewState metadata', async () => {
    await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })

    const events = await readAuditEvents()
    const matched = events.filter(e => e.scope.kind === 'page' && e.scope.name === 'landing')
    expect(matched.map(e => e.action)).not.toContain('review-withdraw')

    const archiveEvent = matched.find(e => e.action === 'archive')!
    expect(archiveEvent.metadata).not.toHaveProperty('priorReviewState')
    expect(archiveEvent.metadata).toMatchObject({ aliasOf: 'home' })
  })
})

describe('Cut 14 — unarchive strips reviewState (restore-to-draft)', () => {
  beforeEach(() => {
    setup({
      'pages/landing/page.json': JSON.stringify({
        template: 'page-default',
        content: {},
        archived: true,
        archivedAt: '2026-01-01T00:00:00Z',
        archivedBy: 'alice@example.com',
        reviewState: 'pending-review',
      }),
    })
  })

  it('restored manifest has no reviewState (Q9 N-B.1: always to draft)', async () => {
    const res = await app.request('/api/pages/landing/unarchive', { method: 'POST' })
    expect(res.status).toBe(200)

    const restored = await readJson('pages/landing/page.json')
    expect(restored.archived).toBeUndefined()
    expect(restored.reviewState).toBeUndefined()
    expect(restored.template).toBe('page-default')
  })

  it('preserves content and template fields when restoring', async () => {
    storage.seed({
      'pages/landing/page.json': JSON.stringify({
        template: 'page-default',
        content: { title: 'Welcome' },
        components: ['hero'],
        archived: true,
        archivedAt: '2026-01-01T00:00:00Z',
        reviewState: 'approved',
      }),
    })

    const res = await app.request('/api/pages/landing/unarchive', { method: 'POST' })
    expect(res.status).toBe(200)

    const restored = await readJson('pages/landing/page.json')
    expect(restored).toEqual({
      template: 'page-default',
      content: { title: 'Welcome' },
      components: ['hero'],
    })
  })
})

describe('regression #284 — audit ordering race (direct provider, deterministic)', () => {
  beforeEach(() => {
    setup({
      'pages/landing/page.json': JSON.stringify({
        template: 'page-default',
        content: {},
        reviewState: 'pending-review',
      }),
    })
  })

  it('FAILING: indexOf on query() newest-first gives wrong order when archive is 1ms newer than withdraw (reproduces #284)', async () => {
    // Direct provider write with controlled timestamps reproduces the
    // cross-millisecond race documented in issue #284: the route fires two
    // audit.record() calls in sequence; when they straddle a millisecond
    // boundary the second event has a later timestamp. query() sorts
    // newest-first, so archive (T+1ms) lands at index 0 and
    // review-withdraw (T) lands at index 1 — reversing their order.
    const writer = createHistoryAuditProvider({ storage, instance: 'route-handler' })
    const actor = { id: 'test-user', role: 'admin', trustMode: 'none' }

    await writer.record({
      timestamp: '2026-01-01T12:00:00.000Z',
      actor,
      action: 'review-withdraw',
      outcome: 'success',
      scope: { kind: 'page', name: 'landing' },
      metadata: { autoWithdrawn: true, reason: 'archive', priorState: 'pending-review' },
    })
    await writer.record({
      timestamp: '2026-01-01T12:00:00.001Z', // 1ms later — the race condition
      actor,
      action: 'archive',
      outcome: 'success',
      scope: { kind: 'page', name: 'landing' },
      metadata: {},
    })

    const events = await readAuditEvents()
    const matched = events
      .filter(e => e.scope.kind === 'page' && e.scope.name === 'landing')
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    const actions = matched.map(e => e.action)
    const withdrawIdx = actions.indexOf('review-withdraw')
    const archiveIdx = actions.indexOf('archive')
    expect(withdrawIdx).toBeLessThan(archiveIdx)
  })
})
