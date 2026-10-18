/**
 * Read an admin API answer through the query cache, so it is there
 * when the next cold load happens offline (design-offline.md, "The site
 * tree reads through the query cache").
 *
 *   offline + cached          → the cached answer, without trying the network
 *   otherwise                 → fetch fresh; it becomes the cached answer
 *   fetch fails + cached      → the cached answer (when `allowCache` permits)
 *   fetch fails, no cache     → the error, as before
 *
 * `main.ts` registers the query client once. Until then — and in unit
 * tests that don't register one — this just calls `fetch`.
 */
import type { QueryClient, QueryKey } from '@tanstack/vue-query'

export interface ReadThroughDeps {
  client: QueryClient
  /** Settles when the persisted cache has been restored (or found unusable). */
  restored: Promise<void>
  /** True when the connection store says the server is unreachable. */
  isOffline: () => boolean
}

let deps: ReadThroughDeps | null = null

export function configureReadThrough(next: ReadThroughDeps | null): void {
  deps = next
}

export interface ReadThroughOptions {
  /**
   * Whether a failed fetch may fall back to the cached answer. Callers
   * that retry pass false until their last attempt, so a cached answer
   * doesn't cut a retry loop short while online.
   */
  allowCache?: boolean
}

export async function readThrough<T>(
  key: QueryKey,
  fetch: () => Promise<T>,
  opts: ReadThroughOptions = {},
): Promise<T> {
  if (!deps) return fetch()
  const { client } = deps
  await deps.restored
  const cached = client.getQueryData<T>(key)
  if (cached !== undefined && deps.isOffline()) return cached
  try {
    // networkMode 'always': the connection store drives onlineManager, and in
    // the default mode this fetch would pause forever offline instead of failing.
    return await client.fetchQuery({ queryKey: key, queryFn: fetch, networkMode: 'always', retry: false, staleTime: 0 })
  } catch (err) {
    if (cached !== undefined && (opts.allowCache ?? true)) return cached
    throw err
  }
}

/** The cached answer for a key, after the restore — or undefined. For callers that give up on their own. */
export async function readCached<T>(key: QueryKey): Promise<T | undefined> {
  if (!deps) return undefined
  await deps.restored
  return deps.client.getQueryData<T>(key)
}
