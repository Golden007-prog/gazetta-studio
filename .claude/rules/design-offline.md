---
paths:
  - "apps/admin/src/client/**"
  - "packages/gazetta/src/admin-api/**"
  - "**/offline*"
  - "**/service-worker*"
---

# Admin offline mode

Foundational dimension #12 of 13. Admin works through transient connectivity loss (server restart, Wi-Fi drop, VPN issue) and degrades gracefully. Read paths serve from a local persistent cache; write paths queue and replay on reconnect; conflict resolution preserves author intent.

**Status**: design pass complete (2026-05); implementation shipped except the save queue ("Cut 9c: Save queue" in [`design-offline-implementation.md`](design-offline-implementation.md)), planned in Next ([`ROADMAP.md`](../../ROADMAP.md)), and opening a page in the editor on an offline cold load ([#969](https://github.com/gazetta-studio/gazetta-studio/issues/969)). Until the queue ships, a save made offline fails, and the edits stay as drafts until they're saved online. Cut 15, replay metadata on audit events, comes with the queue.

**Companion docs**:
- [`feature-design-process.md`](feature-design-process.md) — defines the **Offline check** every new feature design must answer
- [`design-cache.md`](design-cache.md) — caching layer; offline mode adds a persistent client-side cache
- [`design-auth-rbac.md`](design-auth-rbac.md) — role-aware cache scope (RBAC); reconnect replay attribution
- [`design-audit.md`](design-audit.md) — audit log records reconnect replay events
- [`design-rendering.md`](design-rendering.md) — preview during offline degrades to last-cached render

## Why this is foundational

Admin offline mode is foundational because:

1. **Every UI surface respects offline state.** Banners, save buttons, picker affordances, dirty-dot semantics, validation surfaces — all need offline awareness. Adding it later means retrofitting every surface.

2. **Multi-foundational interactions.** Offline cache scope must respect role visibility (don't cache pages the user can't see). Reconnect must replay save attempts in audit-log-correct order. Real-time event source feeds offline cache invalidation. Conflict resolution interacts with the team review workflow. None of these compose right without dimension-level design.

3. **It's a quality signal at team CMS scale.** Solo authors tolerate "save failed, retry later"; team workflows hit transient connectivity issues at 100x the rate (commercial Wi-Fi, VPN reconnects, deploy windows). Graceful offline behavior differentiates "professional CMS" from "demo CMS."

4. **Save-pending model already half-supports it.** The current pending-edits model (per the bug #106 fix) keeps content + structural changes in browser memory until explicit save. Offline mode extends this naturally — pending edits become persistent across browser reload, save attempts queue, reconnect replays.

## Locked invariants

### Save semantics: commit intent (online or offline)

**Save means "I'm ready to commit this version."** Online or offline doesn't change that. The system's job is to deliver the commit when it can.

This means save works offline. Author clicks Save → save enters queue → replays on reconnect → conflicts surface per Q3 if applicable.

The alternative (save disabled while offline) was considered and rejected:
- Treats save as "send to server" — too literal
- Disables a familiar action when authors don't expect it disabled
- Forces a "save everything pending" prompt on reconnect (UX friction)
- Surfaces conflicts on next-edit rather than at the moment author committed

Save-as-commit aligns with `design-editor-ux.md`'s pending-edits model: author explicitly commits; system handles delivery.

### Pending edits vs save queue (two distinct concepts)

| Concept | Lifetime | Trigger | Persistence |
|---|---|---|---|
| **Pending edits** | Per-item; accumulate as author edits; persist across navigation, reload, offline | Author has not yet committed (no save click) | IndexedDB; survives browser close |
| **Save queue** | Per save attempt; replays on reconnect | Author clicked Save while offline | IndexedDB; survives browser close |

**Author flow** is navigation-free:

1. Edit page X → pending edits accumulate on X (not committed)
2. Navigate to page Y → X's pending edits persist; Y loads fresh server state OR own pending if any
3. Edit Y → pending edits on Y
4. Navigate back to X → X's pending edits restored; author resumes
5. Author commits X (clicks Save) → save attempts → succeeds online OR queues offline
6. Save queue handles delivery; pending cleared on save click (becomes save-in-flight or queued state)

**Author isn't forced to save.** Author can navigate between pages with unsaved pending edits across many pages. Pending edits never silently apply or auto-save. Each save is an explicit commit by the author.

**No auto-save on connection loss.** If author goes offline mid-edit, pending stays in pending state. The author chose not to commit yet; system doesn't override that choice.

**Author can save partial work.** Save commits whatever is in pending at save click time. Author can keep editing after; new pending accumulates; saves when they want.

### Other locked invariants

- **Pending edits persist across browser reload.** The existing pending-edits Pinia stores (`editorContent`, `editorStash`, `editorStructural`) hydrate from IndexedDB on admin boot.
- **Read paths degrade to last-cached.** When the server is unreachable, `/api/pages`, `/api/fragments`, `/api/assets` etc. return cached results with a staleness indicator. Cache backed by `AdminCache` with `IndexedDBCache` provider — extends the cache provider taxonomy.
- **Save queue replays on reconnect.** Save / publish attempts that happened while offline are queued separately from pending edits; replayed on reconnect in submission order. Conflict on replay surfaces per Q3.
- **Cache scope respects RBAC.** Cached entries are scoped to the role principal at cache time; switching role / re-auth invalidates the cache. Don't leak data across role switches. Mechanism: "Unsaved drafts live in their own store" below.
- **Audit log on reconnect.** Replay events go to audit log with `replayed: true` + original-attempt timestamp. Operators see the offline activity later.

## Persistence layer (Q1 locked)

UX-driven choice: **IndexedDB primary; MemoryCache fallback when IndexedDB unavailable.** localStorage rejected.

### UX requirements driving the choice

1. **Author opens admin → sees their work immediately** (cached state renders instantly)
2. **Edits during connection blip → no interruption** (save/validate/preview work)
3. **Pending edits survive reload/crash** (rules out MemoryCache as primary)
4. **Save during typing without UI freeze** (rules out localStorage's sync API)
5. **Cross-tab sync** (BroadcastChannel)
6. **Invisible reconnect** (no buttons; transparent)
7. **Conflict UX is clear and kind** (force-save banner; not silent overwrite — see Q3)
8. **Storage limit hit gracefully degrades** (rules out localStorage's tight 5MB cap)

### Persistence layers

| Provider | When used | UX posture |
|---|---|---|
| **`IndexedDBCache`** | Default; whenever IndexedDB is available | Best UX; meets all 8 requirements |
| **`MemoryCache` (browser-side)** | Fallback when IndexedDB unavailable (private browsing mostly) | Banner: "Offline persistence unavailable in private browsing — your edits will be lost on reload." Honest degradation. |
| **Draft store** (own IndexedDB database; in-memory fallback) | Always, for pending edits only | Authoritative user data: no eviction, no TTL, one record per draft. See "Unsaved drafts live in their own store". |

**localStorage rejected**: sync API freezes UI on writes (5-50ms per save — hostile at typing rate); 5MB cap structurally too tight for envelope sites; would force eviction at much smaller scale than IndexedDB; sneaky persistence promise — would pretend to offer durable storage that gets evicted under pressure.

**Reserved for v2** (when concrete demand surfaces):
- `OPFSCache` — when site exceeds IndexedDB quota OR when worker-thread sync writes are needed
- `LocalStorageCache` — only if a real use case demands persistence WITHOUT IndexedDB AND without UI-freeze concerns

### Provider selection logic (boot)

```ts
async function selectBrowserCacheProvider(): Promise<AdminCache> {
  if (await indexedDBProbe()) {
    return new IndexedDBCache({ siteName, quotaTarget })
  }
  // IndexedDB unavailable — show banner; offline mode degrades to in-memory only
  showOfflinePersistenceWarning()
  return new MemoryCache(/* per-instance memory; no persistence */)
}
```

`indexedDBProbe()` opens a real test transaction (catches private-mode-throws-on-use; some browsers report IndexedDB available but throw on use).

### Storage isolation

- Per-site key prefix per `design-cache.md` Gap 3 lock. **Not implemented in the browser `IndexedDBCache`** (fixed database name, no site prefix — verified 2026-10-18). Drafts are site-scoped by the draft store's key; the query cache still needs it (Cut B).
- Cross-tab sync via native **BroadcastChannel** — invalidations broadcast to peer tabs in same origin. No library needed.

### Unsaved drafts live in their own store, owned by one user (locked 2026-10-18, #962)

Pending edits — unsaved drafts and structural edits — are the author's only copy of their work. They do **not** live in `AdminCache`: that is a cache, allowed to fail open and to evict (`design-cache.md` Universal Provider Requirement #5; the browser provider evicts past 10,000 entries). They live in a dedicated **draft store**: its own IndexedDB database, one record per draft, no eviction, no TTL. Private browsing falls back to an in-memory draft store with the same contract (lost on reload, as today's banner says).

**Record key:** `[site, owner, target, kind, name, locale, path]` (structural edits omit `path`). Kinds: `edit`, `structural`, and `metadata` (page metadata, keyed like structural edits; [`design-editor-ux.md`](design-editor-ux.md) "Page metadata is a pending lane").

- **site** — the site's name from `/api/site`. Browser IndexedDB is per origin, so two sites served from one origin over time (e.g. `gazetta dev` on port 3000) must not share drafts. Two sites with the *same* name on one origin are not separated; accepted.
- **owner** — `{trustMode}:{id}:{role}` of the principal that wrote the draft. Role is part of it, so a role change counts as a different owner (the RBAC invariant above).
- **target** — the active target. Without it, a draft made on `local` loaded into the same page on `staging`.

**Why a separate store, not owner-tagged cache snapshots (the first version of this lock, #963):** reproduced 2026-10-18 — the cache keeps all drafts in one snapshot per kind, and each tab writes the whole snapshot, so a second tab's write deleted the first tab's drafts. With one record per draft, each write and delete touches only its own record, in its own transaction. The same structure gives the privacy purge an exact, transactional delete, and removes eviction as a way to lose work.

**Why ownership:** in trust modes that identify the user upstream (`cloudflare-access`, the proxy modes), two people can share one browser profile. Reproduced 2026-10-18 with `forwarded-user`: user B opened user A's unsaved draft, with Save enabled.

**Boot sequence** (in `main.ts`, before anything hydrates):

1. **`GET /api/me`** → `{ id, role, trustMode }`. Schema-typed under `admin-api/schemas/` (MCP discipline). No capability gate — every request has a principal (`id: 'unknown'` in `none` mode). Timeout 3 s.
2. **Classify the answer:**
   - JSON matching the schema → **known owner**.
   - Network error or timeout → **offline**: use the owner record (step 4) — the last online user's drafts load. Inherent to offline; documented in `docs/offline.md`.
   - Anything else (non-OK status, a login page from the auth proxy, unparseable body) → **unknown owner**: load no drafts and keep them stored. The user re-authenticates and reloads.
3. **Known owner differs from the record** → in one transaction, delete every record of this site whose owner differs. They are deleted, not kept for later: on a shared profile anything left in IndexedDB is readable by the next user through devtools.
4. **Owner record** — `{site} → owner` of the last online boot, kept in the draft store.
5. **Load** only records matching `[site, owner, target]`; switching target loads that target's records.
6. **Query cache** (`gazetta-vue-query`, which is derived data and stays in `AdminCache`): its `buster` includes the owner, so a different owner never sees the previous query cache.

A tab still open from user A after B signs in keeps writing records owned by A. B never loads them, and B's next online boot deletes them.

**Two tabs editing the same draft** are last-write-wins on that one record. Acceptable for unsaved edits; no cross-tab merge.

**New saved user state is a lane of the draft store** (`apps/admin/src/client/drafts/persistence.ts`), never a new snapshot key in `AdminCache`. The store's scope type carries site, user and target; each lane's own key must carry locale, kind and name, and its writes go to the locale the data was loaded from, not the one active at save time (#973 structural edits, #974 page metadata). A one-run check on 2026-10-18 showed `review-architecture` already flags a planted snapshot-in-`AdminCache` lane as CRITICAL against this section, so no separate review rule is needed.

**Rejected:**

| Option | Why rejected |
|---|---|
| Owner-tagged snapshots in `AdminCache` (#963's first lock) | Tabs overwrite each other's snapshots (reproduced); still subject to eviction and fail-open writes. |
| Skip the write when another owner wrote the snapshot | Closes the cross-user case only; the same-user tab overwrite stays. |
| One cache key per draft + a `keys(prefix)` cache method | Changes every `AdminCache` provider, server-side ones included, for a need only drafts have; still evictable. |
| Read-merge-write the snapshot (with or without Web Locks) | Deletions need tracking; still evictable and fail-open. |
| Sync stores live across tabs (BroadcastChannel) | Conflicts when two tabs edit the same field; startup races. |
| Allow only one editing tab | Authors work in several tabs. |
| `sessionStorage` | Drafts die with the tab; sync API (see localStorage rejection above). |
| Persist only in trust mode `none` | Teams lose offline mode entirely. |
| Weaken the RBAC invariant | It is a locked decision, and the leak is real. |
| Clear on logout | No logout signal exists; upstream auth signs out outside Gazetta. |
| Keep other owners' drafts for their return | Readable by the next user through devtools; storage grows with no cleanup point. |
| Treat any failed `/api/me` as offline | An expired proxy session would load the previous user's drafts. |

**Not covered:** a tab already open when the signed-in user changes still holds the previous user's edits *in memory* and would save them as the new user. That is not a persistence problem; it needs the tab to notice the principal change (revisit with the collaboration presence work).

### The site tree reads through the query cache (locked 2026-10-18, #962)

Promise being kept: "Cold-load admin offline → SW serves cached shell → IndexedDBCache hydrates state → admin renders" (service worker section below). Before this lock nothing used Vue Query: the site and active-target stores called `api.*` directly, so the persister had nothing to persist and an offline cold load showed "Failed to fetch" in the site tree. Because the target list also failed, the active target was `null` — so Cut 8c's draft scope was `null` too, and **unsaved drafts didn't load offline** either.

**How it works:**

1. **The two stores read through the query client**, via a small helper (`queries/read-through.ts`) that `main.ts` registers with the query client — the same pattern as `setActiveTargetProvider`. *Implementation note:* the lock first said `useQueryClient()` inside the setup stores; that only works inside the Vue app context, so every store unit test would have needed the app and Vue Query. Unregistered, the helper just fetches. Their public APIs don't change (17 + 14 consumer files).
2. **Query keys:** `['site']`, `['targets']`, `['pages', target]`, `['fragments', target]`. `target` is the value the request actually carries — `getActiveTarget() ?? '(default)'` — because the router loads the site before the target list, so the first page-list request has no `?target=`.
3. **Reading** (one shared helper, four callers):
   - Connection store says `offline` and a cached answer exists → serve it **immediately** (no retries).
   - Otherwise fetch fresh, keeping the site store's existing retry loop (dev-server start-up). On final failure, serve the cached answer if there is one; else surface the error as today.
   - `networkMode: 'always'` on these fetches: the connection store drives `onlineManager`, and in the default mode a fetch would pause forever while offline instead of failing.
4. **Wait for the restore.** `main.ts` wraps the client persister and keeps the restore promise it returns (`persistQueryClientRestore` catches its own errors, so it never rejects). The helper awaits it before the first read.
5. **Retention:** `maxAge` and `gcTime` = 7 days (default 24 h fails a weekend; TanStack requires `gcTime` ≥ `maxAge`).
   *Implementation note:* the persister also stores queries whose last refresh failed (`shouldDehydrateQuery: query has data`). TanStack's default keeps only `success` queries, so the first failed fetch of an offline cold load erased the stored answers (observed in the e2e test).
6. **Reset key (`buster`)** = `{gazetta version}:{site}:{owner}`, with site and owner from Cut 8c's identity (the last online identity when offline; `anonymous` when unknown). The version comes from a Vite `define`. A different version, site or user discards the whole persisted cache.

7. **Deep links offline:** the service worker serves admin navigations network-first, falling back to the precached `index.html` when the network fails — before Cut 5b only `/admin` itself loaded offline. Server-answered paths (`api`, `preview`, `ping`, `theme.css`) are excluded. Network-first, not cache-first, because `gazetta build` rewrites `index.html` with the custom-editor import map.

**Not covered:** opening a page in the editor offline — the page manifest, template schema and custom editor modules aren't cached ([#969](https://github.com/gazetta-studio/gazetta-studio/issues/969)).

**Freshness:** offline, the global Offline banner is the indicator. Per-item "last synced" stays with the Q4 freshness UI below.

**Known limit:** sites served alternately from one origin discard each other's persisted cache (different `buster`). Acceptable; the browser `IndexedDBCache` has no per-site prefix (see Storage isolation).

**Rejected:**

| Option | Why rejected |
|---|---|
| `useQuery` in components | Churns the ~30 files that read the two stores today. |
| Stores keep their own snapshots | A second persistence path beside the query cache. |
| Service worker caches `/api/*` | Blind to target and auth; hides offline state from the app. |
| Narrow the design (drop offline cold load) | Drops a locked promise. |
| Per-site key prefix inside `IndexedDBCache` | Changes the cache provider for every key; the `buster` already isolates the persisted query cache, which is the only per-site browser cache. |
| Hook `clientPersisterOnSuccess` for the restore wait | The client persister already returns the restore promise; wrapping it is simpler and covers failure too. |
| Retention 24 h / 30 d / no expiry | 24 h fails a weekend; 30 d keeps stale structure too long; no expiry never cleans up. |

### `navigator.storage.persist()` opt-in

```ts
admin: {
  offline: {
    enabled: true,
    requestPersistence: true,  // calls navigator.storage.persist() at boot
  },
}
```

User browser may grant or deny persistence based on heuristics (bookmarked, frequently used). Granting promotes IndexedDB from "best-effort" (can be cleared by browser under storage pressure) to "won't be cleared without user action." UX-positive — reduces accidental data loss.

### npm stack

The recommended dependencies for implementation:

| Concern | Library | Role |
|---|---|---|
| **IndexedDB wrapper** | `idb` (^8.0.0) by Jake Archibald | Implements `IndexedDBCache` provider; ~2KB; promise-based; industry-standard |
| **Query/mutation cache + offline queue** | `@tanstack/vue-query` | Manages client-side query state + offline mutation queue + optimistic updates |
| **Cross-tab sync** | Native `BroadcastChannel` | No library; just the API |
| **Connection detection** | `@tanstack/vue-query` built-in + `navigator.onLine` | No additional library; Vue Query already handles this |
| **Persistence to L6** | `@tanstack/query-async-storage-persister` + custom `idb` adapter | Bridges Vue Query cache to `IndexedDBCache` |

**Why Vue Query**: Gazetta admin is Vue 3 + Pinia. Vue Query (`@tanstack/vue-query`) provides mature primitives for offline UX:
- Query/mutation cache with rehydration
- Optimistic updates (`useMutation({ onMutate, onError, onSettled })`)
- Offline mutation queue with replay
- Online/offline detection with extension points
- ~13K stars; ~1M weekly downloads

**Why two complementary cache layers** (Vue Query + L6 IndexedDBCache):
- **Vue Query**: client-side query state lifecycle (loading/error/data; mutations)
- **L6 `IndexedDBCache`**: persistent storage of last-known data
- Vue Query rehydrates from L6 at boot via `persistQueryClient` plugin

**Rejected v1 dependencies**:
- **Service Worker / Workbox** — reserved for v2 PWA installation per Future directions; v1 admin works in regular tab without service worker
- **Yjs / Automerge / Loro** (CRDTs) — concurrent editing is Tier 3; v1 conflict resolution is force-save with banner (Q3)
- **localForage** — older library; doesn't add value over `idb` for our use case

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Vue 3 Admin App (Pinia + PrimeVue)                          │
│                                                             │
│   useQuery → useMutation (Vue Query)                        │
│   ├── In-memory query cache (QueryClient)                   │
│   ├── In-memory mutation queue (MutationCache)              │
│   └── persistQueryClient → IndexedDBPersister               │
│                          │                                  │
│                          ▼                                  │
│   L6: IndexedDBCache (implements AdminCache, uses idb)      │
│                          │                                  │
│                  BroadcastChannel ◄── cross-tab sync        │
│                          │                                  │
│                          ▼                                  │
│   Server (L4): AdminCache instance                          │
│                          │                                  │
│              SSE invalidation ◄── L4 → L6 cascade           │
└─────────────────────────────────────────────────────────────┘
```

**Server-side AdminCache and client-side AdminCache share the interface but operate independently.** The server caches for hot-path reads; the client caches for offline tolerance. They're coordinated via SSE invalidation events — when the server invalidates `pages:`, it broadcasts to connected clients to invalidate their browser caches (per `design-cache.md`'s offline composition section).

### Service worker for app-shell caching (v1)

**Service worker ships in v1, scoped to app-shell caching only.** Solves "open admin offline → blank screen" definitively.

**What v1 SW does**:
- Precaches admin SPA bundle (HTML/JS/CSS) via `vite-plugin-pwa`
- Cold-load admin offline → SW serves cached shell → IndexedDBCache hydrates state → admin renders
- Update flow: `skipWaiting` + `clientsClaim` with toast notification ("New version available — refresh to update")

**What v1 SW does NOT do**:
- **Background sync** (`BackgroundSyncPlugin`) — deferred to v2. Replay-with-tab-closed is low marginal value for CMS work. Authors reopen admin to check sync status; replay-on-next-open is acceptable UX.
- **PWA install prompt** (`manifest.json` install) — deferred to v2 as operator opt-in feature
- **Push notifications** — deferred; will compose with collaboration design pass

**Dependency**: `vite-plugin-pwa` (^0.20.x). Built on Workbox; declarative configuration; well-maintained.

**Why service worker in v1**: cold-load reliability. Without SW, browser HTTP cache may have evicted the SPA bundle by the time the user opens admin offline; "site can't be reached" failure mode. With SW, SPA bundle is intentionally cached and survives. Aligns with PWA-style responsiveness principle from `design-cache.md`.

**Update detection UX** (handled by vite-plugin-pwa):
- New SW version detected → toast "New admin version available"
- Author clicks "Refresh" → smooth reload with new version
- Skipping toast → next page navigation activates new version

**HTTPS requirement**: service workers require HTTPS in production. Localhost development works on HTTP. Already a Gazetta requirement for auth cookies; no new constraint.

## Connection detection (Q2 locked)

Hybrid: `navigator.onLine` for instant UI signal + heartbeat to confirm/correct.

**Why hybrid**: `navigator.onLine` is unreliable (browsers sometimes report online when network is broken; or report offline when network is fine). Pure heartbeat is accurate but lagged + costly. Hybrid uses each for what it's best at.

**Heartbeat cadence** — on-demand, not constant:

| State | Heartbeat behavior |
|---|---|
| `online` (recent successful request) | No heartbeat; quiet |
| `degraded` (`navigator.onLine` false OR failed request) | Heartbeat every 5s |
| `offline` (heartbeat failed N times) | Backoff to every 30s |
| `reconnecting` (heartbeat succeeded after offline) | Trigger queue replay; transition to `online` |

**Endpoint**: `GET /api/health` returning `{ ok: true, timestamp }`. Lightweight (no DB query, no auth check); public; cacheable at edge for `dynamic` targets with worker.

**Connection state model**: five states surfaced via Pinia store `useConnectionState`:

| State | UI |
|---|---|
| `online` | No banner; normal UI |
| `degraded` | Subtle indicator ("Connection unstable"); appears after 1 failure; clears on success |
| `offline` | Persistent banner ("Offline — your edits are queued") with status pulse |
| `reconnecting` | Banner ("Syncing your edits...") with progress; clears when queue empty |

**Vue Query integration**:

```ts
import { onlineManager } from '@tanstack/vue-query'

connectionState.$subscribe((mutation, state) => {
  onlineManager.setOnline(state.status === 'online' || state.status === 'reconnecting')
})
```

When Vue Query is "offline," queries pause (don't refetch); mutations queue; on `setOnline(true)`, mutations replay automatically.

**No "work offline" toggle** for users. Authors don't want to "go offline"; offline is what happens TO them. Browser DevTools is the override for developers testing offline behavior.

**Cold-start offline**: SW serves cached admin shell → IndexedDBCache hydrates state → render UI populated → connection state immediately `offline` with banner → pending edits work; queue accumulates → on reconnect, replay invisible. No "waiting for connection" screen.

## Conflict resolution (Q3 locked)

**v1: force-save with diff banner.** Three-way merge reserved for v2.

### The conflict scenario

1. Author A starts editing page X at T0 (server version hash = X1)
2. Author A goes offline at T1 (still editing)
3. Author B online edits + saves page X at T2 (T0 < T1 < T2; new server hash A1)
4. Author A reconnects at T3 with pending save (its `If-Match` is X1)
5. Server's current is A1; A's save is stale

### Detection mechanism

- Reads return `etag: <content-hash>` header (existing `.{8hex}.hash` per `sidecars.md`)
- Client stores the etag with the cached state
- Each unsaved draft records the etag of the version it was made on (locked 2026-10-20, #1034). A draft restored after a reload makes that etag the manifest's `If-Match` when it becomes active (its page or component is opened), not the etag of the version just loaded; there is no check when the draft comes back, and no new UI — a newer version gets the usual `409 STALE` banner. A successful write this session that was sent with a draft's etag moves that draft to the new etag, including drafts a Save that failed part-way leaves; drafts made on another version keep theirs. Drafts stored before this have no etag and save over the current version.
- Saves include `If-Match: <hash>` header
- Server compares incoming `If-Match` to current hash; on mismatch, returns `409 STALE`:

```ts
{
  code: 'STALE',
  currentVersion: { /* manifest */ },
  currentVersionAuthor: { id, email, role },
  currentVersionAt: '2026-05-04T...'
}
```

### UX: surface conflict, no force-overwrite

When client receives `409 STALE`, surfaces a banner with two actions:

| Action | Behavior |
|---|---|
| **"Show what changed"** | Opens diff view: server's current vs. author's pending; field-by-field semantic diff |
| **"Discard my changes"** | Drops pending save; reloads server's current version |

**No "Save anyway (overwrite)" button.** Authors who genuinely want to overwrite specific changes manually port their edits onto the new version (load the diff, decide what to keep, save the merged result as a fresh edit).

This matches Linear / Notion / Figma — no force-overwrite button. Author chooses to layer their changes onto the new state, not silently overwrite. Removes a footgun (accidental overwrites of colleague's work) and simplifies the conflict UX.

### Diff view

**Field-by-field semantic diff** (v1):
- "Title: 'Welcome' → 'Hello' (yours) vs. 'Greetings' (theirs: bob@example.com, 5 min ago)"
- Maps manifest fields to human-readable labels
- Highlights conflicting fields (both you and they changed) vs. clean overlays (only one of you changed)

**JSON diff** (rejected for v1): too technical for authors.
**Visual diff (side-by-side rendered preview)** (rejected for v1): heavy implementation; v2 if demand surfaces.

### Multi-write replay

Author saves 5 times offline then reconnects:

```
T0: page hash X1
T1 offline: save A1 (If-Match: X1) → queue
T2 offline: save A2 (If-Match: A1's projected hash) → queue
T3 reconnect: replay A1 → succeeds; new server hash A1
T4: replay A2 → If-Match matches projected → succeeds
```

**Client tracks pending edit sequence with chained hash projections.** Each pending edit's `If-Match` is the previous edit's projected resulting hash. Server applies in order.

If A1 conflicts (because B saved between A's start and reconnect):
- Conflict UI surfaces ONCE at A1
- A2-A5 paused until A resolves A1
- After A resolves A1 (overwrite OR discard), A2-A5 replay against the new sequence (may surface their own conflicts in turn)

### Publish event conflicts

Same pattern: publish events also include `If-Match: <target-state-hash>`; server returns `409 STALE` on mismatch with publish-target-specific metadata. UX banner adapts: "another author published this target while you were offline."

### v2: three-way merge

Reserved when concurrent editing demand materializes (Tier 3 strategic bet — OT/CRDT). Three-way merge for structured content (manifest JSON) is solvable but complex:
- Text-field merge (article body, descriptions): well-understood via OT/CRDT
- Structural-change merge (component reordering): semantics unclear in conflict cases
- Implementation cost high; debugging cost higher
- v1 doesn't need it; v2 may

## Cache freshness UI (Q4 locked)

Three layers of staleness UI:

### Global banner (locked in Q2)

Connection state via `useConnectionState` Pinia store drives global banner:

| State | Banner |
|---|---|
| `online` | Hidden |
| `degraded` | Subtle "Connection unstable" |
| `offline` | Persistent "Offline — your edits are queued" |
| `reconnecting` | "Syncing N edits..." with progress |

### Per-item "last synced" timestamp

In editor metadata panel, small neutral text:

- **Online + recent**: hidden (don't clutter when fresh)
- **Offline OR last sync > 5 min ago**: "Last synced X min ago"
- **Offline + viewing cached content from previous session**: "Last synced X hours ago"

Threshold (5 min) tunable; goal is to surface staleness only when meaningful.

### Sync-state visibility (Krug-aligned: "Don't Make Me Think")

Authors should know whether work is on the server **without thinking about it**. Visual indicators only when something is NOT synced or NEEDS attention. The absence of an indicator IS the synced state.

**State categories from the author's perspective**:

| Category | What author thinks | UI |
|---|---|---|
| **Fine** | "All good" (no conscious thought) | No indicator |
| **Working** | "I'm editing this" | Dirty dot (existing pattern) |
| **Saving** | "Saving now" | Spinner during save click |
| **Saved locally** | "It's saved; will sync later" | Cloud-with-slash icon |
| **Needs attention** | "I need to fix this" | Red badge + clear message |

Five categories, three of them transient or conditional. Steady state is "no indicator" (synced) or "dirty dot" (in progress).

### Save button — same online and offline

Save button language is identical regardless of connection state. Author's mental model: "I click Save; it says saved." Same button, same flow.

| State | Save button | What changes is WHERE saved |
|---|---|---|
| Clean | Disabled | Nothing to do |
| Pending edits | Enabled "Save" | Click commits |
| Saving (in-flight) | Disabled, spinner | Brief |
| Just saved (online) | "Saved" feedback fades → clean state | No indicator |
| Just saved (offline) | "Saved" feedback fades → cloud-with-slash icon | Author sees: saved locally |

Author always sees "Saved" feedback after click. The DIFFERENCE shows up after the feedback fades — clean state online, cloud-with-slash icon offline. Same mental model both ways. The icon tells them WHERE.

### Per-item indicators — only when noteworthy

Site tree + editor metadata show per-item indicators ONLY when something is interesting:

| Condition | Site tree | Editor metadata |
|---|---|---|
| Synced and clean | (nothing) | (nothing) |
| Pending edits | Dirty dot | Dirty dot in toolbar |
| Saved locally only | Cloud-with-slash icon | "Saved locally — will send when online" |
| Conflict | Red badge | Red banner with clear message |
| Created offline (never synced) | Cloud-with-slash icon (treated same as "saved locally") | "Saved locally — will send when online" |

No "Last synced: 2 min ago" timestamps in normal operation. That's noise — the author doesn't care about precision when everything is fine. Hover the cloud icon for tooltip ("Saved locally at 10:23 — waiting to send") if author wants the detail.

### Global indicator — minimal

Top bar / banner shows minimal status:

| Connection state | Indicator |
|---|---|
| Online + everything synced | Nothing |
| Online + replaying (just reconnected) | Subtle spinner with "Sending your saved items..." (transient) |
| Offline | Banner: "Offline" (plain word; no jargon) |
| Sync had failures | Notification toast: "1 item couldn't send — review →" |

The banner is just "Offline" — not "Offline — N items queued." If author wants the count, they glance at the site tree (cloud icons on items waiting). The banner stays minimal; detail is in the tree.

### Plain language (no jargon)

| Technical term | Author-facing language |
|---|---|
| "Queued" | "Saved locally" / "Will send when online" |
| "Sync" | "Send to server" (when explained); icon usually |
| "Conflict" | "Was edited by someone else" |
| "STALE" / "If-Match" / "replay queue" | (never shown to author) |

Authors think in their own terms. The system's internal terminology stays internal.

### Late conflict surfaces

If author saved offline at 10am, reconnects at 2pm, save replays and conflicts:

- **Notification toast**: "Page Home was edited by someone else while you were offline — review →"
- Click → opens the page; conflict banner shows what changed (per Q3 lock)
- Plain-language message; no "STALE conflict" jargon

If author isn't currently in admin (closed tab): visible on next admin open as a notification at top.

### Force-sync affordance (visible only when relevant)

When items are saved-locally, the offline banner has a "Send now" link:
- Triggers heartbeat probe + replay sequence
- Useful when author knows network is back; system is still backing off
- Affordance only present when there's something to send; hidden otherwise

Per-item retry: when an item failed to sync (conflict / error), the editor has a "Try again" affordance after author resolves.

### What's REMOVED from earlier lock

- ❌ **"Queued" badge text** — replaced by universal cloud-with-slash icon (no jargon)
- ❌ **Persistent "Saved ✓" indicator after save** — fades; absence is the synced state
- ❌ **Numeric progress in banner** ("Syncing 3 of 15") — reduces to a subtle spinner; site tree shows per-item progress; numbers are noise
- ❌ **Tab title status** — `(3 syncing) Admin` is noise; tab titles identify tabs, not state
- ❌ **First-time-user help tooltip** — if UI needs explaining, fix the UI; cloud icon is universal enough
- ❌ **"Last synced: X min ago" timestamps in editor metadata** — noise during normal operation; tooltip on hover when author wants detail
- ❌ **"N items with pending edits" + "M items waiting to sync" separate counts** — site tree shows it; top bar stays minimal

### Accessibility (kept from prior lock)

Visual language uses text labels alongside color where text is shown ("Try again" button has both icon and text). Cloud-with-slash icon has aria-label "Saved locally, waiting to send." Screen reader announces state transitions. RTL inheritance from admin root.

### Save semantics with sync visibility

- User clicks "Save" → save attempted
- **If online**: in-flight → server responds → either synced (success state, brief "✓") or failed (banner)
- **If offline**: save enters queue → button shows "Queued" → on reconnect, replay attempts; success → synced, conflict → failed surface

Author always knows whether their commit reached the server.

### Mid-save connection-loss (handled invisibly)

Author clicks Save online → connection drops before server responds. Two cases:
- **Server received but response lost**: client retries with same content-hash (`If-Match`); server-side idempotency returns success; item transitions to clean.
- **Server didn't receive**: save automatically transitions from in-flight to saved-locally; sends on reconnect.

Either way, the author sees the cloud-with-slash icon if the save didn't confirm; clean state if it did. No silent loss. No technical jargon surfaces.

### Storage approaching limit

When local storage approaches the cap (80% of allocated), a subtle banner surfaces: "Storage almost full — please connect to send your saved items." Plain language; actionable; appears once until acknowledged or storage frees.

LRU eviction kicks in only at 100% (per `design-cache.md` Gap 1 lock). The 80% warning gives the author buffer to act.

### Replay progress UI

When reconnecting with a queue:

| Queue state | UI |
|---|---|
| Replay starts | Banner: "Syncing N edits..." |
| Replay progresses | Banner updates: "Syncing M of N edits..." |
| All succeed | Banner clears; toast: "N edits synced" (auto-dismiss 3s) |
| Some conflicts | Banner: "M of N edits had conflicts. Review them →" |

### Conflict banner (per-page, distinct from global offline banner)

When 409 STALE surfaces (per Q3), conflict banner appears at top of affected page editor:
- Visual distinction: red/warning vs. blue/info global banner
- Coexists with offline banner (global + per-page conflict)
- Three actions per Q3 lock: Show diff / Save anyway / Discard

### Asset upload pending badges

Author drops files while offline:
- Files queued with "pending sync" badge
- Asset library shows pending state (different visual)
- Reconnect triggers upload replay; badges clear as uploads complete

### Rejected v1 UX

- **Per-item visual freshness icons** (green/yellow/red dots): over-engineered; global state is enough; adds noise to every item view
- **JSON diff in conflict view**: too technical for authors (per Q3 lock)
- **Visual side-by-side preview diff**: heavy implementation; v2 if demand surfaces

## Audit log shape for offline replays (Q5 locked)

Per `design-audit.md`'s Foundational checks: replayed events record `metadata.replayed: true` + original-attempt timestamp; actor captured at queue time, not replay time.

**Granularity**: single audit event per replayed save (NOT batch). Preserves chronology — operators see each edit as a discrete event with its own queued-at and replayed-at timestamps. Matches multi-write replay model (Q3 lock).

**Replay metadata fields** on every replayed save event:

```ts
{
  action: 'save' | 'publish' | 'delete' | ...,
  outcome: 'success' | 'failed-render' | 'forbidden' | 'validation-failed',
  actor: { /* captured at queue time, not replay time */ },
  scope: { /* item being saved */ },
  // Replay metadata
  metadata: {
    replayed: true,
    queuedAt: '2026-05-04T14:23:05.123Z',       // browser-local time at queue time
    replayedAt: '2026-05-04T14:30:00.456Z',     // server-side replay time (= event timestamp)
    requestId: 'replay-...',
    // For failed replays:
    failureReason?: 'stale' | 'forbidden' | 'validation-failed',
    // For STALE conflicts:
    conflictWith?: { actor: { id, email }, at: '2026-05-04T14:25:00Z' },
  }
}
```

**Failed replay audit**: full failure context + replay metadata. STALE conflicts additionally record `conflictWith` (the in-the-meantime save's actor + timestamp) — operators can reconstruct the sequence.

**`queuedAt` source**: browser-local time at queue time. Captures author's intent ("I tried to save at this moment"). Clock drift is acceptable for forensic context — most users have NTP-synced clocks; small drift bounded.

**Cancelled-before-replay edits**: NOT audited. Edit removed from L6 queue; no server roundtrip; audit captures only events that reached the server. v1 doesn't audit client-side cancellations; deferred to v2 if regulated-context demand surfaces.

**Conflict resolution actions** (Show diff / Discard from Q3 banner): "Discard" produces no audit event (no server roundtrip). Manual re-edit after viewing diff produces a new save event with `outcome: 'success'` against the current state — normal save audit; no special "merged" event type needed.

## Always-on (Q6 locked)

**Offline UX is structural, not configurable.** No opt-out. Cache + queue + sync IS the admin; not a feature on top.

### Why always-on

- Simpler implementation: no conditional code paths for "offline disabled"
- Aligns with modern collaborative tools (Linear, Notion, Figma, Sanity) — none expose an "offline disable" toggle
- Operators can't accidentally degrade UX for their authors
- Eliminates a category of operator config decisions

### Optional config

```ts
admin: {
  offline: {
    requestPersistence: false,        // opt-in for navigator.storage.persist()
  },
}
```

The only config knob is `requestPersistence` (calls `navigator.storage.persist()` to upgrade IndexedDB from "best-effort" to "won't be cleared without user action"). Default off because granting depends on browser heuristics; operator opts in when they want to request it.

### What happens when IndexedDB is unavailable

Per Q1: `MemoryCache` fallback with banner — "Offline persistence unavailable in private browsing — your edits will be lost on reload." Honest degradation. Vue Query still operates in-memory; admin remains functional.

This isn't an "opt-out" path — it's a graceful degradation when the browser environment doesn't support persistence.

### Bundle cost

| Dependency | Size |
|---|---|
| `idb` | ~2KB |
| `@tanstack/vue-query` | ~30KB |
| `vite-plugin-pwa`-generated service worker (Workbox runtime) | ~50KB |
| **Total offline UX overhead** | ~80-100KB minified |

Acceptable for admin SPA at typical scale (PrimeVue + Vue 3 base is ~200KB+; the offline addition is ~40-50% of base).

### Migration

Existing sites: offline UX activates on upgrade. Authors observe positive behavior change ("my work didn't disappear when I closed the laptop"). Operators didn't need to opt in.

### Positive surprise design

Authors discovering offline UX via use:
- First-time offline (Wi-Fi blip during edit) — banner appears, edits queue, reconnect syncs invisibly. Author thinks "oh nice, it just worked."
- First-time browser-reopen with pending edits — admin loads with their work intact. Author thinks "I didn't lose anything."

No tutorials needed; the feature reveals itself naturally during normal use.

## Foundational checks

How offline composes with each of the other 12 foundational dimensions plus the multi-instance discipline.

### Multi-instance discipline
- Browser-side cache is per-browser-tab (IndexedDB scoped to origin + browser session). Two tabs on the same browser share IndexedDB; two browsers don't. No cross-instance coordination needed at the browser layer.
- Reconnect-replay queue is per-browser. Two browsers each replay their own queue independently — server's `If-Match` chain catches stale replays per Q3.
- Server-side: offline features don't require server changes beyond the existing SSE infrastructure (already per-instance) which broadcasts cache invalidations to connected clients.
- Cross-tab same-browser sync via native `BroadcastChannel`; no cross-instance coordination required.
- Per-site key prefix in IndexedDB matches `design-cache.md` Gap 3 lock — multi-site projects share IndexedDB without collision.

### Scale (#1)
- Cache size budget at envelope (~5000 pages × 150 bytes/summary = ~750KB) is well under IndexedDB quota (50MB+).
- LRU eviction in `IndexedDBCache` matches `design-cache.md` Gap 1 lock when cap is reached.
- Replay queue size: typical offline session has 1-10 pending edits; queue stays small.
- Long offline sessions (hours/days) accumulate larger queues but stay bounded by IndexedDB quota.

### Locale (#2) + Themes (#3)
- L6 cache keys include locale + theme dimensions per `design-cache.md` Q1 lock.
- Theme switch invalidates per-theme entries via prefix invalidation.
- Locale switch invalidates per-locale entries.

### Auth + RBAC (#4)
- Cache scoped to role principal at cache time; switching role / re-auth invalidates the L6 cache. Mechanism: "Unsaved drafts live in their own store" (Persistence layer).
- Per `design-auth-rbac.md` Foundational checks: "Browser-side cache scoped to role principal; role switch invalidates."
- Replayed write events on reconnect record the actor at queue time, not replay time. If actor lost capability while offline, replay fails with `outcome: 'forbidden'` recorded.
- Trust mode determines auth headers on replay (e.g., Cloudflare Access JWT may have expired during offline; replay fails with `outcome: 'unauthenticated'` → user re-auths → resumes).

### Audit (#5)
- Replayed events record `metadata.replayed: true` + `queuedAt` + `replayedAt` (per Q5 lock).
- Single audit event per replayed save (not batch); preserves chronology.
- Failed replays record full failure context including `failureReason` and (for STALE conflicts) `conflictWith`.
- Cancelled-before-replay edits not audited (never reached server).

### Review (#6)
- Pending edits in offline queue can include review-state transitions (submit-for-review, approve, reject).
- Replay applies the standard state-machine guards: capability check at replay time; conflict on replay if state changed in the meantime.
- `If-Match` chain works on review-state hashes too (each transition produces a new hash).

### Hooks (#7)
- Hook firings during offline queue with the save; replayed on reconnect alongside the save.
- Hook handlers run on the receiving instance during replay (not on the offline browser).
- Audit `action: 'hook-fired'` events emitted during replay carry `metadata.replayed: true` for forensics.

### Render (#8)
- Preview during offline serves last-cached rendered HTML from L6 (per `design-rendering.md` Foundational checks: "offline admin previews from last-cached render").
- Iframe shows staleness banner when serving stale render.
- Dynamic fragments (per `design-rendering.md`): offline preview can't fetch from origin; staleness fallback applies.
- Render-for-analysis (validation Cut 3) runs locally during offline (validators are pure functions over manifests + pre-rendered fragments per `design-validation.md` Foundational checks).

### Validation (#9)
- Save-delta validation runs locally during offline (validators are pure functions over manifests; no server roundtrip required).
- Errors surface in standard banner; offline-specific staleness banner coexists.
- Background scanner pauses while offline; resumes on reconnect with incremental rescan.

### Plugin (#10)
- Plugins inherit offline behavior of their host surface — a plugin-supplied hook composes with offline replay; plugin-supplied storage providers must be offline-aware OR documented as online-only.
- Plugin-supplied cache providers register via `api.registerCacheProvider(name, factory)` per `design-plugins.md` Q3; browser-side providers (`IndexedDBCache`, future `OPFSCache`) follow the same registration pattern.

### Cache (#11)
- L4 + L6 share `AdminCache` interface; coordinate independently via SSE invalidation cascade (per `design-cache.md` offline composition section).
- Cached values must be JSON-serializable (per `design-cache.md` Q3 lock); enforces L6 persistence compatibility.
- `subscribe()` mechanism: L6 providers subscribe to server SSE events; invalidate browser entries on server-driven cache changes.
- Browser-side providers extend cache provider taxonomy; same interface, different lifetime / coordination story.

### Collaboration (#13)
- Comments / mentions / notifications composed during offline: queued as edits; replayed on reconnect.
- Notification delivery during offline window: server-side notifications (e.g., "Bob mentioned you in a comment") accumulate; visible on next reconnect.
- Real-time presence / live cursors (Tier 3 future): out of v1; offline-aware presence deferred.

### Site config (`design-config.md`)
- Per-site `admin.offline` config drives behavior per site
- Default-on per Q6 lock; explicit opt-out via `admin.offline.enabled: false`
- Multi-site projects: each site's offline behavior independent

## Migration

Sites without offline mode configured continue to work — pending edits stay in-memory only (current behavior); save fails surface as toast. Operators opt in via `site.config.ts` `admin.offline.enabled: true`.

Existing pending-edits state in Pinia stores migrates to persistent storage when offline mode is enabled — first save queue / cache write triggers IndexedDB initialization; subsequent reads/writes go through persistent layer.

## Future directions

**Multi-author offline collaboration.** Two authors offline on the same content; reconnect produces conflict that's not just save-vs-save but author-vs-author. Composes with concurrent editing (Tier 3 OT/CRDT bet) — out of v1.

**Offline-first PWA installation.** Admin SPA as installable PWA (`manifest.json` + service worker). Standalone window, app-shell pattern. Out of v1; opt-in feature for operators.

**Selective offline cache (per-section).** Operators choose which content to keep offline (e.g., "all blog pages" but not "all marketing assets"). Storage budget management. Out of v1.

**Background sync with deferred replay.** Service Worker `background-sync` API replays the queue even after the tab closes. Browser-dependent; v2 enhancement when modern browsers fully support it.
