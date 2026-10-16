/**
 * Review-state gate for the save pipeline (design-review-workflow.md
 * "Locked invariants": edit during pending-review is locked;
 * `invalidateOnSave` sends approved content back to draft).
 *
 * The save orchestrator owns ordering; this module owns what the
 * review state means for a save. Transition rules stay in the state
 * machine — `invalidateApproval` asks `transition` rather than
 * re-deciding when an approval is revoked.
 */
import type { ContentRoot } from '../content-root.js'
import type { ReviewWorkflowConfig, TargetConfig } from '../types.js'
import { resolveReviewWorkflow } from '../types.js'
import { readApprovers, readReviewSidecar, removeApproverSidecar, writeReviewSidecar } from './sidecars.js'
import type { ReviewStateKind } from './sidecars.js'
import { transition } from './state-machine.js'
import type { Principal, ReviewSidecar } from './types.js'

export const EDIT_LOCKED_MESSAGE = 'Withdraw submission to edit'

/** The parts of a site manifest that decide review policy for a save. */
export interface ReviewPolicySource {
  readonly targets?: Readonly<Record<string, Pick<TargetConfig, 'reviewWorkflow'>>>
  readonly reviewWorkflow?: ReviewWorkflowConfig
}

/**
 * Effective review policy for the target being saved to, or `undefined`
 * when review is off there. Without a target name (no registry), only
 * the site-level block applies.
 */
export function resolveSaveReviewPolicy(
  manifest: ReviewPolicySource | undefined,
  targetName: string | undefined,
): ReviewWorkflowConfig | undefined {
  if (!manifest) return undefined
  const target = targetName ? manifest.targets?.[targetName] : undefined
  const config = resolveReviewWorkflow(target ?? {}, manifest)
  return config?.enabled === true ? config : undefined
}

export interface ReviewItem {
  readonly contentRoot: ContentRoot
  readonly kind: ReviewStateKind
  readonly name: string
}

/** Current review state of the item; `null` when it was never submitted. */
export function readSaveReviewState(item: ReviewItem): Promise<ReviewSidecar | null> {
  return readReviewSidecar(item.contentRoot, item.kind, item.name)
}

export function isEditLocked(sidecar: ReviewSidecar | null): boolean {
  return sidecar?.state === 'pending-review'
}

/**
 * Apply the `invalidateOnSave` policy after a successful save of an
 * approved item. Returns true when the approval was revoked. On
 * revocation the approver votes are removed too: they belong to the
 * submission that was invalidated and must not count toward the next
 * one.
 */
export async function invalidateApproval(
  item: ReviewItem,
  sidecar: ReviewSidecar,
  contentDiffers: boolean,
  principal: Principal,
  config: ReviewWorkflowConfig,
): Promise<boolean> {
  if (sidecar.state !== 'approved') return false
  const approvers = await readApprovers(item.contentRoot, item.kind, item.name)
  const result = transition(
    { state: 'approved', submitter: sidecar.submitter ?? '', approvers },
    { kind: 'invalidate', contentDiffers },
    principal,
    config,
  )
  if (!result.ok || result.next.state !== 'draft') return false

  await writeReviewSidecar(item.contentRoot, item.kind, item.name, {
    state: 'draft',
    updatedAt: new Date().toISOString(),
  })
  await Promise.all(approvers.map(actor => removeApproverSidecar(item.contentRoot, item.kind, item.name, actor)))
  return true
}
