---
paths:
  - "packages/gazetta/src/admin-api/**"
  - "packages/gazetta/src/cache/**"
  - "**/cache*"
---

# Cache

Foundational dimension #11 of 13. Pluggable caching layer at the admin / origin server tier (L4 in the layered cache model). v1 ships `MemoryCache` only; abstraction in place so multi-instance deployments can swap providers without changing consumers.

**Status**: design pass complete (2026-05); implementation shipped 2026-05 (`MemoryCache`, per-site keys, SSE invalidation, stats; [`design-cache-implementation.md`](design-cache-implementation.md)). Other cache providers are demand-driven.

**Companion docs**:
- [`feature-design-process.md`](feature-design-process.md) — defines the **Cache check** every new feature design must answer
- [`design-plugins.md`](design-plugins.md) — sibling extension-surface design; cache providers are one of the named surfaces
- [`design-scale.md`](design-scale.md) — first major consumer (`/api/pages`, `/api/fragments`, `/api/dependents`)

## Why this is foundational

Caching is foundational because:

1. **It's load-bearing for performance.** Several primitives at scale (admin's `/api/pages`, `/api/fragments`, fragment-resolution, future filtered listings) need caching to hold the latency SLA. Caching ad-hoc per-feature creates inconsistent semantics + invalidation bugs.

2. **Multi-instance correctness depends on the cache shape.** A per-instance in-memory cache is fine for single-process deployments; a multi-instance deployment needs a shared cache provider (Redis, Azure storage, distributed cache) OR explicit per-instance scope with carefully designed invalidation. Getting this wrong silently corrupts state — exactly the class of bug the multi-instance discipline exists to prevent.

3. **It's an extension surface.** Operators choose memory vs. Redis vs. Azure vs. file-based per their deployment shape. Same pattern as storage providers, AI providers, transform adapters — pluggable behind one interface.

## Layered cache model (zoomed-out context)

Caching in Gazetta happens at multiple layers. This design pass scopes ONLY to L4. Other layers governed by their own design passes:

| Layer | Strategy | Owned by |
|---|---|---|
| L1: Browser HTTP | Content-addressed immutable URLs | `design-media.md`, `design-rendering.md` |
| L2: CDN edge | Content-addressed immutable; skip dynamic | `design-rendering.md` Q1 |
| L3: Worker memory + edge KV | Per-worker memory + content-addressed reads | `design-rendering.md` Q1 |
| **L4: Admin/Origin server** | **Deterministic-derived memoization (this design pass)** | **`design-cache.md` (this doc)** |
| L5: Storage sidecars | Per-edge content-addressed sidecars | `sidecars.md` |
| L6: Browser admin | Persistent client-side; SSE-invalidated | `design-offline.md` (pending) — extends `AdminCache` taxonomy |

L4 is where `AdminCache` lives. L6 reuses the `AdminCache` interface for taxonomy reuse but coordinates independently.

## Locked invariants

### Inherited from prior thinking
- **`AdminCache` is the abstraction at L4** — features that cache data at the admin server tier go through it; no ad-hoc memos in feature code.
- **Provider-pluggable** — `MemoryCache` ships as v1 default; Redis, Azure storage, file-based, distributed providers slot in via the same interface (Universal Provider Requirements per `design-plugins.md`).
- **Multi-instance discipline holds**:
  - `MemoryCache` is per-instance scope (multi-instance-correct via independence; eventual consistency across instances acceptable because each receives SSE invalidation for its own writes).
  - Shared providers (Redis, Azure) are multi-instance-correct via the provider's own coordination.
  - In-process caches OUTSIDE `AdminCache` are governed by the existing multi-instance discipline: scoped to one operation (per-build, per-request) only.
- **Storage-as-cache is allowed.** A cache provider can use the existing `StorageProvider` abstraction (e.g., `FileCache` writes to `.gazetta/cache/`). Atomic write-then-rename per the provider contract.

### Locked in this design pass

**Deterministic-derived principle (Q2 lock):**

> **Cache values must be derivable from inputs encoded in the key.** Two instances computing the same key produce the same value. Concurrent writes are idempotent. Read-modify-write patterns are not supported in v1.

This pushes the discipline to cache CONSUMERS (write deterministic functions of inputs), not the cache provider. Multi-instance correctness on shared providers (v2) follows naturally — two instances writing the same key write the same value, so last-write-wins is a no-op.

