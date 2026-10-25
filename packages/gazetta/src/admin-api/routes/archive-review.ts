/**
 * Cut 14 — review-workflow integration for archive lifecycle.
 *
 * Per `design-soft-delete.md` Q9 (N-A.2 + N-B.1):
 *   - Archive on `pending-review` → auto-withdraw fires first; then archive.
 *     Two audit events emitted: `review-withdraw` with
 *     `metadata.autoWithdrawn: true`, then `archive`.
 *   - Archive on `approved` → approved state discarded; no synthetic
 *     withdraw event (the prior state is recorded in archive metadata
 *     as `priorReviewState: 'approved'`).
 *   - Archive on `draft` → no review-related side effects.
 *   - Restore (unarchive) → always to `draft`, regardless of prior state.
 *     Author re-submits if review needed. Auto-restoring to `approved`
 *     would let stale content ship without re-validation.
 *
 * # Review state lives in the sidecar, not the manifest (#1344)
 *
 * The review-workflow foundation (Cut 3 of #517) stores per-item
 * review state at `.gazetta/review/{kind}/{name}/state.json` via
 * `review/sidecars.ts`; saves read it through the save-gate. This
 * module originally read a speculative `manifest.reviewState` field
 * that was never written, so the archive/restore paths silently
 * no-op'd. The helpers below read the sidecar as the single source
 * of truth and reset it (clear = back to draft) once the archive
 * lifecycle has consumed the state; the audit log carries the
 * forensic record (`priorReviewState`, the auto-withdraw event).
 *
 * Gate is data-driven (sidecar presence), not config-driven
 * (`reviewWorkflow.enabled` flag): "if this item has review state,
 * handle it; else no-op."
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns the archive ↔ review-state interaction.
 *     `archive.ts`'s `handleArchive` calls the helpers and consumes
 *     their returned audit events; doesn't replicate state-machine
 *     or sidecar-path knowledge.
 *   - DIP: `handleArchive` depends on the helpers' typed return
 *     shapes, not on review-state storage details baked into the
 *     route handler.
 *   - OCP: when review-workflow ships its full state machine
 *     (additional states, transitions like `pending-publish`), the
 *     helpers extend with new branches; archive route untouched.
 */
import type { ContentRoot } from '../../content-root.js'
import type { RecordEventInput } from '../../audit/context.js'
import type { ComponentManifest } from '../../types.js'
import { clearReviewSidecar, readReviewSidecar, type ReviewStateKind } from '../../review/index.js'

/**
 * Read the item's current review state from its sidecar. Returns
 * `undefined` when no sidecar exists (fresh content; the absence of
 * a sidecar IS the draft state in the review-workflow data model).
 */
async function readReviewState(
  contentRoot: ContentRoot,
  kind: ReviewStateKind,
  name: string,
): Promise<string | undefined> {
  const sidecar = await readReviewSidecar(contentRoot, kind, name)
  return sidecar?.state
}

/**
 * Build the synthetic `review-withdraw` audit event emitted when
 * archive auto-withdraws a `pending-review` submission. Per
 * `design-soft-delete.md` Q9 audit shape lock.
 *
 * Returns `null` when the prior state isn't `pending-review` —
 * other states (draft, approved) don't emit a synthetic withdraw.
 * Approved state discards as part of the archive event itself
 * (recorded via `priorReviewState` metadata).
 */
export async function buildAutoWithdrawEvent(
  contentRoot: ContentRoot,
  kind: ReviewStateKind,
  name: string,
): Promise<RecordEventInput | null> {
  const priorState = await readReviewState(contentRoot, kind, name)
  if (priorState !== 'pending-review') return null

  return {
    action: 'review-withdraw',
    outcome: 'success',
    scope: { kind, name },
    metadata: {
      autoWithdrawn: true,
      reason: 'archive',
      priorState,
    },
  }
}

/**
 * Compute additional metadata for the `archive` audit event capturing
 * the item's prior review state. Returns an empty object for items
 * without a review sidecar (no review activity recorded).
 *
 * `priorReviewState` is a non-prescriptive forensic record: the
 * restore-always-to-draft invariant (Q9 N-B.1) means this metadata
 * is never auto-applied on unarchive. It exists so operators can
 * reconstruct "what state did this item have before it was archived?"
 * via audit-log query alone, without re-reading the historical sidecar.
 */
export async function archiveReviewMetadata(
  contentRoot: ContentRoot,
  kind: ReviewStateKind,
  name: string,
): Promise<Record<string, unknown>> {
  const priorState = await readReviewState(contentRoot, kind, name)
  if (!priorState) return {}
  return { priorReviewState: priorState }
}

/**
 * Reset the item's review state to draft by tearing down its review
 * sidecar tree (state file + approver sidecars). Called once the
 * archive lifecycle has consumed the prior state:
 *   - archive: state is discarded (pending-review auto-withdraws,
 *     approved discards); the archived item carries no live review
 *     state.
 *   - unarchive + conflict-restore: Q9 N-B.1 restore-always-to-draft.
 *
 * The audit events recorded alongside carry the forensic record, so
 * no history is lost by clearing. Idempotent: no-op when the item has
 * no sidecar.
 */
export async function resetReviewStateForItem(
  contentRoot: ContentRoot,
  kind: ReviewStateKind,
  name: string,
): Promise<void> {
  await clearReviewSidecar(contentRoot, kind, name)
}

/**
 * Strip `reviewState` from a restored (unarchived) manifest. Today's
 * manifests never carry this field (review state lives in the
 * sidecar, see module header); the strip stays as a defensive no-op
 * so a hand-edited or future manifest can never resurrect a stale
 * review state past the restore-always-to-draft invariant.
 *
 * Returns the manifest unchanged when no review state was set.
 */
export function stripReviewStateForRestore(manifest: ComponentManifest): ComponentManifest {
  const m = manifest as ComponentManifest & { reviewState?: unknown }
  if (typeof m.reviewState !== 'string') return manifest
  const { reviewState: _strip, ...rest } = m
  return rest as ComponentManifest
}
