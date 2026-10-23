---
paths:
  - "packages/gazetta/src/hooks/**"
  - "packages/gazetta/src/admin-api/**"
  - "packages/gazetta/src/admin-api/routes/**"
---

# Hooks — Implementation

Companion to [design-hooks.md](design-hooks.md). Cut sequence with risk ordering, per-cut scope, deferred items.

See [design-hooks.md](design-hooks.md) for the design itself.

## Cut sequence

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending · ✗ superseded

Branch: `hooks-v1` off `main`. Sequenced after AuthIdentity + Audit per Phase 1 dependency order. **No backwards compatibility**; existing save/publish handlers update wholesale.

| # | Cut | Status | Risk | Validates |
|---|---|---|---|---|
| 1 | `hooks/` infrastructure: types, signatures, HookContext shape | ✓ | Low | Type-only foundation |
| 2 | Hook registry + priority-based dispatch + per-hook timeout | ✓ | Medium | The dispatch core |
| 3 | ~~Discovery: site-local `admin/hooks/` walker~~ — **superseded by Cut 9** | ✗ | — | Replaced by factory contributions |
| 4 | Wire `beforeSave` / `afterSave` / `afterLoad` into save/load handlers | ✓ | Medium | First production hook integration |
| 5 | Wire `beforePublish` / `afterPublish` into publish handler | ✓ | Medium | Publish-lifecycle hooks |
| 6 | Wire `beforeUpload` / `afterUpload` into asset upload handler | ✓ | Low-medium | Asset hooks compose with existing UploadPreprocessor/Analyzer |
| 7 | Audit integration: `action: 'hook-fired'` + `outcome: 'hook-cancelled'` extensions | ✓ | Low | Composes with audit foundation |
| 8 | Review-lifecycle hook phases (10 phases per design-review-workflow.md) | ✓ | Medium | Forward-compat for review-workflow feature |
| 9 | Factory contributions in `admin.hooks` + delete Cut 3 file walker | ✓ | Medium | The blessed registration path; aligns with provider factory pattern |
| 10 | Docs + example hooks in starter | ✓ | Low | User-facing |

## Per-cut scope

### Cut 1: `hooks/` infrastructure ✓

**Files added:**
- `packages/gazetta/src/hooks/types.ts` — `HookPhase`, `HookHandler<T>`, `HookContext`, `HookRegistration`, `HookOptions`
- `packages/gazetta/src/hooks/errors.ts` — `HookCancellation`, `HookTimeout`, `RegistrationAfterInitError`
- `packages/gazetta/src/hooks/index.ts` — barrel

**Tests:** type-level checks only

**Why first:** lowest blast radius.

### Cut 2: Hook registry + dispatch + timeout ✓

**Files added:**
- `packages/gazetta/src/hooks/registry.ts` — `HookRegistry` with priority-sorted insertion + tie-break by registration order
- `packages/gazetta/src/hooks/dispatch.ts` — `dispatchBefore<T>(phase, payload, ctx, timeout)` chains; `dispatchAfter(phase, result, ctx)` parallel via `Promise.allSettled`
- Per-hook timeout enforcement via `Promise.race`

**Tests:** priority order + chaining + cancellation propagation + timeout enforcement + after-fire-and-forget failure isolation

**Why second:** the core. Subsequent cuts integrate against this.

### Cut 3: Discovery — site-local walker ✗ (superseded)

**Status: superseded.** Cut 3 shipped a file-walker (`packages/gazetta/src/hooks/discovery.ts`) that scanned `admin/hooks/*.{ts,js}` via jiti at boot. Removed in Cut 9 in favor of factory contributions in `admin.hooks` (per `design-hooks.md` Q4 lock — "Registration").

The discovery walker was correct for a "magic file convention" world; the locked design rejects that world. Operators who can write a TypeScript factory and import it in `site.config.ts` don't need a separate code path that walks files.

**Cut 9 deletes:** `packages/gazetta/src/hooks/discovery.ts`, all callers in `admin-api/index.ts`, and the `discoverSiteLocalHooks` export.

### Cut 4: Wire save / load handlers ✓

**Files modified:**
- `packages/gazetta/src/admin-api/routes/pages.ts` — call `dispatchBefore('beforeSave', payload, ctx)` after validation; `dispatchAfter('afterSave', result, ctx)` after storage write
- Same pattern in `fragments.ts`
- Add `dispatchAfter('afterLoad', result, ctx)` in load paths

