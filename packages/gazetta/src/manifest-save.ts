/**
 * Save pipeline — orchestrator for Page and Fragment Manifest writes.
 *
 * Today's `admin-api/routes/pages.ts` PUT handler and the matching
 * fragments.ts handler each inline the same 13-step orchestration:
 * etag check → validate → beforeSave hooks → history → write → sidecars
 * → cache → audit → afterSave hooks → scanner. Two route files, one deep
 * concept duplicated.
 *
 * `saveManifestCore` is the seam that hides the orchestration. Routes
 * become protocol translators (parse Hono request → call → project
 * SaveResult to HTTP). The CLI, plugin-contributed routes, and any
 * future Save-shaped consumer call the same function.
 *
 * Per-kind entry points (`savePage`, `saveFragment` in pages/save.ts +
 * fragments/save.ts — Cuts 3+4) wrap this with kind-specific concerns:
 * locale resolution from `site.pages` vs `site.fragments`, the `route`
 * field preservation Page Manifests need, and per-kind cache prefixes
 * (Fragment Saves invalidate `pages:` too because Fragment References
 * compose into Page summaries).
 *
 * Pipeline order is locked semantics, not configuration. Per
 * `design-hooks.md` "Save flow with hooks": validators run first
 * (validators are pure functions over a manifest), then beforeSave
 * hooks see validated payload, then storage write, then afterSave
 * hooks observe the result. Reordering breaks invariants — audit
 * before write would lie about success.
 *
 * Review-workflow gating (design-review-workflow.md) runs only when the
 * target's `reviewWorkflow.enabled` is true: the review-state precheck
 * locks `pending-review` items before validators run, and the cascade
 * slot applies `invalidateOnSave` to `approved` items after the write.
 * Reserved: Soft-Delete Q6's auto-cancel of scheduled actions on archive
 * shares the cascade slot.
 *
 * Throws are reserved for infrastructure failures (storage write
 * fail, audit infra fail per locked fail-open). Expected outcomes
 * — STALE / EDIT_LOCKED / VALIDATION_FAILED / HOOK_CANCELLED — are typed
 * `SaveResult` variants. Callers `switch` exhaustively; TS narrows.
 */

import type { Principal } from './auth/types.js'
import type { ContentRoot } from './content-root.js'
import type { HistoryProvider } from './history.js'
import { recordWrite } from './history-recorder.js'
import {
  buildHookContext,
  dispatchAfterSave,
  dispatchBeforeSave,
  HookCancellation,
  HookTimeout,
  type HookRegistry,
} from './hooks/index.js'
import { rebuildAssetRefs, type ItemRef } from './assets/asset-deps.js'
import { rebuildFragmentDeps } from './fragment-deps.js'
import { rebuildArchiveAliases } from './archive-aliases.js'
import { computeSaveEtag } from './save-etag.js'
import {
  EDIT_LOCKED_MESSAGE,
  invalidateApproval,
  isEditLocked,
  readSaveReviewState,
  resolveSaveReviewPolicy,
  type ReviewPolicySource,
} from './review/save-gate.js'
import type { Site } from './site-loader.js'
import type { StorageProvider } from './types.js'
import { hasBlockingIssues, runSaveDelta } from './validation/save-delta.js'
import type { ValidatorRegistry } from './validation/registry.js'
import type { RescanCause, ValidationScanner } from './validation/scanner.js'
import type { Issue } from './validation/types.js'

/**
 * Discriminator for the kind of manifest being saved. The pipeline
 * spine is the same for every kind; per-kind wrappers in
 * `pages/save.ts` and `fragments/save.ts` carry the kind through to
 * audit + sidecar + cache invalidation calls.
 */
export type SaveManifestKind = 'page' | 'fragment'

/**
 * Successful save outcome. `etag` is the recomputed save-etag for
 * the new on-disk content; clients update their baseline without a
 * separate GET so offline replay chains work (per
 * `design-offline.md` Q3 — chained If-Match projections).
 */
export interface SaveOk {
  readonly ok: true
  readonly etag: string
}

/**
 * Save-etag mismatch (per `design-offline.md` Q3). Server returned
 * the current manifest body so the client can render a diff. The
 * `currentEtag` lets the client retry-without-conflict if it accepts
 * the server's version verbatim.
 */
