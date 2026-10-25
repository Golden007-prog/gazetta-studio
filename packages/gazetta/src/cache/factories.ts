import type { AdminCache } from './types.js'
import { createMemoryCache, type MemoryCacheOptions } from './memory.js'

/**
 * Operator-facing cache provider factories. Operators import these into
 * `site.config.ts` and call them inline at the `cache:` field; the field's
 * value IS the constructed `AdminCache` instance (Path X — see
 * `design-provider-config.md`).
 *
 * `gazetta.config.ts defaults.cache` follows the same rule: its value
 * IS the constructed `AdminCache` instance (call `memoryCache({...})`
 * inline there too). Inheriting sites share that instance per process
 * (single-Site-per-process invariant — each process re-evaluates
 * `gazetta.config.ts` and gets its own fresh instance), and the
 * per-site wrapper still isolates keys by site name (`design-cache.md`
 * Gap 3).
 */

/** In-process LRU cache. Default 10K entries / 50MB approximate cap. */
export function memoryCache(opts: MemoryCacheOptions = {}): AdminCache {
  return createMemoryCache(opts)
}

export type { MemoryCacheOptions }