**Why not etag-based optimistic concurrency in v1**: enumerated v1 consumers (page summaries, fragment summaries, dependents, render-for-analysis, page query cache) are all read-only with explicit invalidation. Zero v1 consumers do read-modify-write on cache. Etag interface ships when first concrete RMW consumer surfaces (warming hooks future) as `EtagCapableCache extends AdminCache` — additive, not breaking.

**Cache invalidation: explicit per-feature with sidecar-driven cascades (Q2 lock):**

- Save handlers explicitly enumerate affected cache prefixes (`cache.invalidatePrefix('pages:')`)
- Cross-cutting cascades use existing sidecar machinery (`findDependentsFromSidecars` for fragment→page dependencies)
- TTL is fallback safety net, not primary invalidation mechanism

**Generic dependency-aware invalidation rejected**: tracking dependencies in the cache layer requires reverse-dep graphs that must be coordinated across instances OR rebuilt per-instance (which defeats the cache). Sidecars already solve this at L5 — explicit per-feature invalidation at L4 reads sidecars to compute the affected set, no cache-layer dep graph needed.

**Subscribe contract — events from any source (Q2 lock + Cut 4 evolution):**

`subscribe(handler)` fires on **every** invalidation regardless of origin: local invalidations on this provider AND cross-instance invalidations delivered via the provider's coordination mechanism. Subscribers discriminate via `event.source.instance` if they only care about cross-instance events.

The original Q2 framing was "events from OTHER instances" with single-instance providers as honest no-ops. Cut 4 implementation surfaced that the L4→L6 server-to-browser cascade is the load-bearing consumer: from the browser's POV the server IS another instance, so the right contract is "events from any source." Locking that as the contract avoids two coexisting subscribe semantics across providers.

Per provider:
- `MemoryCache` — emits on every local invalidation (Cut 4); cross-instance events arrive via SSE bridge when a peer subscriber exists (future Redis or browser admin)
- `RedisCache` — Redis pub/sub fans out to all subscribers including the local one; same "any source" semantics
- `AzureCache` — Azure Service Bus or Redis pub/sub; same shape

Save flow: write manifest → write sidecars → invalidate L4 entries → subscribers fire (local SSE bridge forwards to browsers; future shared-backing providers fan out to peer instances) → connected browsers invalidate L6.

**Best-effort invalidation atomicity** (Q2 lock):

Cache invalidation is fail-open per Universal Provider Requirement #5. Failed invalidation = stale cache entry → next read serves stale → TTL or next-invalidation-cycle catches it. Atomicity across N invalidations isn't possible in distributed systems anyway.

**Key conventions (Q1 lock):**

- **Format**: colon-separated `{domain}:{op}:{id?}:{dim1}:{dim2}...`
- **Compound keys**: concatenated values (not hashed) — preserves prefix-invalidation; human-readable in logs
- **Special-char encoding**: same as sidecars (`encodeRefName` from `hash.ts`; slashes → dots)
- **Reserved prefixes**: built-ins (`pages:`, `fragments:`, `assets:`, `dependents:`, `targets:`, `routes:`, `audit:`, `review:`, `history:`, `config:`); plugin-contributed under plugin name (`{plugin-name}:...`)
- **Schema versioning**: automatic Gazetta-major-version prefix applied by the cache layer (consumer sees `pages:summary`; provider stores `1:pages:summary` where `1` is from `gazetta.version.major`)

### Offline composition (L4 + L6)

