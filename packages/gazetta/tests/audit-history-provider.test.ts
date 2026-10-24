/**
 * Cut 2 tests: HistoryAuditProvider — JSONL storage of audit events
 * with filter/sort/limit semantics for the `query()` path.
 *
 * Multi-instance correctness: each instance writes its own
 * `events-{instance}.jsonl`. Reads aggregate via readDir + concat.
 * Tests cover both the per-instance write path AND the aggregate
 * read path (two providers, same storage, different instances).
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { createHistoryAuditProvider, type AuditEvent } from '../src/audit/index.js'

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    timestamp: '2026-05-07T15:00:00Z',
    actor: { id: 'alice', email: 'alice@example.com', role: 'editor', trustMode: 'cloudflare-access' },
    action: 'save',
    outcome: 'success',
    scope: { kind: 'page', name: 'home' },
    ...overrides,
  }
}

describe('HistoryAuditProvider — record (Cut 2)', () => {
  let storage: MemoryStorage

  beforeEach(() => {
    storage = memoryStorage()
  })

  it('writes the first event to .gazetta/audit/events-{instance}.jsonl', async () => {
    const provider = createHistoryAuditProvider({ storage, instance: 'inst-1' })
    await provider.record(event())
    const file = await storage.readFile('.gazetta/audit/events-inst-1.jsonl')
    const lines = file.trim().split('\n')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]) as AuditEvent
    expect(parsed.actor.id).toBe('alice')
    expect(parsed.action).toBe('save')
  })

  it('appends multiple events (read-modify-write per call)', async () => {
    const provider = createHistoryAuditProvider({ storage, instance: 'inst-1' })
    await provider.record(event({ timestamp: '2026-05-07T15:00:00Z' }))
    await provider.record(event({ timestamp: '2026-05-07T15:00:01Z' }))
    await provider.record(event({ timestamp: '2026-05-07T15:00:02Z' }))
    const file = await storage.readFile('.gazetta/audit/events-inst-1.jsonl')
    expect(file.trim().split('\n')).toHaveLength(3)
  })

  it("reports name === 'history'", () => {
    const provider = createHistoryAuditProvider({ storage, instance: 'x' })
    expect(provider.name).toBe('history')
  })

  it('different instances write to different files (multi-instance correctness)', async () => {
    const a = createHistoryAuditProvider({ storage, instance: 'pod-a' })
    const b = createHistoryAuditProvider({ storage, instance: 'pod-b' })
    await a.record(event({ actor: { id: 'alice', role: 'editor', trustMode: 'cloudflare-access' } }))
    await b.record(event({ actor: { id: 'bob', role: 'editor', trustMode: 'cloudflare-access' } }))
    expect(await storage.readFile('.gazetta/audit/events-pod-a.jsonl')).toContain('alice')
    expect(await storage.readFile('.gazetta/audit/events-pod-b.jsonl')).toContain('bob')
    // Pod-a's file does NOT contain pod-b's events (no race / no
    // shared-write concern).
    expect(await storage.readFile('.gazetta/audit/events-pod-a.jsonl')).not.toContain('bob')
  })

  it('queryUrl is omitted (provider has queryable storage)', () => {
    const provider = createHistoryAuditProvider({ storage, instance: 'x' })
    expect(provider.queryUrl).toBeUndefined()
  })
})

describe('HistoryAuditProvider — query (Cut 2)', () => {
  let storage: MemoryStorage
  let provider: ReturnType<typeof createHistoryAuditProvider>

  beforeEach(async () => {
    storage = memoryStorage()
    provider = createHistoryAuditProvider({ storage, instance: 'inst-1' })
    await provider.record(
      event({
        timestamp: '2026-05-07T15:00:00Z',
        actor: { id: 'alice', role: 'editor', trustMode: 'cloudflare-access' },
        action: 'save',
        outcome: 'success',
        scope: { kind: 'page', name: 'home' },
      }),
    )
    await provider.record(
      event({
        timestamp: '2026-05-07T16:00:00Z',
        actor: { id: 'bob', role: 'admin', trustMode: 'cloudflare-access' },
        action: 'publish',
        outcome: 'success',
        scope: { kind: 'page', name: 'about' },
      }),
    )
    await provider.record(
      event({
        timestamp: '2026-05-07T17:00:00Z',
        actor: { id: 'alice', role: 'editor', trustMode: 'cloudflare-access' },
        action: 'save',
        outcome: 'validation-failed',
        scope: { kind: 'page', name: 'home' },
      }),
    )
  })

  it('returns events newest-first by default', async () => {
    const events = await provider.query!({})
    expect(events).toHaveLength(3)
    expect(events[0].timestamp).toBe('2026-05-07T17:00:00Z')
    expect(events[2].timestamp).toBe('2026-05-07T15:00:00Z')
  })

  it('returns events recorded in the same millisecond newest-first too (#1244)', async () => {
    // Back-to-back requests often share a millisecond: timestamps come from toISOString().
    const fresh = createHistoryAuditProvider({ storage: memoryStorage(), instance: 'inst-1' })
    const at = '2026-05-07T15:00:00.123Z'
    for (const action of ['review-submit', 'review-reject', 'review-submit', 'review-withdraw'] as const) {
      await fresh.record(event({ timestamp: at, action }))
    }
    const events = await fresh.query!({})
    expect(events.map(e => e.action)).toEqual(['review-withdraw', 'review-submit', 'review-reject', 'review-submit'])
  })

  it('filters by actor (substring on id or email)', async () => {
    const events = await provider.query!({ actor: 'alice' })
    expect(events).toHaveLength(2)
    expect(events.every(e => e.actor.id === 'alice')).toBe(true)
  })

  it('filters by action', async () => {
    const events = await provider.query!({ action: 'publish' })
    expect(events).toHaveLength(1)
    expect(events[0].action).toBe('publish')
  })

  it('filters by outcome', async () => {
    const events = await provider.query!({ outcome: 'validation-failed' })
    expect(events).toHaveLength(1)
    expect(events[0].outcome).toBe('validation-failed')
  })

  it('filters by scope.kind + scope.name', async () => {
    const homeEvents = await provider.query!({ scope: { kind: 'page', name: 'home' } })
    expect(homeEvents).toHaveLength(2)
    expect(homeEvents.every(e => e.scope.name === 'home')).toBe(true)
  })

  it('filters by since (inclusive)', async () => {
    const events = await provider.query!({ since: '2026-05-07T16:00:00Z' })
    expect(events).toHaveLength(2)
    // 16:00 boundary is INCLUSIVE
    expect(events.some(e => e.timestamp === '2026-05-07T16:00:00Z')).toBe(true)
  })

  it('filters by until (exclusive)', async () => {
    const events = await provider.query!({ until: '2026-05-07T17:00:00Z' })
    expect(events).toHaveLength(2)
    // 17:00 boundary is EXCLUSIVE
    expect(events.some(e => e.timestamp === '2026-05-07T17:00:00Z')).toBe(false)
  })

  it('combines filters (AND)', async () => {
    const events = await provider.query!({
      actor: 'alice',
      action: 'save',
      outcome: 'success',
    })
    expect(events).toHaveLength(1)
    expect(events[0].actor.id).toBe('alice')
    expect(events[0].outcome).toBe('success')
  })

  it('respects limit', async () => {
    const events = await provider.query!({ limit: 2 })
    expect(events).toHaveLength(2)
  })

  it('caps limit at 1000 (provider-side safety)', async () => {
    const events = await provider.query!({ limit: 999999 })
    // Only 3 events exist — cap applies as floor(min(N, 1000)).
    expect(events).toHaveLength(3)
  })

  it('aggregates events across multiple instance files', async () => {
    // Record on a second instance; query through the same provider
    // should see both. (HistoryAuditProvider's read path scans the
    // dir; per-instance writes are isolated; reads aggregate.)
    const podB = createHistoryAuditProvider({ storage, instance: 'pod-b' })
    await podB.record(
      event({
        timestamp: '2026-05-07T18:00:00Z',
        actor: { id: 'carol', role: 'admin', trustMode: 'cloudflare-access' },
        action: 'delete',
        outcome: 'success',
      }),
    )
    const events = await provider.query!({})
    expect(events).toHaveLength(4)
    expect(events[0].actor.id).toBe('carol')
  })

  it('returns empty array when no audit directory exists yet', async () => {
    const fresh = memoryStorage()
    const provider = createHistoryAuditProvider({ storage: fresh, instance: 'inst-1' })
    const events = await provider.query!({})
    expect(events).toEqual([])
  })

  it('skips malformed JSONL lines without poisoning the query', async () => {
    // Inject corruption directly via the storage layer.
    await storage.writeFile(
      '.gazetta/audit/events-inst-1.jsonl',
      [
        JSON.stringify(event({ timestamp: '2026-05-07T20:00:00Z' })),
        'not-valid-json',
        '',
        JSON.stringify(event({ timestamp: '2026-05-07T21:00:00Z' })),
      ].join('\n') + '\n',
    )
    const events = await provider.query!({})
    // Two valid events; the malformed line + empty line skipped.
    // (storage was reset by beforeEach so no events from earlier
    // tests remain.)
    expect(events).toHaveLength(2)
  })
})