**Tests:** integration tests for hook firing during real save → confirms order: validators → beforeSave → storage → afterSave

### Cut 5: Wire publish handler ✓

**Files modified:**
- `packages/gazetta/src/admin-api/routes/publish.ts` — `dispatchBefore('beforePublish', items, ctx)` + `dispatchAfter('afterPublish', result, ctx)`

**Tests:** integration during publish → confirms hook chain works for multi-item publishes

### Cut 6: Wire asset upload handler ✓

**Files modified:**
- `packages/gazetta/src/admin-api/routes/assets.ts` — `dispatchBefore('beforeUpload', { asset, bytes }, ctx)` BEFORE existing UploadPreprocessor / UploadAnalyzer pipeline; `dispatchAfter('afterUpload', result, ctx)` after manifest write

**Tests:** integration confirms hooks compose cleanly with existing preprocessor/analyzer (which run first per design-hooks.md asset-upload-note)

### Cut 7: Audit integration ✓

**Files modified:**
- `packages/gazetta/src/audit/types.ts` — extend `action` enum with `'hook-fired'`; extend `outcome` enum with `'hook-cancelled'` + `'timeout'`
- `packages/gazetta/src/hooks/dispatch.ts` — emit audit event per hook firing with name + priority + phase + durationMs

**Tests:** dispatch emits audit events correctly; failure outcomes record correctly

### Cut 8: Review-lifecycle hook phases ✓

**Files added:**
- 10 review-phase types in `packages/gazetta/src/hooks/types.ts`: `BeforeSubmitForReviewHook`, `AfterSubmitForReviewHook`, `BeforeApproveHook`, `AfterApproveHook`, `BeforeRejectHook`, `AfterRejectHook`, `BeforePublishRequestHook`, `AfterPublishRequestHook`, `BeforePublishApproveHook`, `AfterPublishApproveHook`

**Tests:** types compile; registry accepts review phases

**Why now:** types only; the actual review state machine that fires these is Phase 2 work. Forward-compat preparation.

### Cut 9: Factory contributions in `admin.hooks` ✓

The blessed registration path. Operators (and plugin authors) export a factory that returns `HookContribution`; site config invokes it inside `admin.hooks`. Same shape for site-local code and npm-distributed plugins.

**Files added:**
- `packages/gazetta/src/hooks/contribution.ts` — `HookContribution` + `HookEntry` types (`source` + `hooks: HookEntry[]`)

**Files modified:**
- `packages/gazetta/src/types.ts` — extend `SiteManifest['admin']` with optional `hooks?: ReadonlyArray<HookContribution>`
- `packages/gazetta/src/admin-api/index.ts` — `buildHooksRegistry({ contributions })` iterates contributions, calls `registry.register(entry.phase, entry.handler, entry.options, contribution.source)` for each entry, then `registry.seal()`. Drops the `adminDir` parameter.
- `packages/gazetta/src/hooks/index.ts` — export `HookContribution` + `HookEntry` types

**Files deleted:**
- `packages/gazetta/src/hooks/discovery.ts` (the Cut 3 walker)
- Any internal callers of `discoverSiteLocalHooks`
- Cut 3's discovery test file

**Tests:**
- `tests/hooks-contribution.test.ts` — `buildHooksRegistry` accepts an array of contributions, registers each entry under the right phase with the contribution's `source`, supports duplicate sources (operator invokes the same factory twice with different config)
- Update existing integration tests that previously seeded the registry via `admin/hooks/` files — they now seed via inline contributions in the test site config

**Validation surface:**
- TypeScript catches mistakes at config-eval (operator forgets to invoke the factory; passes wrong arg shape)
- `source` is required on `HookContribution` — TS error if omitted
- Empty `admin.hooks` array is fine — no hooks register; same as omitting the field

**Why now:** the deletion + simplification land together so we don't ship a build with two registration paths. One blessed pattern, one mental model.

### Cut 10: Docs ✓

