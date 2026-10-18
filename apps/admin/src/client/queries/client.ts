/**
 * `QueryClient` factory + `clientPersister` builder for
 * `VueQueryPlugin`. Wires the L4↔L6 cascade described in
 * `design-offline.md`'s architecture diagram:
 *
 *   Vue components → useQuery / useMutation
 *      → in-memory QueryClient (queries + mutations)
 *         → persistQueryClient (this file)
 *            → AsyncStorage adapter (storage-adapter.ts)
 *               → AdminCache (IndexedDB or memory fallback)
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns "build the QueryClient + bind the
 *     persister to it." The persister itself, the storage adapter,
 *     and the L6 cache provider are all separate concerns in
 *     sibling files.
 *   - DIP: depends on the `Persister` interface and `AdminCache`,
 *     not on either's concrete implementation.
 *   - OCP: future fine-tuning (per-query `gcTime`, default `retry`
 *     policy) belongs on the `QueryClient` config; the persister
 *     wiring stays unchanged.
 *
 * # Default `gcTime` is critical for offline mode
 *
 * Vue Query's default `gcTime` is 5 minutes — queries unused for
 * 5 minutes get garbage-collected from the in-memory cache. The
 * persister only persists what's currently in the cache, so a
 * default gcTime would mean "queries the user hasn't viewed in 5
 * minutes can't survive reload." For an offline-friendly admin we
 * push gcTime to 7 days, matching the persisted cache's maxAge, so an
 * offline cold load after a weekend still finds the site tree.
 *
 * `staleTime` stays at 0 — we WANT background refetches when the
 * user views something. Persisted data unblocks the UI; refetch
 * brings it current.
 */
import { QueryClient } from '@tanstack/vue-query'
import { persistQueryClient } from '@tanstack/query-persist-client-core'
import type { Persister } from '@tanstack/query-persist-client-core'

/** 7 days: an offline cold load after a weekend still has the site tree.
 *  Also the persisted cache's maxAge — TanStack requires gcTime ≥ maxAge. */
const OFFLINE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Build the admin's `QueryClient` with offline-friendly defaults.
 * Exported so tests can mount the same shape Vue Query sees in
 * production.
 */
export function createAdminQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: OFFLINE_RETENTION_MS,
        // staleTime: 0 — Vue Query default; queries refetch on mount
        // / focus / reconnect. Persisted data unblocks initial render
        // while the refetch lands fresh data underneath.
        // retry behavior unchanged from defaults (3 retries with
        // exponential backoff). Connection-state Pinia store will
        // pause queries via onlineManager in Cut 6.
      },
      mutations: {
        // gcTime same shape — keeps offline-queued mutations alive.
        gcTime: OFFLINE_RETENTION_MS,
      },
    },
  })
}

/**
 * Build the `clientPersister` callback that `VueQueryPlugin` invokes
 * with the resolved `QueryClient`. Returns the `[unsubscribe, restored]`
 * tuple `persistQueryClient` produces — Vue Query's plugin contract
 * passes the same shape through unchanged.
 *
 * The `buster` parameter is the cache-reset knob: when the value
 * changes between sessions, the persister discards the persisted
 * client and starts fresh. Use it to purge on Gazetta major-version
 * upgrades.
 */
export function createGazettaClientPersister(
  persister: Persister,
  buster?: string,
): (client: QueryClient) => [() => void, Promise<void>] {
  return (client: QueryClient) =>
    persistQueryClient({
      queryClient: client,
      persister,
      buster,
      maxAge: OFFLINE_RETENTION_MS,
      // Persist every query that has an answer. The default keeps only
      // `success` ones, so the first failed refresh offline (status
      // `error`, last answer still held) erased it from the stored cache.
      dehydrateOptions: { shouldDehydrateQuery: query => query.state.data !== undefined },
    })
}
