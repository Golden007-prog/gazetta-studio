/**
 * Issue #1257: concurrent record() calls in one process must not lose
 * events. The provider's read-modify-write append races when two calls
 * overlap; the fix serializes appends per events file at module level.
 *
 * Also covers the two properties the maintainer called out on #1257:
 *   - two providers in one process writing the same events file (each
 *     createAdminApp builds its own provider) still serialize;
 *   - a failed write does not block later events, and the failing
 *     caller still gets its own error.
 */
import { mkdir, rm } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { memoryStorage } from './_helpers/memory-storage.js'
import { tempDir } from './_helpers/temp.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { createHistoryAuditProvider, type AuditEvent } from '../src/audit/index.js'
import { pruneAuditEvents } from '../src/audit/retention.js'
import type { StorageProvider } from '../src/types.js'

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

async function recordTenConcurrent(provider: ReturnType<typeof createHistoryAuditProvider>) {
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => provider.record(event({ timestamp: `2026-05-07T15:00:0${i}Z` }))),
  )
}

describe('HistoryAuditProvider - concurrent record (#1257)', () => {
  it('10 concurrent record() calls keep all 10 events (memory storage)', async () => {
    const provider = createHistoryAuditProvider({ storage: memoryStorage(), instance: 'inst-1' })
    await recordTenConcurrent(provider)
    expect(await provider.query({})).toHaveLength(10)
  })

  it('10 concurrent record() calls keep all 10 events (filesystem storage)', async () => {
    const dir = tempDir('audit-concurrency-' + Date.now())
    await mkdir(dir, { recursive: true })
    try {
      const provider = createHistoryAuditProvider({ storage: createFilesystemProvider(dir), instance: 'inst-1' })
      await recordTenConcurrent(provider)
      expect(await provider.query({})).toHaveLength(10)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('two providers writing the same events file do not lose events', async () => {
    const storage = memoryStorage()
    const a = createHistoryAuditProvider({ storage, instance: 'same' })
    const b = createHistoryAuditProvider({ storage, instance: 'same' })
    await Promise.all([
      ...Array.from({ length: 5 }, (_, i) => a.record(event({ timestamp: `2026-05-07T15:00:0${i}Z` }))),
      ...Array.from({ length: 5 }, (_, i) => b.record(event({ timestamp: `2026-05-07T15:00:1${i}Z` }))),
    ])
    expect(await a.query({})).toHaveLength(10)
  })

  it('a failed write does not block later events, and the failing caller gets its error', async () => {
    const storage = memoryStorage()
    let failOnce = true
    const flaky: StorageProvider = {
      ...storage,
      async writeFile(path: string, content: string) {
        if (failOnce) {
          failOnce = false
          throw new Error('boom')
        }
        return storage.writeFile(path, content)
      },
    }
    const provider = createHistoryAuditProvider({ storage: flaky, instance: 'inst-1' })
    await expect(provider.record(event())).rejects.toThrow('boom')
    await provider.record(event({ timestamp: '2026-05-07T15:00:01Z' }))
    expect(await provider.query({})).toHaveLength(1)
  })
})

describe('pruneAuditEvents racing record (#1414)', () => {
  it('prune + 10 concurrent record() calls keep every new event and never resurrect evicted ones', async () => {
    const path = '.gazetta/audit/events-inst-1.jsonl'
    const storage = memoryStorage()
    // Seed 5 old events; a cap of 3 evicts the 2 oldest.
    const seeded = Array.from({ length: 5 }, (_, i) => event({ timestamp: `2026-05-01T00:00:0${i}Z` }))
    storage.seed({ [path]: seeded.map(e => JSON.stringify(e)).join('\n') + '\n' })

    // Hold the pruner's first read of the events file until the
    // appends have landed, reproducing the read-modify-write gap from
    // #1414: prune reads, appends land, prune writes its stale plan.
    let holdRead = true
    let releaseRead!: () => void
    const readGate = new Promise<void>(resolve => {
      releaseRead = resolve
    })
    const gated: StorageProvider = {
      ...storage,
      async readFile(p: string) {
        const content = await storage.readFile(p)
        if (holdRead && p === path) {
          holdRead = false
          await readGate
        }
        return content
      },
    }
    const provider = createHistoryAuditProvider({ storage: gated, instance: 'inst-1' })

    const prunePromise = pruneAuditEvents(gated, { events: 3 })
    await new Promise(resolve => setImmediate(resolve))
    const appends = Promise.all(
      Array.from({ length: 10 }, (_, i) => provider.record(event({ timestamp: `2026-05-07T15:00:0${i}Z` }))),
    )
    // Give the appends their window: pre-fix they complete before the
    // pruner writes; post-fix they queue behind the pruner's rewrite.
    await new Promise(resolve => setTimeout(resolve, 20))
    releaseRead()
    await prunePromise
    await appends

    const timestamps = (await provider.query({})).map(e => e.timestamp)
    for (let i = 0; i < 10; i++) {
      expect(timestamps).toContain(`2026-05-07T15:00:0${i}Z`)
    }
    expect(timestamps).not.toContain('2026-05-01T00:00:00Z')
    expect(timestamps).not.toContain('2026-05-01T00:00:01Z')
  })
})