export interface SaveStale {
  readonly ok: false
  readonly code: 'STALE'
  readonly current: Record<string, unknown>
  readonly currentEtag: string
}

/**
 * The item is in `pending-review` on a target with review enabled.
 * Edits are locked until the submitter withdraws (design-review-workflow.md
 * locked invariant), so nothing was written.
 */
export interface SaveEditLocked {
  readonly ok: false
  readonly code: 'EDIT_LOCKED'
  readonly message: string
}

/**
 * Save-delta validation produced blocking issues (per
 * `design-validation.md` four-phase model). Only issues introduced
 * by THIS edit are surfaced — pre-existing site debt is the
 * background scanner's surface, not the save handler's.
 */
export interface SaveValidationFailed {
  readonly ok: false
  readonly code: 'VALIDATION_FAILED'
  readonly issues: readonly Issue[]
}

/**
 * A `beforeSave` hook threw `HookCancellation` or `HookTimeout`
 * (per `design-hooks.md` "Composition" — `before*` hooks chain;
 * one throw stops the chain and cancels the operation). The hook's
 * name is surfaced so clients can discriminate which hook
 * cancelled.
 */
export interface SaveHookCancelled {
  readonly ok: false
  readonly code: 'HOOK_CANCELLED'
  readonly hook: string
  readonly reason: string
}

/**
 * Typed union of expected save outcomes. Routes project each
 * variant to HTTP (200 / 409). Callers (CLI, plugin-routes, future
 * save-via-hook) `switch` exhaustively. Adding a new variant is a
 * compile error at every call site — intentional, per the locked
 * decision in Q1.
 */
export type SaveResult = SaveOk | SaveStale | SaveEditLocked | SaveValidationFailed | SaveHookCancelled

/**
 * Audit recorder shape the pipeline calls. Matches the existing
 * `c.var.audit.record` surface from admin-api/middleware/audit.ts
 * — the pipeline doesn't construct events differently from routes.
 *
 * Returns `unknown` (not `RecordResult`) so the pipeline doesn't
 * couple to the audit module's return shape. Strict-mode operators
 * branch on `result.failed > 0`; the pipeline doesn't.
 */
export interface SaveAuditRecorder {
  record(event: {
    action: 'save'
    /**
     * Closed-enum subset of AuditOutcome the save pipeline emits.
     * 'hook-cancelled' fires when a beforeSave hook throws or times
     * out (per design-hooks.md Q3); 'validation-failed' fires when
     * save-delta validators flag blocking issues. Pre-fix shape
     * conflated the two paths under 'validation-failed' — fixed
     * 2026-05 alongside cross-foundation gap #1 coverage.
     */
    outcome: 'success' | 'validation-failed' | 'forbidden' | 'hook-cancelled'
    scope: { kind: SaveManifestKind; name: string }
    metadata?: Record<string, unknown>
  }): Promise<unknown>
}

/**
 * Principal shape the pipeline needs. Re-exports `auth/types.ts:Principal`
 * so callers (`c.var.principal`) pass the real type without conversion.
 * The pipeline doesn't construct principals — only forwards them to
 * `buildHookContext`.
 */
export type SavePrincipal = Principal

/**
 * Source wiring the pipeline needs. Mirrors the relevant subset of
 * `admin-api/source-context.ts:SourceContext` without importing the
 * admin-api type — the pipeline is a domain primitive, not bound to
 * the admin-api boundary. Wrappers (`savePage`, `saveFragment`) pass
 * `source` straight through; the structural compatibility with
 * `SourceContext` lets that work without conversion.
 */
export interface SaveSourceWiring {
  readonly storage: StorageProvider
  readonly contentRoot: ContentRoot
  readonly cache: { invalidatePrefix(prefix: string): Promise<number> }
  readonly history?: HistoryProvider
  readonly targetName?: string
  readonly manifest?: { name?: string } & ReviewPolicySource
}

/**
 * Inputs to `saveManifestCore`. Carries everything the pipeline
 * needs without reaching into route or HTTP concerns.
 *
 * Per Q2 lock: target wiring (cache, history, storage, contentRoot)
 * comes from `SourceContext` upstream; orchestration deps
 * (validators, hooks, scanner, audit) are injected per request.
 * The wrapper functions (`savePage`, `saveFragment`) destructure
 * `source` and assemble this shape.
 */
