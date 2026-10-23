---
paths:
  - "packages/gazetta/src/pages/**"
  - "packages/gazetta/src/fragments/**"
  - "packages/gazetta/src/admin-api/routes/pages.ts"
  - "packages/gazetta/src/admin-api/routes/fragments.ts"
  - "packages/gazetta/src/admin-api/routes/archive.ts"
  - "packages/gazetta/src/admin-api/routes/rename.ts"
  - "packages/gazetta/src/site-loader.ts"
  - "packages/gazetta/src/resolver.ts"
  - "apps/admin/src/client/components/SiteTree.vue"
  - "apps/admin/src/client/components/PageMetadataEditor.vue"
  - "apps/admin/src/client/components/FragmentMetadataEditor.vue"
  - "apps/admin/src/client/components/ArchiveModal.vue"
  - "apps/admin/src/client/components/RenameModal.vue"
  - "apps/admin/src/client/components/ArchiveConflictModal.vue"
---

# Soft delete — Implementation

Companion to [`design-soft-delete.md`](design-soft-delete.md). Cut sequence with risk ordering.

See `design-soft-delete.md` for the design itself.

## Cut sequence

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending

Branch: `soft-delete-v1` off `main`. **No backwards compatibility** — `DELETE` handlers transition from hard-delete to soft-delete in-place; existing items unaffected (the new `archived` field is optional).

Sequenced data-shape-first (manifest + types + schemas), then engine (loader + renderer + resolver), then admin-API contracts, then UX surfaces. The HTML marker publish mechanism lands alongside the engine work because the renderer needs to know how to emit the markers.

| # | Cut | Status | Risk | Validates |
|---|---|---|---|---|
| 1 | Manifest archive fields + Zod schemas + types | ✓ | Low | Type contract; no runtime behavior |
| 2 | Site-loader archive-aware + renderer alias-aware | ✓ | High | The render-time engine — alias resolution, archive read |
| 3 | Publish artifacts: HTML comment marker on `pages/{name}/index.html` for all worker-served target types (static / ESI / dynamic) | ✓ | High | Runtime archive behavior |
| 4 | `_redirects` host-glue generation for static targets | ✓ | Medium | External-standard exception; per-target opt-in |
| 5 | Archive/unarchive/purge admin-API routes + audit + cache invalidate | ✓ | Medium | Server contract for soft-delete operations |
| 6 | Rename admin-API route (composes archive + create with alias + flatten cascade) | ✓ | Medium-high | Atomic composite; flatten correctness |
| 7 | `DELETE /api/{kind}/:name` becomes soft-delete; new `?permanent=true` for purge | ✓ | Low | Existing handlers cut over |
| 8 | Validators (P1-P5) + save-handler checks (P7/P8) | ✓ | Medium | Validation foundation integration |
| 9 | Capability-gap surfaces: boot validate + author modal + scanner + publish gate | ✓ | Medium | The four-point principle |
| 10 | Admin UI: tree filter toggle + archive/rename/restore/purge modals + read-only editor banner | ✓ | High | The visible UX |
| 11 | Archived-name-conflict prompt UX (Q5 I3) | ✓ | Medium | Restore / Replace / Move-aside flow |
| 12 | Resolution UX for purge-blocked: re-target / drop alias / cascade purge / restore | ✓ | High | The user-resolves-the-block flow |
| 13 | CLI: `gazetta archive list / purge / restore / rename` | ✓ | Low | Operator surface; bulk via `--filter` / `--older-than` |
| 14 | Review-workflow integration (auto-withdraw on archive; restore to draft) | ✓ | Low | Cross-foundation composition; depends on review-workflow shipping |
| 15 | E2E + docs (`docs/soft-delete.md`, `docs/runtime-capabilities.md`) | ✓ | Low | User-facing |

