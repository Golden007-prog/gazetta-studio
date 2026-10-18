/**
 * Integration test mirroring `main.ts`'s VueQueryPlugin install
 * flow: build a `QueryClient` + persister, get the `clientPersister`
 * callback, invoke it, and verify the documented `[unsubscribe,
 * restored]` tuple shape.
 *
 * The plugin contract requires the callback to return that tuple so
 * Vue Query can await `restored` before mounting the app and
 * dispose via `unsubscribe()` on teardown. Drift in either direction
 * would silently break offline rehydration.
 */
import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/vue-query'
import type { AdminCache, CacheStats, InvalidationEvent } from 'gazetta'
import { createAdminQueryClient, createGazettaClientPersister } from '../src/client/queries/client.js'
import { createGazettaPersister } from '../src/client/queries/persister.js'

function fakeAdminCache(): AdminCache {
  const store = new Map<string, unknown>()
  return {
    async get<T>(key: string): Promise<T | null> {
      const v = store.get(key)
      return v === undefined ? null : (v as T)
    },
    async set<T>(key: string, value: T): Promise<void> {
      store.set(key, value)
    },
    async invalidate(key: string): Promise<void> {
      store.delete(key)
    },
    async invalidatePrefix(prefix: string): Promise<number> {
      let cleared = 0
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          store.delete(key)
          cleared += 1
        }
      }
      return cleared
    },
    subscribe(_handler: (event: InvalidationEvent) => void): () => void {
      return () => {}
    },
    async stats(): Promise<CacheStats> {
      return { hits: 0, misses: 0, size: store.size, evictions: 0 }
    },
  }
}

describe('createAdminQueryClient + clientPersister wiring', () => {
  it('produces a QueryClient with offline-friendly gcTime defaults', () => {
    const client = createAdminQueryClient()
    const queryDefaults = client.getDefaultOptions().queries
    const mutationDefaults = client.getDefaultOptions().mutations
    // 24h. Verifies the offline default and pins it in case a future
    // refactor accidentally resets to Vue Query's 5-minute default.
    expect(queryDefaults?.gcTime).toBe(7 * 24 * 60 * 60 * 1000)
    expect(mutationDefaults?.gcTime).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('clientPersister returns the [unsubscribe, restored] tuple Vue Query expects', async () => {
    const cache = fakeAdminCache()
    const persister = createGazettaPersister(cache, { throttleTime: 0 })
    const clientPersister = createGazettaClientPersister(persister)
    const client = createAdminQueryClient()

    const result = clientPersister(client)
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(2)
    const [unsubscribe, restored] = result
    expect(typeof unsubscribe).toBe('function')
    expect(restored).toBeInstanceOf(Promise)
    await restored
    unsubscribe()
  })

  it('restoring a fresh client picks up data from a previously persisted session', async () => {
    const cache = fakeAdminCache()
    const persister = createGazettaPersister(cache, { throttleTime: 0 })
    const clientPersister = createGazettaClientPersister(persister)

    // First "session": populate + persist.
    const session1 = createAdminQueryClient()
    const [unsubscribe1, restored1] = clientPersister(session1)
    await restored1
    session1.setQueryData(['pages'], [{ name: 'home' }])
    // Persistence happens via cache subscriber; throttleTime 0 in
    // this test means it fires immediately on the next microtask.
    await new Promise(resolve => setTimeout(resolve, 10))
    unsubscribe1()

    // Second "session": empty client, restore from cache.
    const session2 = createAdminQueryClient()
    expect(session2.getQueryData(['pages'])).toBeUndefined()
    const [unsubscribe2, restored2] = clientPersister(session2)
    await restored2
    expect(session2.getQueryData(['pages'])).toEqual([{ name: 'home' }])
    unsubscribe2()
  })

  it.each([
    ['2 days', 2, true],
    ['8 days', 8, false],
  ])('a cache persisted %s ago is restored: %s (7-day retention)', async (_, days, kept) => {
    const cache = fakeAdminCache()
    const persister = createGazettaPersister(cache, { throttleTime: 0 })
    const clientPersister = createGazettaClientPersister(persister)
    const session1 = createAdminQueryClient()
    const [unsub1, restored1] = clientPersister(session1)
    await restored1
    session1.setQueryData(['pages'], [{ name: 'home' }])
    await new Promise(resolve => setTimeout(resolve, 10))
    unsub1()

    // Age the persisted client instead of waiting.
    const raw = await cache.get<string>('gazetta-vue-query')
    const saved = typeof raw === 'string' ? JSON.parse(raw) : raw
    saved.timestamp -= days * 24 * 60 * 60 * 1000
    await cache.set('gazetta-vue-query', typeof raw === 'string' ? JSON.stringify(saved) : saved)

    const session2 = createAdminQueryClient()
    const [unsub2, restored2] = clientPersister(session2)
    await restored2
    expect(session2.getQueryData(['pages']) !== undefined).toBe(kept)
    unsub2()
  })

  it('keeps the last answer of a query whose refresh failed (offline)', async () => {
    const cache = fakeAdminCache()
    const persister = createGazettaPersister(cache, { throttleTime: 0 })
    const clientPersister = createGazettaClientPersister(persister)
    const session1 = createAdminQueryClient()
    const [unsub1, restored1] = clientPersister(session1)
    await restored1
    session1.setQueryData(['pages'], [{ name: 'home' }])
    await session1
      .fetchQuery({
        queryKey: ['pages'],
        queryFn: () => Promise.reject(new Error('Failed to fetch')),
        retry: false,
        staleTime: 0,
      })
      .catch(() => {})
    expect(session1.getQueryState(['pages'])?.status).toBe('error')
    await new Promise(resolve => setTimeout(resolve, 10))
    unsub1()

    const session2 = createAdminQueryClient()
    const [unsub2, restored2] = clientPersister(session2)
    await restored2
    expect(session2.getQueryData(['pages'])).toEqual([{ name: 'home' }])
    unsub2()
  })

  it('buster mismatch on restore discards persisted data', async () => {
    const cache = fakeAdminCache()
    const persister = createGazettaPersister(cache, { throttleTime: 0 })

    // Save under buster=v1.
    const v1Persister = createGazettaClientPersister(persister, 'v1')
    const session1 = createAdminQueryClient()
    const [unsub1, restored1] = v1Persister(session1)
    await restored1
    session1.setQueryData(['pages'], [{ name: 'home' }])
    await new Promise(resolve => setTimeout(resolve, 10))
    unsub1()

    // Restore under buster=v2 — should NOT see the v1 data.
    const v2Persister = createGazettaClientPersister(persister, 'v2')
    const session2 = createAdminQueryClient()
    const [unsub2, restored2] = v2Persister(session2)
    await restored2
    expect(session2.getQueryData(['pages'])).toBeUndefined()
    unsub2()
  })
})