export interface SaveManifestInput {
  // ----- request data -----

  /** Discriminator for downstream audit + sidecar calls. */
  readonly kind: SaveManifestKind
  /** Item name (folder name under `pages/` or `fragments/`). */
  readonly name: string
  /** BCP-47 locale when saving a Locale Variant; undefined for default. */
  readonly locale?: string
  /** New manifest body (post-component-id, pre-validation). */
  readonly manifest: Record<string, unknown>
  /** Pre-save manifest from the loaded `Site`; null when creating. */
  readonly before: Record<string, unknown> | null
  /** Absolute path the new manifest serializes to. */
  readonly manifestPath: string
  /** Optional save-etag for concurrency check (per design-offline.md Q3). */
  readonly ifMatch?: string
  /**
   * Loaded `Site` (the same instance that resolved `before`). Save-delta
   * validation needs it to walk template + fragment + asset refs.
   */
  readonly site: Site

  // ----- per-kind fields -----

  /**
   * Cache prefixes to invalidate after the write. Page Saves pass
   * `['pages:']`; Fragment Saves pass `['fragments:', 'pages:']`
   * because Fragment References compose into Page summaries.
   */
  readonly cacheInvalidatePrefixes: readonly string[]
  /**
   * Optional fields to include in the recomputed save-etag.
   * Page Saves include `route` (folder-derived; not stored in the
   * file but part of the etag projection chain). Fragment Saves
   * pass an empty object.
   */
  readonly etagExtras: Record<string, unknown>

  // ----- target wiring (from SourceContext) -----

  /** Source wiring; opaque to the pipeline beyond the typed fields below. */
  readonly source: SaveSourceWiring

  // ----- request scope -----

  /** Audit recorder bound to the request (typically `c.var.audit`). */
  readonly audit: SaveAuditRecorder
  /** Authenticated principal driving this save (for hook context). */
  readonly principal: SavePrincipal
  /** Audit-firing emitter used by hook dispatch (forwarded to buildHookContext). */
  readonly hookAuditEmit?: import('./hooks/index.js').HookFiringEmitter

  // ----- admin scope -----

  /** Validator registry (built once at admin boot per design-validation.md Cut 1). */
  readonly validators: ValidatorRegistry
  /** Hook registry; absent when the site has no hooks contributed. */
  readonly hooks?: HookRegistry
  /** Background scanner; absent when scanner not enabled for this admin. */
  readonly scanner?: ValidationScanner
  /**
   * Scanner rescan cause. Per-kind because the scanner's `RescanCause`
   * union differs by kind (Page Saves use `{ kind: 'manifest', item }`
   * to invalidate just the page; Fragment Saves use
   * `{ kind: 'fragment', name }` to walk transitive dependents via
   * `findDependentsFromSidecars`). Wrappers build the right shape.
   */
  readonly scannerCause?: RescanCause
  /** Per-request correlation id; fresh UUID when absent. */
  readonly requestId?: string
}

/**
 * Save pipeline orchestrator — Cut 2.
 *
 * Ports the 13-step spine from `admin-api/routes/pages.ts:290-510`.
 * Pipeline sequence (locked per Q5):
 *
 *   1. etag precheck                 → STALE
 *   2. review-state precheck         → EDIT_LOCKED
 *   3. validators                    → VALIDATION_FAILED
 *   4. beforeSave hooks              → HOOK_CANCELLED
 *   5. history record (pre-write)
 *   6. storage write
 *   7. sidecars (asset/fragment/alias) in parallel
 *   8. cache invalidate (per per-kind prefixes)
 *   9. compute new etag
 *  10. audit success
 *  11. afterSave hooks               (fail-open observers)
 *  12. cascades                      (invalidateOnSave → approved → draft)
 *  13. scanner.rescan                (fire-and-forget)
 */
