/**
 * Ordering tests for createHistoryProvider: the chronological sort key
 * for revision ids (timestamp, then same-millisecond sequence, then the
 * random suffix) and the retention pass that depends on it. Uses an
 * in-memory StorageProvider so we exercise the real layout logic without
 * touching disk.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createHistoryProvider } from '../src/history-provider.js'
import type { RevisionInput } from '../src/history.js'
import { type MemoryStorage, memoryStorage } from './_helpers/memory-storage.js'

function input(items: Record<string, string>, overrides: Partial<RevisionInput> = {}): RevisionInput {
  return {
    operation: 'save',
    items: new Map(Object.entries(items)),
    ...overrides,
  }
}

describe('createHistoryProvider ordering', () => {
  let storage: ReturnType<typeof memoryStorage>
  beforeEach(() => {
    storage = memoryStorage()
  })

  describe('revision id tie-breaks', () => {
    const seedManifest = async (id: string) => {
      await storage.writeFile(
        `.gazetta/history/revisions/${id}.json`,
        JSON.stringify({
          id,
          timestamp: '2023-11-14T22:13:20.000Z',
          operation: 'save',
          items: [],
          snapshot: {},
        }),
      )
    }

    it('orders same-millisecond, same-sequence revisions by their random suffix', async () => {
      // Two writers in one millisecond can land the same sequence number;
      // the random suffix is the final tie-break that keeps every
      // revision's position deterministic across processes.
      const h = createHistoryProvider({ storage })
      await seedManifest('rev-1700000000000-1-cccccccc')
      await seedManifest('rev-1700000000000-1-aaaaaaaa')
      await seedManifest('rev-1700000000000-1-bbbbbbbb')

      const list = await h.listRevisions() // newest first
      expect(list.map(r => r.id)).toEqual([
        'rev-1700000000000-1-cccccccc',
        'rev-1700000000000-1-bbbbbbbb',
        'rev-1700000000000-1-aaaaaaaa',
      ])
    })

    it('sorts legacy bare revision ids before suffixed ids of the same millisecond and sequence', async () => {
      // Legacy ids predate the suffix scheme; at the same millisecond and
      // sequence they must keep their original position ahead of
      // suffixed ids so old histories keep their established order.
      const h = createHistoryProvider({ storage })
      await seedManifest('rev-1700000000000-1-aaaaaaaa')
      await seedManifest('rev-1700000000000')

      const list = await h.listRevisions() // newest first
      expect(list.map(r => r.id)).toEqual(['rev-1700000000000-1-aaaaaaaa', 'rev-1700000000000'])
    })
  })

  describe('retention capacity boundary', () => {
    it('runs no eviction pass when the write lands exactly at the retention limit', async () => {
      // At exact capacity there is nothing to evict, so the retention
      // pass must not run at all: no extra index read, no extra listing
      // beyond the write's own bookkeeping.
      const inner = memoryStorage()
      let listings = 0
      const counting: MemoryStorage = {
        ...inner,
        readDir: async (path: string) => {
          listings += 1
          return inner.readDir(path)
        },
        dump: () => inner.dump(),
        seed: entries => inner.seed(entries),
      }
      const h = createHistoryProvider({ storage: counting, retention: 2 })

      await h.recordRevision(input({ a: '1' }))

      listings = 0
      await h.recordRevision(input({ a: '2' }))

      // The second write reaches exact capacity: three listings for the
      // write's own bookkeeping (id allocation, cache refresh, retention
      // check) and no more. A retention pass would add a fourth listing
      // for the cache rewrite it must not do.
      expect(listings).toBe(3)
      expect((await h.listRevisions()).map(r => r.id)).toHaveLength(2)
    })
  })
})
