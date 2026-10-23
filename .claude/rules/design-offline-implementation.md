---
paths:
  - "apps/admin/src/client/**"
  - "packages/gazetta/src/admin-api/**"
  - "**/offline*"
  - "**/service-worker*"
---

# Admin offline mode — Implementation

Companion to [design-offline.md](design-offline.md). Cut sequence with risk ordering.

See [design-offline.md](design-offline.md) for the design itself.

## Cut sequence

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending

Branch: `offline-v1` off `main`. Sequenced after AdminCache (depends on `AdminCache` interface for L6 provider). **No backwards compatibility**; existing pending-edits stores migrate to IndexedDB-backed persistence.

| # | Cut | Status | Risk | Validates |
|---|---|---|---|---|
| 1 | npm dependencies + setup: `idb`, `@tanstack/vue-query`, `@tanstack/query-async-storage-persister`, `vite-plugin-pwa` | ✓ | Low | Tooling foundation |
| 2 | `IndexedDBCache` provider (browser-side `AdminCache`) using `idb` | ✓ | Medium | The L6 cache primitive |
| 3 | Provider selection: `IndexedDBCache` primary; `MemoryCache` fallback when IndexedDB unavailable | ✓ | Low | Graceful degradation |
| 4 | BroadcastChannel cross-tab invalidation | ✓ | Low | Multi-tab coordination |
| 5 | Vue Query setup + `IndexedDBPersister` bridge to L6 | ✓ | Medium | Query/mutation cache + offline queue |
| 5b | Site tree reads through the query cache: site + active-target stores via `useQueryClient()`, cache fallback (immediate when offline), restore wait, 7-day retention, `buster` = version + site + owner (design-offline.md "The site tree reads through the query cache"; #962) | ✓ | Medium | Offline cold load shows the site tree; deep links load offline |
| 6 | Connection state Pinia store: hybrid `navigator.onLine` + heartbeat to `/api/health` | ✓ | Medium | 5-state model |
| 7 | Health endpoint `GET /api/health` | ✓ | Low | Server-side support |
| 8a | Pending-edits store migration — `editorStructural` only (pure-data subset) | ✓ | Medium | Structural edits survive reload |
| 8b | usePersistedEditsStore (cross-page key) + auto-mirror on markDirty/stashCurrent + navigate seam rebuilds target via buildTarget + clear-on-save | ✓ | Medium | Content edits survive reload |
| 8c | Draft store + principal scoping: own IndexedDB store keyed `[site, owner, target, …]`, `GET /api/me`, boot classification + purge before hydration (design-offline.md "Unsaved drafts live in their own store"; #962) | ✓ | Medium-high | No draft crosses users, targets, sites or tabs |
| 9 | Save-etag plumbing: server `ETag` + `If-Match` + 409 STALE + client `StaleSaveError` + `getPageWithEtag` / `updatePage(..., ifMatch)` | ✓ | High | Conflict-detection contract |
| 9b | useEditorEtags Pinia store + useEditorActions integration (selection.ts If-Match plumbing, updateManifest helper, EditorPanel ConflictBanner wiring) | ✓ | High | End-to-end save-conflict flow |
| 9c | Save queue: client-generated ids, chained If-Match, replay on reconnect (see "Cut 9c: Save queue" below) | ☐ | High | Offline saves go out after reconnect |
| 10 | Conflict UX: useSaveConflictsStore + ConflictBanner.vue + ConflictDiffView.vue (Show / Discard actions; no overwrite per Krug lock) | ✓ | High | Conflict resolution UX |
| 11 | Service worker via vite-plugin-pwa (injectManifest): app-shell precache + skipWaiting handshake + Refresh-toast update flow | ✓ | Medium | Cold-load offline reliability |
| 12 | OfflineBanner global visibility + Send now + reconnect toast (per-item cloud-slash icons defer to Cut 13's queue) | ✓ | Medium | Krug-aligned visibility |
| 13 | Mid-save connection-loss reconcile: detect TypeError → GET-and-compare → silent success or surface StaleSaveError | ✓ | Medium | Edge case correctness |
| 14 | useStorageQuota composable + StorageQuotaBanner (80% threshold; per-tab-session dismiss-once UX) | ✓ | Low | Operator UX |
| 15 | Audit integration: `metadata.replayed: true` + `queuedAt` + `replayedAt` | ☐ | Low | Composes with audit foundation |
| 16 | docs/offline.md author + operator guide; CLAUDE.md listing updated | ✓ | Low | User-facing |

## Per-cut scope

### Cut 1: Dependencies

**Files modified:**
- `apps/admin/package.json` — add `idb`, `@tanstack/vue-query`, `@tanstack/query-async-storage-persister`, `vite-plugin-pwa`

**Tests:** install + build

### Cut 2: `IndexedDBCache`

**Files added:**
- `apps/admin/src/client/cache/indexeddb-cache.ts` — implements `AdminCache` from `gazetta` package

**Tests:** `adminCacheContractTests` from `gazetta/testing` runs against this provider

### Cut 3: Provider selection

**Files added:**
- `apps/admin/src/client/cache/provider-selector.ts` — boot-time probe; falls back to MemoryCache + warning banner

**Tests:** IndexedDB unavailable → MemoryCache returned + banner emitted

### Cut 4: BroadcastChannel

**Files modified:**
- `apps/admin/src/client/cache/indexeddb-cache.ts` — broadcast on invalidate; subscribe handler invalidates local in-memory mirror

**Tests:** two tabs simulated; invalidation propagates

### Cut 5: Vue Query setup + persister bridge

**Files added:**
- `apps/admin/src/client/queries/client.ts` — `QueryClient` with `IndexedDBPersister` adapter
- `apps/admin/src/client/queries/persister.ts` — bridges Vue Query to `IndexedDBCache`

**Tests:** Vue Query state rehydrates from IndexedDB at boot

### Cut 5b: Site tree reads through the query cache (shipped, #962)

**Tests:**
- `tests/e2e/production-offline.test.ts` — offline reload shows the site tree (`site-page-home`); an offline deep link loads (editor offline: #969)
- `apps/admin/tests/readThroughCache.test.ts` — online fetch; fallback to cache on failure; immediate cache when the connection store is offline (no fetch); no cache → error; waits for the restore promise; key carries the request's target
- `apps/admin/tests/siteStore.test.ts` (new), `activeTarget.test.ts` — public API unchanged; target switch reads the new target's key

**Files:** `queries/read-through.ts` (helper); `stores/site.ts`, `stores/activeTarget.ts`; `queries/client.ts` (7 d, restore promise); `main.ts` (buster, restore wiring); `vite.config.ts` (`define` for the version); `docs/offline.md`.

**Found while building:** TanStack persists only `success` queries by default, so a failed offline refresh erased the stored cache; and the service worker had no navigation fallback, so deep links failed offline. Both fixed in this cut. Nothing else at boot blocked the tree.

### Cut 6: Connection state store

**Files added:**
- `apps/admin/src/client/stores/connectionState.ts` — Pinia store; 5 states; navigator.onLine + heartbeat hybrid; subscribes Vue Query's onlineManager

**Tests:** state transitions on simulated connection events

### Cut 7: Health endpoint

**Files added:**
- `packages/gazetta/src/admin-api/routes/system.ts` — `GET /api/health` (extends from cache stats route)

**Tests:** returns `{ ok: true, timestamp }`

### Cut 8a: Pending-edits store migration — structural only (shipped)

**Files added:**
- `apps/admin/src/client/stores/_pendingEditsPersistence.ts` — coordinator; deep-watches `editorStructural.entries`, debounce-writes a JSON-shaped snapshot to the cache, hydrates at boot
- `apps/admin/tests/pendingEditsPersistence.test.ts` — coordinator contract tests

**Files modified:**
- `apps/admin/src/client/stores/editorStructural.ts` — adds internal `_hydrateFromSnapshot` method (leading underscore) so persistence can restore `original` + `pending` as-is without re-recording the discard baseline through the intent-named mutators
- `apps/admin/src/client/main.ts` — attaches persistence after Pinia install + before mount; awaits initial hydration

**Tests:** hydration from a previously-persisted snapshot; debounced write on mutation (~300ms default); cache invalidation on empty store; debounce coalesces rapid mutations; preserves discard baseline across reload; wrong-version snapshots ignored; dispose() stops the watcher

**Why structural-only:** pure data — no closures, no transient mounts. Reorders are also higher-friction for an author to redo than re-typing a field, making them the highest-value persistence target for this cut. `editorStash` + `editorContent` defer to Cut 8b because both stores carry an `EditingTarget` with a `save` closure bound to the page's selection state; the closure-rebuild flow on rehydration deserves its own focused cut.

### Cut 8b: Pending-edits store migration — content + stash (deferred)

**Files modified:**
- `apps/admin/src/client/stores/_pendingEditsPersistence.ts` — extend with `attachStashPersistence` + `attachContentPersistence`
- `apps/admin/src/client/composables/useEditorActions.ts` — navigate flow consults persisted content; `EditingTarget` rebuild on hydration

**Tricky bit — closure rebuild on rehydration:** `EditingTarget.save` is `buildSaveFn(namePath)` (page selection state captured at navigate time). Persisted entries carry a "data-only snapshot" (no closure). On `navigate(path)`, the action checks the persisted entry and rebuilds the `save` closure from the freshly-fetched manifest's selection context.

**Tests:** browser reload preserves stashed edits across pages; current-page dirty state restored on reload via navigate flow; stash restore picks up persisted dirty content during multi-page-edit scenario.

### Cut 8c: Draft store + principal scoping (shipped, #962)

Replaces Cuts 8a/8b's snapshot persistence (two coordinators writing whole snapshots into `AdminCache`) with a dedicated draft store. Closes, all reproduced 2026-10-18: drafts crossing users on a shared profile; tabs overwriting each other's drafts. Also closes drafts crossing targets and sites, and eviction of drafts.

**Tests first:**
- `packages/gazetta/tests/admin-api-me.test.ts` — `/api/me` for `none` and `forwarded-user`; response matches the schema
- `apps/admin/tests/draftStore.test.ts` (`fake-indexeddb`) — put/delete one record; load by `[site, owner, target]`; owner purge deletes only other owners of this site in one transaction; two store instances (two tabs) don't delete each other's records; memory fallback has the same contract
- `apps/admin/tests/draftOwner.test.ts` — classification: schema-valid JSON → known; network error/timeout → offline, uses record; non-OK or HTML → unknown, loads nothing and deletes nothing; known-but-different → purge before load
- `apps/admin/tests/persistedEditsIntegration.test.ts` — a draft on one target is not restored on another
- e2e (`forwarded-user` + `allowAnyOrigin`, own dev server): A's unsaved draft does not appear for B; B's next online boot deletes A's records

**Files:** `admin-api/routes/me.ts` + `schemas/me.ts`; `apps/admin/src/client/drafts/` (new: store, IndexedDB + memory implementations, owner classification); `stores/_pendingEditsPersistence.ts` (rewritten onto the draft store — each store mutation maps to put / delete / delete-in-scope); `persistedEdits.ts` + `editorStructural.ts` (keys carry target); `main.ts` boot order; `docs/offline.md`.

**Migration:** the old `pending-edits:*` cache keys are deleted once at boot; drafts saved before the upgrade are dropped (no backwards compatibility, per this doc's header).

**Resolved (2026-10-18):** structural keys now carry the locale. Locale variants are whole files with their own component list; without the locale a French reorder restored after a reload in English was saved into `page.json`, French hero text included (reproduced). The save writes to the edit's own locale file.

### Cut 9: Save-etag plumbing (shipped)

**Files added:**
- `packages/gazetta/src/save-etag.ts` — shared `computeSaveEtag(manifest)`. SHA-256 truncated to 16 hex over canonical manifest JSON. Web Crypto API; works in Node 18+ AND browsers. Exposed via `gazetta/save-etag` subpath so the client can import without pulling in `node:crypto`-flavored modules.
- `packages/gazetta/tests/save-etag.test.ts` — 12 unit tests pin determinism + field coverage + canonical-key ordering + null vs undefined.
- `apps/admin/tests/api-save-etag.test.ts` — 11 client tests via mocked fetch.

**Files modified:**
- `packages/gazetta/src/admin-api/routes/pages.ts` — GET sets `ETag` header; PUT honors `If-Match` and returns 409 STALE with `current` manifest body + `currentEtag` on mismatch; success echoes the new etag both as response header AND as `etag` field in body so chain projection works without a follow-up GET. The echo shape includes `route` so it matches the next GET.
- `packages/gazetta/src/admin-api/routes/fragments.ts` — same shape (without `route`/`metadata` fields since fragments don't carry them).
- `packages/gazetta/tests/admin-api.test.ts` — 7 new tests pin: header round-trip on pages + fragments, optional If-Match (last-write-wins), stale 409 with current body, chained projection for offline replay.
- `apps/admin/src/client/api/client.ts` — new `StaleSaveError` peer to `ValidationFailedError`; `requestWithEtag<T>` helper; `getPageWithEtag` / `getFragmentWithEtag`; `updatePage` / `updateFragment` extend opts with `ifMatch?: string`.
- `packages/gazetta/package.json` — `gazetta/save-etag` subpath export.

**Why two etags coexist:** the publish-state `.{8hex}.hash` includes template + fragment hashes (drives publish/cache invalidation: a template change must invalidate every dependent page). The save etag is pure manifest content (the browser can't access template/fragment hashes; mixing them would force false 409s on every author after a template edit). Two etags, two semantics, two consumers.

**Why SHA-256 truncated to 16 hex (not MD5 truncated to 8):** save etags collide more often than publish hashes (every save is a new etag candidate; many saves per page over a long offline session). 8 hex = 4B keyspace; tens of thousands of saves would hit the birthday bound. 16 hex = 18.4 quintillion keyspace.

**Tests:** see file references above. All tests green; no regressions on existing `VALIDATION_FAILED` 409 path.

**Why Cut 9 is split into 9 + 9b:** the server contract + client API plumbing (this cut) is sufficient for any consumer that tracks the etag itself. The full save-queue Pinia store with Vue Query mutation-queue integration + per-item chain state machine is a separate surface area that would bloat this commit. The save queue (Cut 9c) lands when concrete consumer demand surfaces (likely with `useEditorActions` integration when Cut 8b's content-edit persistence ships).

### Cut 9c: Save queue (not built; planned in ROADMAP Next)

**Files added:**
- `apps/admin/src/client/queries/save-queue.ts` — client-generated UUIDs; chained If-Match projections; sequential replay on reconnect

**Files modified:**
- `packages/gazetta/src/admin-api/routes/pages.ts` — return `etag: <content-hash>` on read; honor `If-Match` on write; return `409 STALE` with current version metadata on mismatch

**Tests:** offline saves chain correctly; replay produces sequential success; conflict on first save pauses subsequent

### Cut 10: Conflict UX

**Files added:**
- `apps/admin/src/client/components/ConflictBanner.vue` — Show diff / Discard actions
- `apps/admin/src/client/components/DiffView.vue` — field-by-field semantic diff

**Tests:** 409 STALE response triggers banner; "Discard" reverts pending edits; "Show diff" navigates to diff view

### Cut 11: Service worker

**Files modified:**
- `apps/admin/vite.config.ts` — add `vite-plugin-pwa` with `injectManifest` strategy
- `apps/admin/src/client/sw.ts` (NEW) — service worker source; precache app shell

**Tests:** SW registers in production build; cold-load offline serves from cache

### Cut 12: UX indicators

**Files added/modified:**
- `apps/admin/src/client/components/SyncStatusIndicator.vue` — cloud-with-slash icon component
- `apps/admin/src/client/components/OfflineBanner.vue` — global banner per connection state

**Tests:** indicator only shows when relevant (Krug "absence is a state")

### Cut 13: Mid-save connection-loss

**Files modified:**
- `apps/admin/src/client/queries/save-queue.ts` — handle in-flight save when connection drops; retry with same If-Match for idempotency

**Tests:** simulated mid-save drop → retry succeeds with idempotent server response

### Cut 14: Storage quota warning

**Files added:**
- `apps/admin/src/client/composables/useStorageQuota.ts` — `navigator.storage.estimate()` polling; warning at 80%

**Tests:** simulated 80% quota → banner visible

### Cut 15: Audit integration

**Files modified:**
- `packages/gazetta/src/audit/types.ts` — `metadata.replayed: true`, `metadata.queuedAt`, `metadata.replayedAt` field schemas
- Save handlers — record audit events with replay metadata when If-Match indicates replay

**Tests:** replay events audit with full metadata

### Cut 16: Docs

**Files added/modified:**
- `docs/offline.md` (NEW) — operator + author guide

## Validation gate (definition of done)

- [ ] All 18 cuts merged (1-7, 8a, 8b, 9, 9b, 10-16)
- [ ] Manual test: edit page offline → close laptop → reopen → edits persist → reconnect → sync invisibly
- [ ] Conflict scenario test: edit offline + concurrent online edit → reconnect → conflict banner surfaces
- [x] Service worker test: cold-load admin offline → SPA loads from cache (`tests/e2e/production-offline.test.ts`, CI job `e2e-prod`; site data from IndexedDB on that cold load does not load yet)

## Deferred items

| Item | Trigger to revisit |
|---|---|
| Background Sync API (replay with tab closed) | v2 ergonomic improvement |
| PWA install prompt (`manifest.json`) | Operator opt-in feature |
| Push notifications | When Notification Provider extension surface ships email/Slack |
| Three-way merge conflict resolution | Concurrent editing Tier 3 strategic bet |
| Per-locale comments / per-locale conflict | Concrete demand |
| OPFS as L6 provider | Site exceeds IndexedDB quota OR worker-thread sync writes needed |
| `last-cached` failure mode | Concrete demand |
| Activity feed | Composes from audit log when feed surface exists |

## Open implementation questions

1. **`IndexedDBPersister` debounce**: how often to write Vue Query cache to IndexedDB? Recommend 500ms debounce on changes; trade-off between write frequency and data-loss-on-crash window.
2. **Service worker update flow**: vite-plugin-pwa supports `skipWaiting` + `clientsClaim`; recommend with toast notification "New version available — refresh." Author dismisses or refreshes; auto-activates on next navigation.
3. **`If-Match` etag granularity**: per-page-manifest (current sidecar `.{8hex}.hash`) is fine. For inline-component-level conflict detection (future), would need per-component etags; deferred.

## Estimates

| Cut | Estimate |
|---|---|
| 1 (Deps) | 0.5 day |
| 2-4 (IDB cache + selection + BroadcastChannel) | 2 days |
| 5 (Vue Query) | 1.5 days |
| 6-7 (Connection + health) | 1 day |
| 8a (Structural pending-edits) | 0.5 day |
| 8b (Stash + content pending-edits, with closure rebuild) | 1.5 days |
| 9 (Save-etag plumbing) | 1 day |
| 9c (Save queue + Vue Query integration) | 1.5 days |
| 10 (Conflict UX) | 2 days |
| 11 (Service worker) | 1.5 days |
| 12 (UX indicators) | 1.5 days |
| 13-14 (Mid-save + quota) | 1 day |
| 15 (Audit) | 0.5 day |
| 16 (Docs) | 1 day |

**Total: ~16-18 days** (8 split into 8a/8b). Highest cut count + highest risk pass; budget ~3-4 weeks with iteration.

## SOLID checks per cut

- **Cut 2-4**: SRP per file (cache provider / selector / cross-tab broadcaster). DIP — admin code consumes `AdminCache`.
- **Cut 5**: Vue Query as separate layer; doesn't blend into AdminCache responsibilities.
- **Cut 9-10**: save queue + conflict UX are separate modules. Diff view is its own component.
- **Cut 11**: service worker scope is explicit (app shell only); doesn't touch query / mutation logic.
- **Cut 12**: indicators consume connection-state store; no business logic in components.