**Shipped 2026-05** on the `soft-delete-v1` branch. Per the lifecycle convention in `feature-design-process.md` ("Lifecycle of an implementation doc"), this status table is candidate for prune-at-merge — the durable design lives in `design-soft-delete.md`, the per-cut detail is recoverable from git log.

## Per-cut scope

### Cut 1: Manifest archive fields + schemas

**Files modified:**
- `packages/gazetta/src/types.ts` — add to `PageManifest` and `FragmentManifest`:
  ```ts
  archived?: boolean
  archivedAt?: string
  archivedBy?: string
  aliasOf?: string
  ```
- `packages/gazetta/src/admin-api/schemas/pages.ts` + `fragments.ts` — extend Zod schemas with the four optional fields
- `packages/gazetta/src/save-etag.ts` — include archive fields in the canonical etag computation (so saves to archive state are concurrency-safe per `design-offline.md` Q3)

**Tests:**
- `packages/gazetta/tests/save-etag.test.ts` — etag changes when `archived` flips; etag stable when content unchanged + archive same
- Schema parsing: archive fields optional; `aliasOf` requires non-empty string when present
- Type-level: `Page.archived === true` narrows correctly

**Risk:** low. Pure data-shape addition; nothing reads the fields yet.

### Cut 2: Site-loader + renderer

**Files modified:**
- `packages/gazetta/src/site-loader.ts`:
  - `loadSite` returns Site with archived items in `pages` and `fragments` Maps (alongside live items, marked via `manifest.archived`)
  - New `liveOnly` filter helper: `liveOnly(site.pages)` returns only `archived !== true`
  - `pageLocales` / `fragmentLocales` propagate parent's archive state