L4 (admin server `AdminCache`) and L6 (browser admin's `IndexedDBCache` / `LocalStorageCache` per `design-offline.md`) share the `AdminCache` interface but coordinate independently. L6 reuses the interface so the same consumer code works whether reading from server cache or browser cache.

- **Cached values MUST be JSON-serializable.** No functions, no Symbols, no Maps/Sets at top level. Required so L6 can persist values to IndexedDB/localStorage. Documented as a v1 contract.
- **L4 → L6 invalidation cascade.** Server-side L4 invalidation triggers SSE broadcast. Browser-side `AdminCache` providers subscribe to the SSE channel and invalidate L6 entries in response. `subscribe()` method on `AdminCache` is the coordination primitive.
- **Principal scoping is consumer's responsibility.** Cache keys for principal-scoped values include role/principal identity in the key (e.g., `pages:summary:role:editor`); shared values omit it. Role change invalidates by prefix (`cache.invalidatePrefix('pages:summary:role:editor:')`). Per `design-auth-rbac.md`'s Foundational checks ("Cached entries scoped to the role principal at cache time").
- **L6 stale-tolerance vs L4 freshness**: L6 explicitly tolerates staleness when server unreachable (offline mode); L4 does not. Different freshness contracts on the same interface — consumer can try L6 first, fall through to L4 if L6 entry is empty/stale or if the consumer is online.

L6 provider details (`IndexedDBCache`, `LocalStorageCache`, browser-tab scoping, IndexedDB transactions) are `design-offline.md`'s concern. This design pass commits only that:
- L6 providers implement `AdminCache`
- L4 + L6 share the interface
- Cached values are JSON-serializable
- Principal scoping encoded in key by consumer

## AdminCache interface (v1 locked)

```ts
export interface AdminCache {
  /** Get cached value or null on miss. */
  get<T>(key: string): Promise<T | null>
  /** Set value with optional TTL (seconds). Provider may ignore TTL if it doesn't support expiry. */
  set<T>(key: string, value: T, opts?: { ttl?: number }): Promise<void>
  /** Invalidate one key. */
  invalidate(key: string): Promise<void>
  /** Invalidate all keys matching a prefix. Returns count cleared. */
  invalidatePrefix(prefix: string): Promise<number>
  /**
   * Subscribe to invalidation events from any source — local
   * invalidations on this provider AND cross-instance invalidations
   * delivered via the provider's coordination mechanism. Returns
   * disposer. Discriminate via `event.source.instance`.
   */
  subscribe(handler: (event: InvalidationEvent) => void): () => void
  /** Stats for diagnostics — hit rate, size, age distribution. Optional. */
  stats?(): Promise<CacheStats>
}

export interface InvalidationEvent {
  prefix: string
  source: { instance: string; timestamp: string }
}

export interface CacheStats {
  hits: number
  misses: number
  size: number
  /** Identity of the reporting instance — same value as InvalidationEvent.source.instance. */
  instance?: string
  // Provider-specific extras allowed
}
```

**Reserved for v2** — `EtagCapableCache extends AdminCache` adds `getWithEtag` + `setIfMatch` for read-modify-write consumers (warming hooks, derived counters). Ships when first concrete RMW consumer surfaces; additive interface; existing providers + consumers unaffected.

## PWA-style responsiveness principle

The admin UI should never block the user on cache operations. Cache supports progressive web app patterns:

- **Optimistic UI**: UI renders changes immediately; cache + storage sync in background
- **Stale-while-revalidate reads**: consumer returns cached value instantly, recomputes in background, updates UI when fresh value lands
- **Background sync**: writes queued offline, replayed transparently on reconnect (per `design-offline.md`)
- **Skeleton states**: UI never blank; cache provides last-known value while fresh recomputation runs

Cache layer doesn't add SWR or optimistic-update primitives — these are consumer-implemented patterns. The `AdminCache` interface stays minimal; consumers compose the patterns.

**Operation latency contract** (v1):
- `get` / `set`: microseconds (`MemoryCache`) or single-round-trip (~1-5ms on Redis/Azure). No cap needed.
- `invalidate(key)`: single-key delete; bounded by provider primitive.
- `invalidatePrefix(prefix)`: **best-effort with time cap (~100ms default; configurable per-provider).** Save handlers don't wait beyond the cap; un-cleared entries clear on next save's invalidation OR at TTL OR via next SSE broadcast. Locked invariant: cache invalidation never blocks the response beyond the cap.
- `subscribe`: returns immediately; handler invocations happen on the provider's event loop.

**Why best-effort `invalidatePrefix`**: at envelope (~5K pages), `invalidatePrefix('pages:')` could touch thousands of keys. Synchronous full-clear blocks the save response. Best-effort with cap matches PWA responsiveness — save returns fast; cache catches up via TTL or next event.

## TTL strategy (Q3 locked)

- **No default TTL.** `set()` without explicit `ttl` keeps value until explicit invalidation. Reinforces the locked invariant that invalidation is explicit, not TTL-driven. Default-1h TTL would mask wrong invalidation logic for an hour before self-correcting — a hostile bug pattern (works in test, fails in prod after window).
- **Explicit TTL accepted** when consumers have a real reason: AI suggestion caches bound by external API rate limits + cost, for example, set `{ ttl: 86400 }` to cache for 24h.
- **Provider implements lazy expiry**: `MemoryCache` checks timestamp on read; expired entries removed and treated as cache miss. No setTimeout overhead. Redis/Azure use native expiry.
- **No maximum TTL bound.** Consumers set what they need; operators monitor cache health via `stats()`.
- **Provider may ignore TTL if unsupported** per the existing locked invariant; documented per-provider.

## Gap-fill locks

Walking systematic gap analysis surfaced six concerns; locking each:

### Gap 1 — `MemoryCache` size limits + eviction

- **Default cap**: 10,000 entries OR 50MB (whichever hits first)
- **Eviction policy**: LRU on overflow
- **Operator overrides**: `admin.cache.memory.maxEntries` / `admin.cache.memory.maxBytes`
- **Stats track evictions count**; operators monitor for cap-hit pattern
- **Shared providers** (Redis, Azure): provider's responsibility (e.g., Redis `maxmemory` config); Gazetta doesn't enforce

### Gap 2 — Key length limit

- **Cap at 255 chars** (filesystem-provider compatibility)
- **Overflow portion hashed** (sha256 prefix); preserves prefix-invalidation when prefix < cap
- **Cache layer applies transparently**; consumers see clean keys

Example:
- Consumer key: `pages:detail:very-long-page-name:en:light:role:editor:p:abc123` (300+ chars)
- Provider stores: `pages:detail:very-long-page-name:en:light:role:editor:p:{sha256(rest).slice(0,8)}` (capped at 255)
- Prefix invalidation on `pages:detail:very-long-page-name:` still works

### Gap 3 — Single-Site-per-process invariant

Per the locked invariant in [`CONTEXT.md`](../../CONTEXT.md): each Gazetta runtime invocation loads exactly one Site. Multi-Site Projects exist as a layout concern (operator picks one Site per command), not a runtime concern.

- **Per-process `AdminCache` instance**: one Site per process means one cache per process; isolation is automatic via process boundaries
- **`gazetta.config.ts defaults.cache`**: accepts a constructed `AdminCache` instance (operator writes `defaults: { cache: memoryCache({...}) }`). Each process re-evaluates `gazetta.config.ts` and gets a fresh instance; no cross-Site sharing concern exists in-process because there are no other Sites in-process
- **Shared-provider implementations** (Redis, Azure, future): the operator's deployment runs N Site processes, each connecting to the same Redis as one logical cache. Each process's local in-memory adapter wraps the shared backing service; no per-Site key prefixing required (Site identity is enforced at the process boundary)
- **Cross-Site cache sharing across processes**: not a Gazetta concern. Two Site processes that happen to share Redis credentials get separate logical caches because each process keys against its own Site's content paths; collision requires intentional operator misconfiguration

### Gap 4 — Boot-time subscribe behavior

- **Default: boot, subscribe in background** (matches PWA responsiveness principle)
- During the unsubscribed window, cache continues serving from existing entries; transparent to consumers
- **Strict-mode opt-in**: `admin.cache.requireSubscribeOnBoot: true` blocks boot until subscribe established (with timeout); for compliance/regulated contexts where eventual consistency during the window is unacceptable
- **Subscribe failure during boot** (with default): provider auto-reconnects with backoff (per Q4 lock); admin serves; operators see warning logs

### Gap 5 — `CacheError` taxonomy

```ts
export class CacheError extends Error { /* base */ }

export class CacheConfigurationError extends CacheError {
  // Thrown at admin boot when config is invalid (missing env var,
  // malformed connection string, etc.). Admin won't start.
}

export class CacheSchemaError extends CacheError {
  // Thrown when a stored value can't be deserialized.
  // Rare; logs + returns null typically.
}
```

Throws reserved for unrecoverable infrastructure errors per Universal Provider Requirement #6. Transport / network errors fail-open (no throw); structured logs only. Same pattern as `StorageError`, `AuditError`, etc.

### Gap 6 — Target dimension in keys

- **Target is a first-class dimension in cache keys when value is target-scoped**:
  ```
  pages:summary:target:production
  pages:summary:target:staging
  fragments:detail:header:target:production
  ```
- **Convention**: target dimension as `:target:{name}` in compound keys
- Pages/fragments lookups always include target dimension (target-scoped by design — different targets can have different content per `design-publishing.md`)
- Genuinely target-agnostic data (user role mappings, site config snapshot) omits target dimension
- Consumer responsibility (Q1 already locked compound keys as concatenated values)

## Fallback behavior (Q4 locked)

All cache operations fail-open per Universal Provider Requirement #5. Aligns with PWA responsiveness principle — UI shows last-known value rather than error.

| Operation | On transport / provider failure |
|---|---|
| `get(key)` | Returns null (indistinguishable from cache miss to consumers); structured warning logged |
| `set(key, value)` | Always resolves; transport failures logged; no throw per Universal Provider Requirement #6 |
| `invalidate(key)` | Logs + falls through; TTL is the safety net |
| `invalidatePrefix(prefix)` | Best-effort within time cap (per PWA section); failures logged; fall through |
| `subscribe(handler)` | Auto-reconnects with backoff on connection drop |

**`subscribe` reconnect strategy**: full local cache reset on reconnect. Cache divergence during disconnected window is hard to detect surgically; full reset is the simplest correctness mechanism. L4 cache warmup is fast (recompute from storage). Operators monitor reconnect frequency via stats; frequent disconnects = network problem to fix.

**Permanent provider unavailability** (e.g., Redis configured but service permanently down): admin continues serving from source-of-truth. All operations fail-open. Operators see warning logs + cache hit-rate at 0 in stats. Gazetta does NOT auto-fall-back to a different provider — that would be magic; operator's monitoring catches the issue and they fix the underlying problem.

## Observability (Q5 locked)

**`CacheStats` shape** — required fields + optional richer fields:

```ts
interface CacheStats {
  hits: number
  misses: number
  size: number               // entry count
  errors: number             // transport failures since last reset
  instance?: string          // identity of the reporting instance
  // Optional richer fields (provider-supported)
  bytesApproximate?: number
  evictions?: number
  subscribeReconnects?: number
  oldestEntryAt?: string     // ISO timestamp
  lastInvalidation?: { prefix: string; at: string; source: string }
}
```

**Surfaces**:

| Surface | Audience | Purpose |
|---|---|---|
| **Structured log every 5 minutes** | Ops engineers via existing log channel | Integrates with Datadog / New Relic / Splunk monitoring |
| **`GET /api/system/cache/stats`** | Operators via API or admin UI | Current snapshot for on-demand pulls |
| **`/admin/system/cache` page** (Tier 3) | Operators investigating issues | Live stats + history; full diagnostics |

**Rejected v1 surfaces**:
- **Toolbar widget with hit-rate** — author-irrelevant; noise in the editing UI
- **Cold-start metrics** — operators infer from per-period hit rate (low immediately after boot; ramps up); not load-bearing
- **`resetStats()` method** — stats reset only on admin restart; "reset and watch" workflow uses restart

**Stats overhead**: always-on counter increments per operation. Negligible cost (nanoseconds per op); observability value too high to gate behind opt-in. Locked as always-on.

**Stats logging cadence**: 5-minute period emits ~288 entries/day per provider. Low log volume; fine-grained enough to spot issues. Cadence is not configurable in v1 (operators with stricter monitoring needs can poll `/api/system/cache/stats`).

## Plugin-contributed cache providers (Q6 locked)

Per `design-plugins.md` and `design-provider-config.md`, plugins export a factory that returns an `AdminCache` instance; operators import and invoke it directly at the `cache:` field:

```ts
import { defineSite } from 'gazetta'
import { distributedCache } from '@my-org/distributed-cache'

export default defineSite({
  cache: distributedCache({ url: process.env.DISTRIBUTED_CACHE_URL! }),
})
```

**`CacheProviderFactory` shape**:

```ts
type CacheProviderFactory = (config: unknown) => AdminCache | Promise<AdminCache>
```

The `config` parameter is opaque — provider-specific shape. Provider validates via Zod at construction; throws `CacheConfigurationError` on invalid config (per Gap 5 lock).

**Multi-instance correctness for plugin providers**:

Plugin authors satisfy Universal Provider Requirement #1 by declaring one of two patterns:

| Pattern | Examples | When to use |
|---|---|---|
| **Per-instance scope** | `MemoryCache`, `IndexedDBCache` | Cheap; eventual consistency via SSE invalidation acceptable |
| **Shared via provider's own coordination** | Redis cluster, DynamoDB, distributed cache | Required for high cache hit rate across multi-instance team deployments |

Plugin documentation MUST declare which pattern. Per the deterministic-derived principle (Q2 lock), values are idempotent across instances — providers don't need exotic CRDTs.

**`EtagCapableCache` (v2 forward-compat)**: when `EtagCapableCache extends AdminCache` ships in v2 (for read-modify-write consumers), plugin authors with shared providers MUST implement it OR document explicitly that their provider doesn't support RMW. v1 plugin authors target `AdminCache` only.

**In-tree vs plugin-contributed**:

| Path | Examples |
|---|---|
| **In-tree (Gazetta ships)** | Mainstream providers — `MemoryCache` (v1); `RedisCache`, `AzureCache`, `FileCache` (v2 demand-driven) |
| **Plugin-contributed** | Niche providers — `@my-org/dynamodb-cache`, `@my-org/memcached`, `@my-org/distributed-cache` |

Same `AdminCache` interface either way. Operator selection by name in `admin.cache.provider` config. New built-in shipped per the 3+ operator request trigger from `design-plugins.md` plugin-promotion pattern.

**Contract test helper**:

Plugin authors validate their providers against the contract:

```ts
// In a plugin's test suite
import { adminCacheContractTests } from 'gazetta/testing'
import { createDistributedCache } from './src'

describe('distributed-cache', () => {
  adminCacheContractTests(
    () => createDistributedCache({ url: 'redis://localhost:6379' }),
    'distributed-cache'
  )
})
```

The suite tests:
- Get-set-invalidate round-trip
- Prefix invalidation correctness
- TTL expiry behavior
- Subscribe/notify across two instances of the same provider
- Fail-open on transport simulation
- Best-effort prefix invalidation cap
- Stats accuracy

`adminCacheContractTests` ships from `gazetta/testing`. Implementation deliverable for the implementation PR; design pass commits that the contract test exists.

## Foundational checks

How cache composes with each of the other 12 foundational dimensions plus the multi-instance discipline.

### Multi-instance discipline
- `MemoryCache` is per-instance; eventual consistency via SSE invalidation broadcasts. Each instance independent.
- Shared providers (Redis, Azure) coordinate via their own atomicity primitives.
- Deterministic-derived value principle (Q2 lock) ensures idempotent writes — two instances writing the same key write the same value; last-write-wins is a no-op.
- `subscribe()` auto-reconnects with backoff (Q4 lock); full local cache reset on reconnect.
- Single-Site-per-process invariant (Gap 3 lock; locked in `CONTEXT.md`); each process holds its own cache instance for the one Site it serves.

### Scale (#1)
- `MemoryCache` capped at 10K entries / 50MB by default (Gap 1 lock); LRU eviction.
- Best-effort `invalidatePrefix` with ~100ms time cap (PWA section); large prefix invalidations don't block save responses.
- Stats overhead negligible (atomic counter increments).
- Cache layer is the load-bearing performance primitive for `/api/pages`, `/api/fragments`, `/api/dependents` at envelope.

### Locale (#2) + Themes (#3)
- Locale and theme appear in compound keys when value varies by them (per Q1 — concatenated values).
- Cache invalidation on save respects locale/theme variants — saving `page.fr.json` invalidates `pages:detail:home:fr:*`, leaves `:en:*` untouched.

### Auth + RBAC (#4)
- Cache keys for principal-scoped values include role/principal identity (per Q3 lock + `design-auth-rbac.md` Foundational checks).
- Role change invalidates by prefix (`cache.invalidatePrefix('pages:summary:role:editor:')`).
- `read:audit-log` results not cached cross-request (per `design-audit.md` Foundational checks).

### Audit (#5)
- Save handlers invalidate cache per Q2 lock; invalidation events audit as part of the triggering save's audit (no separate `action: 'cache-invalidate'` event — would explode event volume).
- Cache subscribe-failures audit as warnings (Q4 lock).
- Per `design-audit.md` Foundational checks: AdminCache misses don't audit (volume).

### Review (#6)
- Cache entries scoped by review state when relevant (e.g., `pages:summary:state:approved` vs `pages:summary:state:pending-review`); consumer encodes in key.
- Review state transitions invalidate cache entries that depend on state.

### Hooks (#7)
- Hook firings don't cache (each invocation independent).
- Plugin-supplied providers register via `api.registerCacheProvider()` (Q6 lock).
- Future cache warming hooks reserved (per Future directions); v1 admins boot with cold cache.

### Render (#8)
- Render-for-analysis cache (validation Cut 3) keyed by content + dependency hashes; deterministic-derived (Q2 principle).
- Page query cache (per `design-rendering.md` Q4 listings): per-instance via `MemoryCache`; invalidated on save.
- Worker cache (L3) is governed by `design-rendering.md` Q1; not part of this design pass.

### Validation (#9)
- Validator results cached when expensive (axe-core, html-validate); content-hash key.
- Cache invalidation on save flows through normal Q2 lock.

### Plugin (#10)
- `AdminCache` is Extension Surface #11 per ADR-0004.
- Plugin-contributed providers register via `api.registerCacheProvider()` (Q6 lock).
- `adminCacheContractTests` helper for plugin authors.

### Offline (#12)
- L4 (server) + L6 (browser) share the `AdminCache` interface; coordinate independently (per offline composition section).
- Cached values MUST be JSON-serializable so L6 can persist them.
- L4 → L6 invalidation cascade via SSE.

### Collaboration (#13)
- Comment counts and notification badges cached per page; invalidated on collaboration events when collaboration ships per `design-collaboration.md`.

### Site config (`design-config.md`)
- One `AdminCache` instance per process, constructed at config-eval time. Operator's `cache:` field at site level (or `defaults.cache` at gazetta level) is a factory call returning the instance.
- Config evaluated at boot; cache provider initialized once.
- Dev hot-reload of config triggers full process restart for cache (graceful, simple).

## Provider implementations

**v1 (this design pass + scale implementation):**

- **`MemoryCache`** — `Map`-backed, per-instance, no expiry by default (TTL optional). Default for all deployments. Multi-instance-correct via per-instance independence.

**v2 (post-design-pass, demand-driven):**

- **`RedisCache`** — `ioredis` or similar; standard distributed cache pattern. Shared across all admin instances. Required for multi-instance team deployments where cache hit rate matters.
- **`AzureCache`** — Azure Cache for Redis (managed); same shape as `RedisCache` with Azure-specific connection.
- **`FileCache`** — disk-backed cache under `.gazetta/cache/`. Useful for small teams without a Redis instance who still want persistence across admin restarts.
- **`DistributedCache`** — opt-in for enterprise tier; consistent-hashing across multiple Redis nodes or similar.

**Browser-side providers** (per `design-offline.md`, foundational dimension #10):

- **`IndexedDBCache`** — large quotas (~50MB+), structured queries; default browser-side provider for offline-mode admin clients.
- **`LocalStorageCache`** — small quotas (~5MB); fallback for older browsers.

Browser-side providers are scoped to one browser tab; never shared across browsers / users / instances. They're peers to the server-side providers — implementing the same `AdminCache` interface — but coordinated independently. Server SSE invalidation events broadcast to connected browsers to invalidate their browser caches.

Operator config in `site.config.ts` (per `design-config.md`):

```ts
import { defineSite, memoryCache } from 'gazetta'

export default defineSite({
  // ...
  cache: memoryCache(),                            // v1 default

  // Future / plugin-contributed providers (illustrative — factories shipped by their packages):
  // cache: redisCache({ url: process.env.REDIS_URL! }),
  // cache: azureRedisCache({ connectionString: process.env.AZURE_REDIS_CONN! }),
  // cache: fileCache({ path: './.gazetta/cache' }),
})
```

## Migration

Existing memo caches (e.g., `findDependentsFromSidecars` per-process memo, the existing template scan cache) migrate to `AdminCache` with `MemoryCache` provider. Behavior unchanged at v1; doors open for v2 swap.

## Future directions

**Distributed cache for enterprise.** Multi-region Gazetta deployments (e.g., admin in US + EU regions both serving the same content) need region-aware cache distribution. Consistent-hashing across Redis cluster, or per-region cache with cross-region invalidation. Tier 3 enterprise tier work.

**Cache warming hooks.** Per `design-hooks.md`, a hook lifecycle phase that fires on admin boot to pre-warm specific cache keys (e.g., the most-recently-edited 100 pages). Useful for reducing cold-start latency on cloud deployments. Reserved for after hooks ship.

**Read-through pattern.** Higher-level abstraction where consumers declare their cache key + miss-resolution function and `AdminCache` orchestrates. Reduces boilerplate at consumer sites. Could be a v2 ergonomics improvement; v1 is fine with explicit get/set.
