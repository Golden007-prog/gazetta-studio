/**
 * Per-site cache scoping per `design-cache.md` Gap 3.
 *
 * Wraps an `AdminCache` instance with a site-name prefix on every
 * key. Two motivations:
 *
 *   1. **Future shared backing services** (Redis, Azure cache when
 *      they ship) — a single Redis cluster shared across N Site
 *      processes needs key isolation so site A's cache writes don't
 *      collide with site B's. Per-site key prefix solves this at the
 *      wrapper layer; the backing provider is unaware.
 *
 *   2. **Multi-site deployments evolving over time** — pre-1.0
 *      Gazetta locks single-Site-per-process, so today there's no
 *      collision risk in-process. But a future configuration could
 *      legitimately host two Sites in one process; `forSite` makes
 *      that change additive.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns "scope an AdminCache to a site name."
 *     Provider mechanics live in `memory.ts`; key encoding lives in
 *     `keys.ts`. Three concerns, three files.
 *   - OCP: a future `forPlugin(cache, pluginName)` wrapper composes
 *     identically; no change to consumers.
 *   - LSP: `forSite(cache, name)` returns an `AdminCache`. Any
 *     caller depending on the interface keeps working.
 *   - ISP: consumers see `AdminCache`, never the wrapping mechanism.
 *   - DIP: `loadSite()` wraps once at construction; consumers depend
 *     on `site.cache: AdminCache`.
 */
import { encodeRefName } from '../hash.js'
import type { AdminCache, CacheStats, InvalidationEvent } from './types.js'

/**
 * Reserved prefix for the per-site key namespace. Documented as
 * a built-in per `design-cache.md` Q1's "Reserved prefixes" rule —
 * plugins must not write keys under `site:`.
 */
const SITE_NAMESPACE = 'site'

/**
 * Wrap an `AdminCache` with per-site key scoping. Every key written,
 * read, or invalidated through the returned cache is transparently
 * prefixed with `site:{encoded-name}:`.
 *
 * Examples (with siteName = 'main'):
 *   inner.set('site:main:pages:home', value)  ← stored
 *   wrapped.set('pages:home', value)          ← what consumers see
 *
 * Prefix invalidation works through the wrapping uniformly:
 *   wrapped.invalidatePrefix('pages:')        ← consumer call
 *   inner.invalidatePrefix('site:main:pages:') ← actual mechanism
 *
 * The `subscribe()` handler receives events with the unwrapped
 * (consumer-facing) prefix. Events for OTHER sites' invalidations
 * reaching the same backing service are filtered out (they have a
 * different `site:{other}:` prefix); cross-site events would be a
 * leak otherwise.
 */
export function forSite(inner: AdminCache, siteName: string): AdminCache {
  if (!siteName) {
    throw new Error('forSite: siteName must be a non-empty string')
  }
  const encodedName = encodeRefName(siteName)
  const sitePrefix = `${SITE_NAMESPACE}:${encodedName}:`

  function wrap(key: string): string {
    return `${sitePrefix}${key}`
  }

  /**
   * Strip the `site:{name}:` prefix from a stored key for handoff to
   * a consumer subscriber. Returns null when the key isn't owned by
   * this site (shared backing service receiving another site's event).
   */
  function unwrap(key: string): string | null {
    if (!key.startsWith(sitePrefix)) return null
    return key.slice(sitePrefix.length)
  }

  return {
    async get<T>(key: string): Promise<T | null> {
      return inner.get<T>(wrap(key))
    },

    async set<T>(key: string, value: T, opts?: { ttl?: number }): Promise<void> {
      return inner.set(wrap(key), value, opts)
    },

    async invalidate(key: string): Promise<void> {
      return inner.invalidate(wrap(key))
    },

    async invalidatePrefix(prefix: string): Promise<number> {
      return inner.invalidatePrefix(wrap(prefix))
    },

    subscribe(handler: (event: InvalidationEvent) => void): () => void {
      // Forward only events that belong to this site; rewrite the
      // prefix to the consumer-facing form before firing the handler.
      return inner.subscribe(event => {
        const unwrapped = unwrap(event.prefix)
        if (unwrapped === null) return
        handler({ ...event, prefix: unwrapped })
      })
    },

    async stats(): Promise<CacheStats> {
      // Stats are global to the underlying provider — there's no
      // honest way to slice them per-site without scanning every
      // entry, which defeats the cache. Surface the inner stats;
      // operators interpret them with the knowledge that shared
      // backing services pool stats across all sites.
      const innerStats = inner.stats
      if (!innerStats) {
        return { hits: 0, misses: 0, size: 0 }
      }
      const stats = await innerStats.call(inner)
      // The inner provider records lastInvalidation.prefix in its
      // own (wrapped) terms. Strip the site prefix so the stats
      // route and the invalidation stream show the same
      // consumer-facing prefix (#1400).
      if (stats.lastInvalidation) {
        const unwrapped = unwrap(stats.lastInvalidation.prefix)
        if (unwrapped !== null) {
          return {
            ...stats,
            lastInvalidation: { ...stats.lastInvalidation, prefix: unwrapped },
          }
        }
      }
      return stats
    },
  }
}