- `packages/gazetta/src/resolver.ts`:
  - `resolveFragmentRef` — when target manifest has `archived: true && aliasOf`, recursively resolve `@aliasOf` instead. Cycle detection via existing `ctx.visited` (shouldn't fire after Q3 flatten, but defensive).
  - When archived without `aliasOf` — throw with marker `ARCHIVED_NO_ALIAS` (caller decides UX)
- New `packages/gazetta/src/archive-helpers.ts`:
  - `isArchived(manifest)` — boolean test
  - `aliasTarget(manifest)` — returns `aliasOf` or null
  - `flattenAliasChain(targetName, site)` — for Q3 flatten

**Tests:**
- Unit: resolve fragment with alias → returns alias target's resolved component
- Unit: resolve fragment with archive-no-alias → throws ARCHIVED_NO_ALIAS
- Unit: resolve fragment with archive + alias pointing at archived (broken invariant) → catches via ctx.visited cycle detection
- Integration: `loadSite` includes archived items; `liveOnly` filter excludes them
- Integration: page composing `@archived-with-alias` renders as if it referenced the alias target

**Risk:** high. Wrong alias resolution = broken renders; missed archive flag = leaked archived content. Heavy on integration tests with synthetic fixtures.

**SOLID:** SRP — `archive-helpers.ts` owns archive predicates; resolver consumes via narrow interface. DIP — site-loader doesn't reach into renderer; renderer reads `Site` shape it already consumes.

### Cut 3: Archive marker emit on published pages

**Files added:**
- `packages/gazetta/src/runtime/archive-marker.ts`:
  - `archiveMarker(marker)` — emit the marker line for an archived page
  - `parseArchiveMarker(input: Uint8Array | string)` — parse marker from leading bytes; returns `{ kind: 'alias', target } | { kind: 'gone' } | null`
  - Pure functions; no I/O; round-trip test pins the contract

**Files modified:**
- `packages/gazetta/src/publish-rendered.ts`:
  - When publishing an archived page (static or ESI mode): emit ONLY the marker line as `pages/{name}/index.html`. No body, no doctype, no CSS/JS — worker short-circuits on the marker; body content for an archived page is dead weight regardless.
  - Page content hash sidecar (used by compare-targets) still written so cross-target compare works.
- `packages/gazetta/src/publish-rendered.ts` (publishPageStatic):
  - Same — emit marker line as the entire HTML file when archived.

**Tests:**
- Unit: `parseArchiveMarker` round-trips for alias, gone, no-marker, malformed-marker (covered by `tests/archive-marker.test.ts`).
- Integration: publish archived page → output HTML is exactly the marker line + newline.
- Integration: publish archived page with `aliasOf` set → marker is `<!-- gazetta:archived alias=X -->`.
- Integration: publish archived page without `aliasOf` → marker is `<!-- gazetta:archived gone -->`.
- Integration: publish a non-archived page → output is unchanged (regression check).

**Risk:** high. Worker contract is the production-load-bearing surface. Wrong marker grammar = broken redirects in production. Tests cover round-trip + every branch.

**Why one mechanism (HTML marker) for all target types:**

The earlier draft locked HTML markers for static + per-edge sidecars
(`pages/{name}/.archived-*`) for ESI. That split was speculative — both
mechanisms work for both target types. ESI's reasoning ("worker needs
to know whether to compose at all") didn't hold up: ESI workers already
read `pages/{name}/index.html` as their composition starting point.
Reading the first 200 bytes is cheaper than `readDir` to find a
sidecar, and one mechanism = one code path = one round-trip primitive.
Sidecar mechanism dropped; HTML marker is the universal mechanism.

### Cut 4: `_redirects` host-glue generation

**Files modified:**
- `packages/gazetta/src/types.ts` — `TargetConfig.redirects?: { format: 'cloudflare' | 'netlify' | 'json' | 'none' }`
- `packages/gazetta/src/publish.ts` — at publish-end, if `target.redirects.format !== 'none'`, walk archived manifests + emit `_redirects` (or equivalent) at target root
- New `packages/gazetta/src/runtime/redirects-emit.ts`:
  - `emitCloudflareRedirects(archives: ArchiveSummary[]): string` — `_redirects` format
  - `emitNetlifyRedirects(archives): string` — same content; Netlify and Cloudflare share grammar
  - `emitJsonRedirects(archives): string` — `redirects.json` for custom integrations

**Tests:**
- Unit: each emitter produces expected output for archive-with-alias and archive-without-alias (410 row)
- Integration: publish to filesystem with `redirects.format: 'cloudflare'` → `_redirects` file exists at target root with correct content
- Integration: publish without setting `redirects.format` → no `_redirects` (default 'none' for non-CDN-format storage)

**Risk:** medium. Wrong format = redirect doesn't fire on host. Heavy on host-format-specific tests.

**Default `redirects.format`:** look at `target.runtime` if set (`cloudflare-pages` → `cloudflare`, `netlify` → `netlify`); else `'none'`. Operator can override.

### Cut 5: Archive/unarchive/purge admin-API routes

**Files added:**
- `packages/gazetta/src/admin-api/routes/archive.ts`:
  - `POST /api/pages/:name/archive` body: `{ aliasOf?: string }` → 200 with archive snapshot
  - `POST /api/pages/:name/unarchive` → 200 with restored page summary
  - `POST /api/pages/:name/purge` query: `?force=true` → 200 OR 409 with resolution body
  - Same shape for `/api/fragments/:name/...`
- `packages/gazetta/src/admin-api/schemas/archive.ts` — Zod schemas (per MCP discipline)

**Files modified:**
- Audit: each handler emits `archive` / `unarchive` / `purge` action with metadata per design Q8
- Cache: invalidate `pages:` / `fragments:` prefix per design Q11
- Capability gates: `delete:pages` / `delete:fragments` for archive + purge; `edit:pages` / `edit:fragments` for unarchive
- Admin force-flag check: `c.var.principal.role === 'admin'` else 403 on `?force=true`

**Tests:**
- Each route round-trip: archive → list (archived appears) → unarchive → list (live again)
- Purge with no refs → 200, manifest gone
- Purge with aliases pointing here → 409 with structured body listing aliases
- Purge with live refs → 409 with structured body listing refs
- Purge with `?force=true` (admin) → 200; non-admin → 403
- Audit: each operation records correct `action` + `outcome` + `metadata`
- Cache: post-archive `GET /api/pages` excludes archived items by default; `?includeArchived=true` includes them

**Risk:** medium. Routes are mechanical wiring; correctness comes from underlying Cut 2 + Cut 8 work.

### Cut 6: Rename admin-API route

**Files added:**
- `packages/gazetta/src/admin-api/routes/rename.ts`:
  - `POST /api/pages/:name/rename` body: `{ to: string, keepAlias?: boolean }` → 200 with new page summary
  - Same for `/api/fragments/:name/rename`
- `packages/gazetta/src/pages/rename.ts` — pure orchestration:
  1. Validate target name (no collision; or run Q5 prompt resolution)
  2. Read source manifest
  3. Refuse if target name is itself archived (return `ARCHIVED_NAME_CONFLICT`)
  4. Archive source with `aliasOf: to` (one save)
  5. Create new manifest at `to` with copied content (one save)
  6. Flatten cascade: walk archived items where `aliasOf === <source>`, rewrite `aliasOf` to `to` (per Q3)
  7. One audit event `action: 'rename'` with `metadata: { fromName, keepAlias, flattenedAliases }`
  8. Cache invalidation
- `packages/gazetta/src/fragments/rename.ts` — same shape

**Tests:**
- Round-trip: rename A → B; A archived with aliasOf=B; B exists at the target's new location
- Flatten: pre-existing archive C with aliasOf=A; after rename A → B, C now has aliasOf=B
- Refuse: rename to existing live name → 409 collision
- Refuse: rename to archived name → 409 ARCHIVED_NAME_CONFLICT
- Composability: rename then unarchive original → both names live (no auto-clash check on unarchive — Q5 I3 handles separately)
- Audit: single `rename` event; `metadata.flattenedAliases` lists touched names
- Cache: post-rename, GET requests for old name return archived view; new name returns live

**Risk:** medium-high. Atomic composite; flatten correctness depends on Cut 2's loader providing the archive set. Property-test the flatten cascade with random archive/rename sequences.

**SOLID:** SRP — `rename.ts` orchestrator owns "rename = archive + create + flatten"; doesn't replicate archive's logic. DIP — depends on archive primitive (Cut 5).

### Cut 7: DELETE handler cutover

**Files modified:**
- `packages/gazetta/src/admin-api/routes/pages.ts` (DELETE handler):
  - Default behavior: archive (was: hard-delete)
  - `?permanent=true` query param: purge (calls Cut 5's purge flow)
  - `?force=true` requires `?permanent=true` AND admin role
- `packages/gazetta/src/admin-api/routes/fragments.ts` — same

**Tests:**
- DELETE without query → archive (item moves to archived state, not removed)
- DELETE with `?permanent=true` → purge with refs check
- DELETE with `?permanent=true&force=true` (admin) → bypass refs check
- Existing tests covering hard-delete behavior get updated to use new query param

**Risk:** low. Mechanical cutover; behaviors composed from Cut 5.

**Migration note:** sites' automated cleanup CLIs that called DELETE will now soft-delete. Documented in CLAUDE.md migration section.

### Cut 8: Validators + save-handler checks

**Files added:**
- `packages/gazetta/src/validation/validators/referenced-archived-without-alias.ts` (P1)
- `packages/gazetta/src/validation/validators/dangling-alias.ts` (P2)
- `packages/gazetta/src/validation/validators/circular-alias.ts` (P3)
- `packages/gazetta/src/validation/validators/archive-not-supported-on-target.ts` (P4)
- `packages/gazetta/src/validation/validators/aliasOf-points-to-archived.ts` (P5)

**Files modified:**
- `packages/gazetta/src/validation/registry.ts` — register the 5 new validators
- `packages/gazetta/src/admin-api/routes/rename.ts` — P7 handler check (refuse rename to archived target)
- `packages/gazetta/src/admin-api/routes/archive.ts` — P8 handler check (refuse archive without aliasOf when refs exist)

**Tests:**
- Unit per validator: matrix of (input shape × archive state × alias state) → expected severity + message
- Integration: save-delta with new ref to archived-no-alias → save 409 with validator issue
- Integration: background scanner with synthetic site has 3 archived fragments → finds expected issue counts
- P7 handler: rename to archived → 409 ARCHIVED_NAME_CONFLICT
- P8 handler: archive without aliasOf when refs exist → 409 ARCHIVE_HAS_LIVE_REFS

**Risk:** medium. Validators are well-defined data checks but depend on `findDependentsFromSidecars` returning correct results; verify that primitive's behavior is unchanged.

**Stage gates per validator:** locked in design-soft-delete.md Q11 matrix; honored at registry time.

### Cut 9: Capability-gap UX (four-point pattern)

**Files added:**
- `packages/gazetta/src/runtime/runtime-capabilities.ts`:
  - `canServeRedirects(target: TargetConfig): boolean` — true for ESI, dynamic, or static-with-worker
  - `canServeGoneStatus(target): boolean` — same
  - Used by validator P4 + admin modals + boot validate

**Files modified:**
- `packages/gazetta/src/config/validate.ts` — at boot, if any target has `runtime: 'plain-static'` AND archived items exist (or rename feature is used), surface boot warning
- `apps/admin/src/client/components/ArchiveModal.vue` (Cut 10) — per-target capability badges
- `packages/gazetta/src/admin-api/routes/publish.ts` — pre-publish modal includes per-target compatibility issues

**Tests:**
- `runtime-capabilities` predicates against each target type
- Boot validate: warning emitted; non-blocking
- Validator P4 fires for archived-on-plain-static
- Pre-publish modal shows per-target issues

**Risk:** medium. The four-point principle is foundational; if it works for archive, it generalizes. Integration tests cover the principle end-to-end.

### Cut 10: Admin UI surfaces

**Files added:**
- `apps/admin/src/client/components/ArchiveModal.vue` — confirm archive, optional aliasOf picker, per-target capability badges
- `apps/admin/src/client/components/RenameModal.vue` — new name input, "Keep alias" checkbox (default true)
- `apps/admin/src/client/components/RestoreButton.vue` (or inline) — single-click on archived items
- `apps/admin/src/client/components/PurgeModal.vue` — confirm + (admin) force option
- `apps/admin/src/client/components/FragmentMetadataEditor.vue` — peer to `PageMetadataEditor.vue`; rename section + archive button + delete button
- `apps/admin/src/client/components/ArchiveBanner.vue` — read-only banner shown above editor when item is archived

**Files modified:**
- `apps/admin/src/client/components/SiteTree.vue`:
  - Tree filter row gains "Show archived (N)" toggle (hidden when N=0)
  - Archived items render greyed; alias suffix in italic
  - Selecting archived item routes to read-only editor pane
- `apps/admin/src/client/components/PageMetadataEditor.vue` — add rename section + archive button
- `apps/admin/src/client/components/EditorPanel.vue` — show ArchiveBanner above editor when manifest is archived
- `apps/admin/src/client/stores/site.ts` — track archived items separately; expose `liveCount` + `archivedCount`

**Tests:**
- Vue Test Utils: tree toggles archive view; archived items render with correct styles
- E2E: rename a page → tree shows archived old name + live new name; preview iframe redirects from old route to new
- E2E: archive a page → tree shows greyed entry; restore → returns to live
- E2E: purge with refs → modal shows resolve list; can re-target ref then retry

**Risk:** high. Visible UX; misalignment with Cut 5/6/7 contracts breaks user trust. Heavy on E2E.

**SOLID:** SRP per component; ArchiveBanner doesn't own logic, displays state. Composition over inheritance — RestoreButton consumed by ArchiveBanner, not extended.

### Cut 11: Archived-name-conflict prompt UX (Q5 I3)

**Files added:**
- `apps/admin/src/client/components/ArchiveConflictModal.vue` — three-option prompt (Restore default / Replace / Move aside / Cancel)
- `apps/admin/src/client/composables/useArchiveConflict.ts` — handles 409 ARCHIVED_NAME_CONFLICT body, opens modal, retries with `?onConflict=...`

**Files modified:**
- `packages/gazetta/src/admin-api/routes/pages.ts` (POST handler):
  - Detect archived-name-conflict on create; return 409 with archive details body per design Q5
  - Handle `?onConflict=restore | replace | moveAside`:
    - `restore`: call unarchive (Cut 5) then return 200 with the unarchived page
    - `replace`: atomically purge + create (one operation; one history revision); resolves alias-pointers per Q4
    - `moveAside`: rename old archive to `<name>-archived-<date>` then create new
- Same for fragments POST

**Tests:**
- Create with archived name (no `?onConflict`) → 409 with archive body
- `?onConflict=restore` → archive unarchived; new content not created
- `?onConflict=replace` → archive purged, new content at name; alias-pointers re-targeted
- `?onConflict=moveAside` → archive renamed with timestamp suffix; new content fresh
- E2E: full UX flow — create with conflict, prompt appears, pick Restore, see live page

**Risk:** medium. Three-way branching; replace path includes purge resolution flow.

### Cut 12: Resolution UX for purge-blocked

**Files added:**
- `apps/admin/src/client/components/PurgeBlockedModal.vue` — lists aliases + live refs; per-row action menus
- `apps/admin/src/client/components/AliasPointerRow.vue` — re-target / drop / cascade-purge / restore actions
- `apps/admin/src/client/components/LiveRefRow.vue` — jump / re-target / remove actions

**Files modified:**
- `apps/admin/src/client/composables/useArchive.ts` — handle 409 DELETE_BLOCKED, open resolution modal
- `apps/admin/src/client/components/PurgeModal.vue` — falls into PurgeBlockedModal on 409

**Tests:**
- E2E: purge with 2 aliases + 1 live ref → modal lists all 3
- Each per-row action works (re-target, drop, etc.)
- "Drop all aliases" bulk action
- "Purge cascade" wipes target + all alias-pointers in one go (still respects live-refs block per design Q4)
- After resolving all, retry purge succeeds

**Risk:** high. Multi-action modal; complex state. Fine-grained tests per action.

### Cut 13: CLI

**Files added:**
- `packages/gazetta/src/cli/archive.ts` — subcommand handler for `gazetta archive ...`
- Commands per design Q13:
  - `archive list [--kind] [--since] [--filter]`
  - `archive purge <name> [--force]`
  - `archive purge --filter=... [--older-than=...] [--force]`
  - `archive restore <name>` / `--filter=...`
  - `archive rename <oldname> <newname>`

**Files modified:**
- `packages/gazetta/src/cli/index.ts` — register `archive` subcommand
- Each CLI command emits standard audit events (composes with Cut 5/6 routes calling the same primitives)

**Tests:**
- CLI smoke per command
- `--filter` parsing (`template:blog-post`, `since:2024-01`, etc.)
- `--older-than` duration parsing (`90d`, `1y`, `48h`)
- Exit code non-zero on any item failure
- Cron-friendliness: stdout structured for greppability

**Risk:** low. CLI composes existing primitives; no new logic.

### Cut 14: Review-workflow integration

**Files modified:**
- `packages/gazetta/src/review/state-machine.ts` (when review-workflow ships) — add transitions:
  - `pending-review → draft` via `auto-withdraw` (triggered by archive operation)
  - On unarchive, item state forced to `draft` regardless of prior state (per design Q9 N-B.1)
- `packages/gazetta/src/admin-api/routes/archive.ts` — when archiving an item in `pending-review`, emit `review-withdraw` (`metadata.autoWithdrawn: true, reason: 'archive'`) before `archive` event
- `packages/gazetta/src/admin-api/routes/archive.ts` — on unarchive, capture `priorReviewState` in audit metadata; restored item starts as `draft`

**Tests:**
- Archive item in `pending-review` → review-withdraw emitted; archive emitted; state cleared
- Restore item that was archived from `approved` → draft; audit shows `priorReviewState: 'approved'`
- `reviewWorkflow.enabled: false` → no review-withdraw event; standard archive path

**Risk:** low. Depends on review-workflow Cut 6 shipping (audit integration). Forward-compatible until then.

**Sequencing:** if review-workflow hasn't shipped when this cut lands, ship Cut 14 logic guarded by `reviewWorkflow.enabled` flag check (no-op when disabled). Feature lands without depending on review-workflow's Tier-3 timeline.

### Cut 15: E2E + docs

**Files added:**
- `tests/e2e/scenarios/archive-rename.spec.ts` — full archive + rename + restore + purge journey
- `tests/e2e/features/archive-conflict.spec.ts` — Q5 prompt UX
- `tests/e2e/features/purge-blocked.spec.ts` — Q4 resolution UX
- `tests/e2e/matrix/runtime-capabilities.spec.ts` — capability-gap surfaces (Cut 9 verification)
- `docs/soft-delete.md` — operator + author guide
- `docs/runtime-capabilities.md` — per-target capability matrix; consumed by archive but generalizable

**Files modified:**
- `CLAUDE.md` — link `docs/soft-delete.md` from public docs section; add `design-soft-delete.md` to design-doc auto-load list
- `ROADMAP.md` — mark soft-delete shipped
- `examples/starter` — add a comment in `site.config.ts` referencing the runtime field

**Risk:** low. Code is stable; docs and tests reflect reality.

## Validation gate (definition of done)

- [ ] All 15 cuts merged
- [ ] Manual test: rename a page → old route 301s; new route serves; alias-aware fragment resolution works
- [ ] Manual test: archive a page without alias → 410 on plain-static? 410 OK on Cloudflare worker; documented limitation on plain S3
- [ ] Manual test: rename A → B → C; A's redirect now goes directly to C (flatten verified)
- [ ] Manual test: purge with refs blocks; admin force bypasses; non-admin force returns 403
- [ ] Validators fire on synthetic broken sites; admin tree shows issues
- [ ] CLI commands smoke-tested; cron-friendly
- [ ] Capability-gap UX visible on plain-static deployments

## Deferred items

| Item | Trigger to revisit |
|---|---|
| Soft-delete extension to assets | v1.5 — composes naturally; ship when concrete demand surfaces |
| Per-locale archive | Concrete demand for "archive only French variant" |
| Manual redirect creation in admin UI | `design-seo.md` Tier-2 punch-list; mechanism supports it |
| UI for bulk archive operations | CLI works today; UI lands when authors ask |
| Auto-archive retention (TTL) | CLI + cron handles today; engine support when concrete demand |
| Temporary redirects (302) | Q14 — separate design pass |
| Scheduled redirects | Q14 — separate design pass |
| Time-locked archives ("archive until date X") | Combined with future scheduling primitive |
| Archive an entire path subtree | Bulk semantics; defer until concrete demand |
| `priorReviewState` on archive event | Review-workflow Cut 6 must ship first |
| Hooks (`beforeArchive`, `afterRename`) | When concrete demand surfaces; saves' standard hooks fire today |

## Open implementation questions

1. **Worker first-200-bytes cache.** Each request reads the page HTML's leading bytes to check for the marker. Live pages (no marker) read the full file shortly after for content; archived pages short-circuit. Worker-local memo of "is this page archived?" with ~30s TTL avoids the duplicate read for live pages. Revisit if a real operator reports per-request latency at scale.
2. **Static target without worker — 410 placeholder vs 404.** Operator-config opt-in to emit 200 placeholder page with "Gone" content. Default: omit; rely on host's 404. (Documented in `docs/runtime-capabilities.md`.) On Pages, Netlify and GitHub Pages the host's 404 shows the target's `404.html` (#1152, `design-soft-delete.md` Q10).
3. **Flatten cascade audit volume.** Each rewritten alias = one history revision + one audit event with `metadata.flattened: true`. At envelope (~5K archives, ~10 aliases/rename), one rename emits ~10 events. Acceptable; below the 25K events/year threshold.
4. **Capability-gap principle generalization.** Cut 9's `runtime-capabilities.ts` predicates apply to archive; generalize when next foundational feature needs the four-point UX (presence, RBAC content filtering, dynamic fragments).
5. **Race on rename of `B → C` while another instance archives `B → D`.** Multi-instance discipline: standard last-write-wins on B's manifest; flatten cascade may run twice with different intermediate states. Property test verifies convergence.
6. **`?onConflict=replace` atomicity.** Replace = purge + create. Two operations; one logical intent. Implementation: single transaction at the storage layer (write-then-rename atomicity per filesystem provider; PUT atomicity per cloud providers). Audit emits `purge` then `create` events with same `requestId` for forensic correlation.

## Estimates

| Cut | Estimate |
|---|---|
| 1 (Manifest fields) | 0.5 day |
| 2 (Loader + renderer) | 2.5 days |
| 3 (HTML marker emit) | 1.5 days |
| 4 (`_redirects` host-glue) | 1 day |
| 5 (Archive/unarchive/purge routes) | 2 days |
| 6 (Rename route) | 2 days |
| 7 (DELETE cutover) | 0.5 day |
| 8 (Validators + handler checks) | 2 days |
| 9 (Capability-gap surfaces) | 1.5 days |
| 10 (Admin UI) | 4 days |
| 11 (Conflict prompt UX) | 1.5 days |
| 12 (Resolution UX) | 2 days |
| 13 (CLI) | 1 day |
| 14 (Review-workflow integration) | 0.5 day |
| 15 (E2E + docs) | 2 days |

**Total: ~25 days.** Budget ~5 weeks with iteration on cuts 2, 3, 6, 10, 12 (the high-risk surfaces).

## SOLID checks per cut

- **Cut 1:** SRP — manifest fields, schemas, save-etag in their respective modules.
- **Cut 2:** SRP — `archive-helpers.ts` owns archive predicates; resolver consumes via narrow interface. DIP — site-loader doesn't reach into renderer.
- **Cut 3:** SRP — `archive-marker.ts` is a pair of pure functions (emit + parse); publish-rendered + publish-static call the emit; workers (cli/serve, future cf-workers) call the parse. ISP — workers consume `parseArchiveMarker` only; publish never parses.
- **Cut 4:** OCP — `redirects-emit.ts` has one function per host format; new formats land additively.
- **Cut 5:** SRP per route handler. DIP — handlers depend on archive primitives, not implementation details.
- **Cut 6:** SRP — `rename.ts` orchestrator owns "rename = archive + create + flatten"; doesn't replicate. DIP — depends on archive primitive.
- **Cut 7:** Mechanical cutover; no SOLID concerns beyond preserving handler purity.
- **Cut 8:** ISP — each validator owns one rule. OCP — registry composition.
- **Cut 9:** SRP — `runtime-capabilities.ts` is pure predicate; consumers are independent.
- **Cut 10:** SRP per component. Composition over inheritance.
- **Cut 11:** SRP — conflict modal handles one shape; composable in editor flow.
- **Cut 12:** SRP per row component; modal composes them.
- **Cut 13:** SRP — CLI dispatch composes existing primitives.
- **Cut 14:** SRP — review-workflow logic stays in review module; archive route composes via dispatch.
- **Cut 15:** No code SOLID concerns; doc and test discipline.
