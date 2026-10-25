import { describe, expect, it } from 'vitest'
import { createMemoryCache } from '../src/cache/memory.js'
import { forSite } from '../src/cache/per-site.js'
import type { InvalidationEvent } from '../src/cache/types.js'

describe('forSite key scoping', () => {
  it('round-trips through the wrapper transparently', async () => {
    const inner = createMemoryCache()
    const cache = forSite(inner, 'main')
    await cache.set('pages:home', { title: 'Home' })
    expect(await cache.get('pages:home')).toEqual({ title: 'Home' })
  })

  it('isolates two sites sharing the same backing provider', async () => {
    const inner = createMemoryCache()
    const a = forSite(inner, 'site-a')
    const b = forSite(inner, 'site-b')
    await a.set('pages:home', 'A')
    await b.set('pages:home', 'B')
    expect(await a.get('pages:home')).toBe('A')
    expect(await b.get('pages:home')).toBe('B')
  })

  it('one site cannot read another site by guessing its key', async () => {
    const inner = createMemoryCache()
    const a = forSite(inner, 'site-a')
    const b = forSite(inner, 'site-b')
    await a.set('pages:home', 'A')
    // 'site:site-a:pages:home' is what's actually stored, but b is
    // scoped to 'site:site-b:' so the lookup goes through that prefix.
    expect(await b.get('pages:home')).toBeNull()
    expect(await b.get('site:site-a:pages:home')).toBeNull()
  })

  it('invalidatePrefix scopes to the calling site', async () => {
    const inner = createMemoryCache()
    const a = forSite(inner, 'site-a')
    const b = forSite(inner, 'site-b')
    await a.set('pages:home', 1)
    await a.set('pages:about', 2)
    await b.set('pages:home', 3) // sibling site, same consumer key
    const cleared = await a.invalidatePrefix('pages:')
    expect(cleared).toBe(2)
    // Site B's entry must survive site A's invalidation.
    expect(await b.get('pages:home')).toBe(3)
    expect(await a.get('pages:home')).toBeNull()
  })

  it('invalidate removes a single key from the calling site only', async () => {
    const inner = createMemoryCache()
    const a = forSite(inner, 'site-a')
    const b = forSite(inner, 'site-b')
    await a.set('pages:home', 1)
    await b.set('pages:home', 2)
    await a.invalidate('pages:home')
    expect(await a.get('pages:home')).toBeNull()
    expect(await b.get('pages:home')).toBe(2)
  })

  it('encodes site names with reserved characters (slash → dot)', async () => {
    const inner = createMemoryCache()
    // A site name with a slash should still scope correctly through
    // the existing encodeRefName slash-to-dot rule.
    const cache = forSite(inner, 'studio/main')
    await cache.set('k', 'v')
    expect(await cache.get('k')).toBe('v')
  })

  it('throws when siteName is empty', () => {
    const inner = createMemoryCache()
    expect(() => forSite(inner, '')).toThrow(/non-empty/)
  })

  it('stats are passed through from the inner provider', async () => {
    const inner = createMemoryCache()
    const cache = forSite(inner, 'main')
    await cache.set('k', 1)
    await cache.get('k') // hit
    await cache.get('missing') // miss
    const stats = await cache.stats?.()
    // Inner is a fresh MemoryCache — its hit/miss counts came entirely
    // from the wrapper's calls. (Stats are global to the underlying
    // provider; in shared-backing scenarios they pool across sites,
    // which is the documented behavior.)
    expect(stats?.hits).toBe(1)
    expect(stats?.misses).toBe(1)
    expect(stats?.size).toBe(1)
  })

  it('stats() strips the site prefix from lastInvalidation.prefix (#1400)', async () => {
    const inner = createMemoryCache()
    const cache = forSite(inner, 'main')
    await cache.set('pages:home', 1)
    await cache.invalidatePrefix('pages:')
    // Inner records the wrapped prefix (site:main:pages:); the
    // wrapper surfaces the consumer-facing form so the stats route
    // matches the invalidation stream and docs/cache.md.
    const stats = await cache.stats?.()
    expect(stats?.lastInvalidation?.prefix).toBe('pages:')
    expect(stats?.lastInvalidation?.source).toBe('local')
  })
})

describe('forSite subscribe filtering', () => {
  it('filters out events from other sites sharing the same provider', () => {
    // The wrapper's subscribe() handler should only fire for events
    // whose underlying key starts with this site's prefix. Cut 4
    // (SSE bridge) is what would emit cross-site events; here we
    // simulate by reaching into the inner provider's subscribe
    // mechanism via the wrapper.
    const inner = createMemoryCache()

    // Capture the inner subscribe handler so we can drive synthetic
    // events through it.
    let innerHandler: ((event: InvalidationEvent) => void) | null = null
    const wrappedInner = {
      ...inner,
      subscribe(handler: (event: InvalidationEvent) => void) {
        innerHandler = handler
        return () => {
          innerHandler = null
        }
      },
    }

    const cache = forSite(wrappedInner, 'site-a')
    const received: InvalidationEvent[] = []
    cache.subscribe(e => received.push(e))

    // Synthetic event from another site — must NOT reach the handler.
    innerHandler?.({
      prefix: 'site:site-b:pages:home',
      source: { instance: 'remote', timestamp: '2026-05-06T00:00:00Z' },
    })

    // Synthetic event from this site — must reach the handler with
    // the prefix unwrapped (consumer-facing form).
    innerHandler?.({
      prefix: 'site:site-a:pages:home',
      source: { instance: 'remote', timestamp: '2026-05-06T00:00:01Z' },
    })

    expect(received).toHaveLength(1)
    expect(received[0]?.prefix).toBe('pages:home')
  })

  it('disposer detaches the handler from the inner provider', () => {
    const inner = createMemoryCache()
    const cache = forSite(inner, 'site-a')
    const disposer = cache.subscribe(() => undefined)
    expect(() => disposer()).not.toThrow()
    expect(() => disposer()).not.toThrow() // idempotent
  })

  it('forwards consumer-facing prefix on real local invalidations (Cut 4)', async () => {
    // End-to-end: an invalidatePrefix call through the wrapper reaches
    // the inner MemoryCache (which now emits local events per Cut 4),
    // bubbles back through forSite's subscribe (which strips the
    // site:{name}: scope), and lands at the consumer subscriber with
    // the consumer-facing prefix.
    const inner = createMemoryCache()
    const cache = forSite(inner, 'main')
    const received: InvalidationEvent[] = []
    cache.subscribe(e => received.push(e))
    await cache.invalidatePrefix('pages:')
    expect(received).toHaveLength(1)
    expect(received[0]?.prefix).toBe('pages:')
  })

  it('invalidations on one site do not reach the other site', async () => {
    // Two sites sharing the inner provider — each subscribes through
    // its own forSite wrapper. Site A's invalidations must NOT fire
    // site B's subscriber (the unwrap filter rejects events whose key
    // doesn't carry site B's scope).
    const inner = createMemoryCache()
    const a = forSite(inner, 'site-a')
    const b = forSite(inner, 'site-b')
    const aEvents: InvalidationEvent[] = []
    const bEvents: InvalidationEvent[] = []
    a.subscribe(e => aEvents.push(e))
    b.subscribe(e => bEvents.push(e))
    await a.invalidatePrefix('pages:')
    expect(aEvents).toHaveLength(1)
    expect(bEvents).toHaveLength(0)
  })
})