**Files added/modified:**
- `docs/hooks.md` (NEW) — operator guide:
  - Why hooks exist + lifecycle phases table
  - Authoring a site-local hook (factory function returning `HookContribution`)
  - Wiring it in `site.config.ts admin.hooks`
  - Importing an npm-distributed plugin (same shape; just a different import path)
  - When to use multiple handlers in one contribution (shared closure state, e.g., a CDN-purge plugin wiring `afterSave` + `afterPublish`)
  - Trust posture (npm packages have full Node access; vetting responsibility is the operator's)
  - Audit metadata (`source`, `hookName`, `hookPhase`, `durationMs`)
- `examples/starter/admin/hooks/auto-slugify.ts` (NEW) — example site-local hook factory
- `examples/starter/sites/main/site.config.ts` — wire `autoSlugify()` into `admin.hooks`

**Why last:** code is stable; docs reflect the shipped surface.

## Validation gate (definition of done)

- [x] All 10 cuts merged (Cut 3 superseded by Cut 9)
- [ ] At least one example hook factory exists in `examples/starter/admin/hooks/` and runs in the starter site
- [ ] Audit log records hook firings correctly (composing with audit foundation)
- [ ] No file walker code remains in `packages/gazetta/src/hooks/`

## Deferred items

| Item | Trigger to revisit |
|---|---|
| Render-lifecycle hooks (`beforeRender`, `afterRender`) | Render formalization in Phase 3; render hooks reserved per design-rendering.md |
| Validation hooks | Permanently rejected (validators are pure functions per design-validation.md) |
| Audit hooks | Audit observes via the audit log itself; no hook firings |
| `beforeLoad` | Nothing to mutate yet |
| Fire-and-forget mode (`mode: 'async'`) | Concrete operator demand; v1 is sync-blocking only |
| Total operation timeout | Per-hook timeout is the cap; total cap reserved if observed pain surfaces |
| Hot-reload of hook files | Out of scope; v1 hook config changes require admin restart |
| Disable-by-config (`admin.hooks.disable`) | v2 ergonomic; v1 disable = remove the contribution from the array |
| `optional()` wrapper around plugin contributions | Reserved if plugin foundation ever ships a separate runtime; v1 npm packages run as operator-trusted code per `design-provider-config.md`'s plugins-deferred-indefinitely posture |

## Open implementation questions

1. **HookContext.storage as ReadOnlyStorageProvider** — locked to Proxy approach (the same pattern used in Cut 4: write methods throw `TypeError` at call time; read methods bind transparently). Less code duplication than maintaining a parallel narrow type.
2. **Per-hook timeout default tunable per phase?** v1 ships uniform 5s default. Per-phase override deferred unless concrete operator pain surfaces.
3. **Naming of `source` for site-local contributions** — convention is `'site-local:<name>'` (e.g., `'site-local:auto-slugify'`); the colon separates the namespace from the operator's identifier. Plugin authors use the package name (`'@example/cdn-purge'`). Soft-enforced via doc; not validated at registration.

## Estimates

| Cut | Estimate | Status |
|---|---|---|
| 1 (Infrastructure) | 0.5 day | ✓ shipped |
| 2 (Registry + dispatch) | 1.5 days | ✓ shipped |
| 3 (Discovery — superseded) | — | ✗ deleted in Cut 9 |
| 4 (Wire save/load) | 1 day | ✓ shipped |
| 5 (Wire publish) | 0.5 day | ✓ shipped |
| 6 (Wire asset upload) | 0.5 day | ✓ shipped |
| 7 (Audit integration) | 0.5 day | ✓ shipped |
| 8 (Review-lifecycle phases) | 0.5 day | ✓ shipped |
| 9 (Factory contributions + Cut 3 deletion) | 1 day | ✓ shipped |
| 10 (Docs + starter example) | 1 day | ✓ shipped |

**Total: ~7 days.** With CI iteration, budget ~1.5 weeks. All cuts shipped (Cut 3 superseded by Cut 9).

## SOLID checks per cut

- **Cuts 1-2**: SRP per file (registry / dispatch / errors). DIP — consumers depend on `HookHandler<T>` type.
- **Cut 3 (superseded)**: Discovery was a separate module — correct SRP at the time. Cut 9 collapses it because the abstraction wasn't paying its way; deletion is the SOLID move.
- **Cuts 4-6**: each route handler integrates uniformly; no per-route dispatch logic. ISP — handlers see only the dispatch API.
- **Cut 7**: composition with audit; doesn't break either layer's contracts.
- **Cut 9**: SRP — `HookContribution` is one shape, `buildHooksRegistry` is one orchestrator. OCP — adding new phases extends `HookPhase`/`HookEntry`; no orchestrator change. LSP — both site-local and plugin contributions satisfy the same `HookContribution` contract.