export async function saveManifestCore(input: SaveManifestInput): Promise<SaveResult> {
  // Step 1 — etag precheck. Mirrors pages.ts:312-339. The current
  // on-disk etag is computed from the in-memory `before` manifest
  // plus the per-kind extras (Page passes route; Fragment passes
  // empty). Absent ifMatch = no concurrency check (last-write-wins).
  if (input.ifMatch && input.before) {
    const currentEtag = await computeSaveEtag({
      ...input.before,
      ...input.etagExtras,
    })
    if (currentEtag !== input.ifMatch) {
      return {
        ok: false,
        code: 'STALE',
        current: { ...input.before, ...input.etagExtras },
        currentEtag,
      }
    }
  }

  // Step 2 — review-state precheck. Off-target sites never read review
  // state. Runs before validators: a locked item can't be saved, so
  // validating it would report issues the author can't act on.
  const reviewPolicy = resolveSaveReviewPolicy(input.source.manifest, input.source.targetName)
  const reviewItem = { contentRoot: input.source.contentRoot, kind: input.kind, name: input.name }
  const reviewState = reviewPolicy ? await readSaveReviewState(reviewItem) : null
  if (isEditLocked(reviewState)) {
    return { ok: false, code: 'EDIT_LOCKED', message: EDIT_LOCKED_MESSAGE }
  }

  // Step 3 — save-delta validation. Same shape as pages.ts:370-394.
  // Validators are pure functions; orchestrator catches infra errors
  // and surfaces them as synthetic issues so the save flow stays
  // predictable. Audit failure with `outcome: 'validation-failed'`
  // before returning the typed result.
  const issues = await runSaveDelta(
    {
      item: {
        kind: input.kind,
        name: input.name,
        itemPath: input.source.contentRoot.relative(input.manifestPath),
      },
      // Cast preserves the validator's structural expectation; the
      // pipeline treats manifests as opaque bags of fields here.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      before: input.before as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      after: { ...input.manifest, ...input.etagExtras } as any,
      site: input.site,
      contentRoot: input.source.contentRoot,
      storage: input.source.storage,
    },
    input.validators,
  )
  if (hasBlockingIssues(issues)) {
    await input.audit.record({
      action: 'save',
      outcome: 'validation-failed',
      scope: { kind: input.kind, name: input.name },
      metadata: input.locale ? { locale: input.locale } : undefined,
    })
    return { ok: false, code: 'VALIDATION_FAILED', issues }
  }

  // Step 4 — beforeSave hooks. Build the HookContext ONCE per
  // request — design-hooks.md "HookContext shape" locks `now` +
  // `requestId` as deterministic across all hooks in a request.
  // Reused for the afterSave dispatch in step 11.
  const hooks = input.hooks
  const hookCtx = hooks
    ? buildHookContext({
        principal: input.principal,
        storage: input.source.storage,
        target: input.source.targetName,
        requestId: input.requestId ?? crypto.randomUUID(),
        site: { name: input.source.manifest?.name },
        auditEmit: input.hookAuditEmit,
      })
    : null
  const hookScope = {
    kind: input.kind,
    name: input.name,
    locale: input.locale ?? undefined,
  }
  let finalManifest: Record<string, unknown> = input.manifest
  if (hooks && hookCtx) {
    try {
      finalManifest = (await dispatchBeforeSave(hooks, hookScope, input.manifest, hookCtx)) as Record<string, unknown>
    } catch (err) {
      if (err instanceof HookCancellation || err instanceof HookTimeout) {
        // Per design-hooks.md Q3 audit lock: cancelled saves record
        // outcome 'hook-cancelled' (closed-enum extension to
        // AuditOutcome already in audit/types.ts). Earlier behavior
        // emitted 'validation-failed' which conflated hook policy
        // with validator semantics — forensic queries filtering on
        // outcome would mistakenly include hook cancellations.
        // metadata.hookCancelled vs metadata.hookTimeout still
        // distinguishes the two cancellation paths for forensics.
        await input.audit.record({
          action: 'save',
          outcome: 'hook-cancelled',
          scope: { kind: input.kind, name: input.name },
          metadata: {
            ...(input.locale ? { locale: input.locale } : {}),
            hookCancelled: err instanceof HookCancellation ? err.hookName : undefined,
            hookTimeout: err instanceof HookTimeout ? err.hookName : undefined,
          },
        })
        return {
          ok: false,
          code: 'HOOK_CANCELLED',
          hook: err.hookName,
          reason: err.message,
        }
      }
      throw err
    }
  }
  // Re-serialize the (potentially mutated) manifest. When no hooks
  // ran, finalManifest === input.manifest so the same serialization
  // is recomputed once — cost is negligible vs the conditional.
  const serialized = JSON.stringify(finalManifest, null, 2) + '\n'

  // Step 5 — history. Record BEFORE the disk write per the
  // recordWrite first-call invariant (pages.ts:442-456). Baseline
  // scan reads current disk state (pre-save); recordWrite overlays
  // the incoming delta to build the snapshot.
  if (input.source.history) {
    await recordWrite({
      history: input.source.history,
      contentRoot: input.source.contentRoot,
      operation: 'save',
      items: [
        {
          path: input.source.contentRoot.relative(input.manifestPath),
          content: serialized,
        },
      ],
    })
  }

  // Step 6 — storage write.
  await input.source.storage.writeFile(input.manifestPath, serialized)

  // Step 7 — sidecars in parallel. Three Usage Sidecar relations
  // (per `sidecars.md`): asset-refs, fragment-deps, archive-aliases.
  // Future asset-soft-delete adds a fourth here in one place.
  const item: ItemRef = input.locale
    ? {
        source: input.kind === 'page' ? 'page' : 'fragment',
        name: input.name,
        locale: input.locale,
      }
    : { source: input.kind === 'page' ? 'page' : 'fragment', name: input.name }
  await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rebuildAssetRefs(input.source.contentRoot, item, input.before as any, finalManifest),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rebuildFragmentDeps(input.source.contentRoot, item, input.before as any, finalManifest),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rebuildArchiveAliases(input.source.contentRoot, item, input.before as any, finalManifest),
  ])

  // Step 8 — cache invalidate. Per-kind prefixes from caller. Page
  // Saves pass ['pages:']; Fragment Saves pass ['fragments:',
  // 'pages:'] because Fragment References compose into Page
  // summaries.
  await Promise.all(input.cacheInvalidatePrefixes.map(p => input.source.cache.invalidatePrefix(p)))

  // Step 9 — recompute save-etag for the new on-disk content. Echo
  // shape MUST match what the next GET produces — extras (route)
  // are folded in here so offline replay projection chains work
  // (design-offline.md Q3).
  const echoShape: Record<string, unknown> = { ...finalManifest, ...input.etagExtras }
  const newEtag = await computeSaveEtag(echoShape)

  // Step 10 — audit success. Records actor + scope + locale (when
  // locale variant). Strict-mode operators check the result.failed
  // count; fail-open default ignores. Recorder never throws.
  await input.audit.record({
    action: 'save',
    outcome: 'success',
    scope: { kind: input.kind, name: input.name },
    metadata: input.locale ? { locale: input.locale } : undefined,
  })

  // Step 11 — afterSave hooks. Observational; failures logged but
  // never propagated. Runs AFTER the audit record so the forensic
  // record is durably committed before observational hooks fire.
  // Per-hook timeout applies; one slow hook bounded by its
  // timeout, not the total.
  if (hooks && hookCtx) {
    await dispatchAfterSave(hooks, hookScope, { payload: finalManifest, etag: newEtag }, hookCtx)
  }

  // Step 12 — cascades. `invalidateOnSave: 'content-diff'` compares save
  // etags, never the publish-state hash: the latter folds in template +
  // fragment hashes and would revoke approval on unrelated dependency
  // changes (design-review-workflow.md "Locked invariants").
  if (reviewPolicy && reviewState?.state === 'approved') {
    const beforeEtag = input.before ? await computeSaveEtag({ ...input.before, ...input.etagExtras }) : null
    await invalidateApproval(reviewItem, reviewState, beforeEtag !== newEtag, input.principal, reviewPolicy)
  }

  // Step 13 — background validation scanner. Fire-and-forget — the
  // save response shouldn't block on scanner work; the scanner
  // emits its own SSE event when the pass completes and the admin
  // UI store re-fetches `/api/validation/issues` on the event.
  if (input.scanner) {
    const cause: RescanCause = input.scannerCause ?? {
      kind: 'manifest',
      item: { kind: input.kind, name: input.name, itemPath: input.manifestPath },
    }
    void input.scanner.rescan(cause)
  }

  return { ok: true, etag: newEtag }
}
