# Cache

How Gazetta caches admin reads — what the default does, when to swap
providers, and how to monitor cache health.

For the design model and `AdminCache` interface contract, see
[`.claude/rules/design-cache.md`](../.claude/rules/design-cache.md).

## What's cached

The admin server caches summary listings that are expensive to recompute
on every request:

| Surface | Cache key | Invalidated on |
|---|---|---|
| `GET /api/pages` summary | `pages:summary` | page save / delete / fragment edit / history restore |
| `GET /api/fragments` summary | `fragments:summary` | fragment save / delete / history restore |

Detail endpoints (`GET /api/pages/:name`, `GET /api/fragments/:name`)
read from disk per request — caching them adds invalidation surface
without much speedup.

## Default: `MemoryCache`

If you don't declare a cache, Gazetta uses an in-process `MemoryCache`
with these defaults:

| Knob | Default | Tunable via |
|---|---|---|
| Max entries | 10,000 | `memoryCache({ maxEntries: N })` |
| Approximate max bytes | 50 MB | `memoryCache({ maxBytes: N })` |
| Eviction | LRU on overflow | not tunable |
| TTL | none (LRU-only) | `set(..., { ttl })` accepted but ignored in v1 |

This is the right choice for single-process deployments
(`gazetta dev`, `gazetta serve`, single-container hosts). Keys live in
RAM; nothing to install.

```ts
// site.config.ts
import { defineSite, memoryCache } from 'gazetta'

export default defineSite({
  // Optional — `MemoryCache()` is the implicit default.
  cache: memoryCache({ maxEntries: 5000 }),
  // ... rest of config
})
```

A project can set a shared default in `gazetta.config.ts` instead:
every site without its own `cache:` inherits `defaults.cache` (a
site-level `cache:` always wins). Each process re-evaluates
`gazetta.config.ts` and gets its own instance.

```ts
// gazetta.config.ts
import { defineGazetta, memoryCache } from 'gazetta'

export default defineGazetta({
  defaults: {
    cache: memoryCache({ maxEntries: 5000 }),
  },
})
```

## Multi-instance deployments

Most v1 deployments are single-instance: `gazetta serve` on one VPS,
one Cloud Run revision with min-instances=1, one container. With
sticky sessions enabled (Cloud Run's default, Kubernetes
`sessionAffinity: ClientIP`), a multi-instance setup is also fine —
each author's browser sticks to one admin instance for the editing
session, and that instance's cache stays consistent with their saves.

### Without sticky sessions

A round-robin load balancer in front of N admin instances creates a
correctness gap. Concretely:

1. Author saves a page. Request lands on instance A.
2. A invalidates A's `MemoryCache` and broadcasts the invalidation
   to browsers connected to A via SSE (see "Subscribing to
   invalidations" below).
3. Author refreshes. Request lands on instance B.
4. B's `MemoryCache` still holds the stale `pages:summary`. B serves
   stale.
5. The stale entry stays until B's LRU evicts it (capacity pressure)
   or B restarts.

With v1 ('s `MemoryCache` provider), there's no server-to-server
coordination — invalidations on A don't reach B's cache. **For low-
write CMS workloads, that means hours of staleness on the silent
instance is possible.** Mitigations, ranked by what operators
typically do:

| Mitigation | Tradeoff |
|---|---|
| **Configure sticky sessions** | Standard answer; supported by every major load balancer. The author always hits the same instance during their editing session. |
| **Run a single instance** | Simplest. Works at the documented operating envelope (~5000 pages). |
| **Disable the cache** | Pass `cache: memoryCache({ maxEntries: 0 })` to bypass — every read recomputes from disk. Correct, slower. Last resort. |

A shared backing provider (RedisCache) reserved for v2. The
`AdminCache.subscribe()` contract is already shaped for it — Redis
pub/sub fans out invalidations across instances; consumers don't
change. Ships when concrete operator demand surfaces.

## Per-site key isolation

Every cache instance is wrapped per-site — keys transparently get a
`site:{name}:` prefix before reaching the underlying provider. Two
sites sharing a backing service (future Redis cluster) don't collide
on `pages:summary`.

You don't write the prefix yourself; the wrapping happens at admin
boot. Plugin authors writing custom providers see only the wrapped
keys.

## Monitoring

### On-demand snapshot

```
GET /api/system/cache/stats
```

Returns the current cache stats for the resolved source. Honors
`?target=...` like every other admin route — different targets have
different caches.

```json
{
  "hits": 142,
  "misses": 17,
  "size": 8,
  "instance": "pod-abc-123",
  "evictions": 0,
  "bytesApproximate": 1834,
  "lastInvalidation": {
    "prefix": "pages:",
    "at": "2026-05-06T11:42:00.000Z",
    "source": "local"
  }
}
```

`hits` / `misses` / `size` are guaranteed by the contract. Optional
fields (including `instance`) surface when the underlying provider
tracks them.

`lastInvalidation.prefix` is the consumer-facing prefix (`pages:`),
matching the invalidation stream. Only `invalidatePrefix` updates the
field; single-key `invalidate(key)` calls don't.

The `instance` field is critical in multi-instance deployments: with
a round-robin load balancer, two consecutive `curl` calls to this
endpoint may hit different pods and return different counter values.
Read `instance` to know which pod answered.

### Periodic structured log

The admin process emits a structured log entry every 5 minutes:

```json
{
  "timestamp": "2026-05-06T11:45:00.000Z",
  "level": "info",
  "module": "cache.stats",
  "instance": "pod-abc-123",
  "message": "cache stats",
  "stats": { "hits": 142, "misses": 17, "size": 8, "instance": "pod-abc-123", ... }
}
```

`instance` is hoisted to a top-level field so log aggregators can
filter on `module:cache.* AND instance:pod-abc-123` to see one pod's
behavior in isolation.

Pipe stdout to your log aggregator (Datadog, Loki, journalctl) and
filter on `module:cache.stats`. Cadence isn't tunable; operators with
stricter monitoring polls `/api/system/cache/stats` directly.

To suppress the periodic log entirely (e.g., in development), pass
`disableCacheStatsLogger: true` to `createAdminApp()`. The stats
endpoint still works.

## Subscribing to invalidations

The admin server exposes a Server-Sent Events stream of cache
invalidations:

```
GET /api/system/cache/invalidations
```

The stream sends one `event: ready` frame on connection, then one
`event: invalidation` frame per cache invalidation thereafter.
Browsers subscribe via `EventSource`; the canonical consumer is the
browser-side L6 cache (when offline mode ships) which uses these
events to invalidate its own IndexedDB-backed entries.

Frame shape:

```
event: invalidation
data: {"prefix":"pages:","source":{"instance":"pod-abc-123","timestamp":"2026-05-06T11:42:00.000Z"}}
```

`prefix` is consumer-facing (the form passed to `cache.invalidatePrefix`,
not the internal storage form). `source.instance` identifies which
admin pod fired the event.

### Scope: server-to-browser only in v1

The stream covers invalidations on whichever instance the browser is
connected to. With v1's `MemoryCache` provider, there's no server-to-
server fan-out: invalidations on instance A don't reach browsers
connected to instance B. See "Without sticky sessions" above.

When `RedisCache` (or any shared-backing provider) ships, its
`subscribe()` delivers cross-instance events via Redis pub/sub. The
SSE endpoint doesn't change; the provider handles fan-out.

### Reconnect: clients must reset their cache

The stream doesn't emit event IDs. If a client's connection drops
and reconnects, the server has no way to replay missed events — the
client must treat reconnect as "I may have missed any invalidation
that happened during the gap" and reset its own cache state.

Per [`design-offline.md`](../.claude/rules/design-offline.md)'s
reconnect strategy: full local cache reset on reconnect. Cache
divergence during disconnected windows is hard to detect surgically;
full reset is the simplest correctness mechanism.

## Plugin-contributed providers

Per [`design-cache.md`](../.claude/rules/design-cache.md) plugin-promotion
rules, providers like Redis and Azure Cache will ship in-tree when
3+ operators ask. Until then, plugin authors export a factory that
returns an `AdminCache`:

```ts
// In @example/redis-cache
import type { AdminCache } from 'gazetta'

export function redisCache(opts: { url: string }): AdminCache {
  // ... build a provider satisfying AdminCache
}
```

Operators import and invoke directly:

```ts
import { defineSite } from 'gazetta'
import { redisCache } from '@example/redis-cache'

export default defineSite({
  cache: redisCache({ url: process.env.REDIS_URL! }),
})
```

### Validating a custom provider

Plugin authors run the contract test helper to confirm baseline LSP
correctness:

```ts
// In your provider's test suite
import { describe } from 'vitest'
import { adminCacheContractTests } from 'gazetta/testing'
import { redisCache } from '../src'

describe('redisCache satisfies the AdminCache contract', () => {
  adminCacheContractTests(
    () => redisCache({ url: 'redis://localhost:6379/15' }),
    {
      supportsTtl: true,
      supportsCrossInstanceSubscribe: true,
      supportsTransportFailureSimulation: true,
    },
  )
})
```

The capability flags gate the optional test blocks. Providers that
don't honor TTL leave `supportsTtl` false; the suite skips the TTL
test cleanly.

## Cached values must be JSON-serializable

The `AdminCache` contract requires JSON-serializable values — no
functions, no Symbols, no top-level Maps or Sets. This holds across
all providers (in-process and shared) so that future browser-side
caches (`IndexedDBCache`, etc.) can persist the same entries from the
same consumer code.

If you're caching something that isn't naturally serializable, do the
serialization in the consumer.
