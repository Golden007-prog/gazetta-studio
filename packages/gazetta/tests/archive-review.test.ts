/**
 * Cut 14 — review-workflow integration helpers, fixed in #1344 to read
 * review state from the review sidecar (`.gazetta/review/{kind}/{name}/
 * state.json`) instead of a speculative `manifest.reviewState` field
 * that was never written.
 *
 * The async helpers are exercised over `memoryStorage()` content roots.
 * The integration with `handleArchive` and `handleUnarchive` is
 * exercised by `admin-api-archive-review.test.ts` (route-level audit
 * shape + sidecar reset behavior).
 */
import { describe, expect, it } from 'vitest'
import {
  archiveReviewMetadata,
  buildAutoWithdrawEvent,
  resetReviewStateForItem,
  stripReviewStateForRestore,
} from '../src/admin-api/routes/archive-review.js'
import { createContentRoot } from '../src/content-root.js'
import { readReviewSidecar, writeReviewSidecar } from '../src/review/index.js'
import type { ReviewSidecar, ReviewState } from '../src/review/types.js'
import type { ComponentManifest } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'

const baseManifest: ComponentManifest = {
  template: 'page-default',
  content: { title: 'Test' },
}

function sidecar(state: ReviewState): ReviewSidecar {
  return {
    state,
    submitter: 'alice@example.com',
    requiredApprovers: 1,
    submittedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

async function setup(state?: ReviewState, name = 'home') {
  const storage = memoryStorage()
  const contentRoot = createContentRoot(storage, '')
  if (state !== undefined) {
    await writeReviewSidecar(contentRoot, 'page', name, sidecar(state))
  }
  return contentRoot
}

describe('buildAutoWithdrawEvent', () => {
  it('returns null when the item has no review sidecar (current production)', async () => {
    const contentRoot = await setup()
    const event = await buildAutoWithdrawEvent(contentRoot, 'page', 'home')
    expect(event).toBeNull()
  })

  it('returns null when the sidecar is in draft state', async () => {
    const contentRoot = await setup('draft')
    const event = await buildAutoWithdrawEvent(contentRoot, 'page', 'home')
    expect(event).toBeNull()
  })

  it('returns null when the sidecar is approved (approved discards via priorReviewState; no synthetic withdraw)', async () => {
    const contentRoot = await setup('approved')
    const event = await buildAutoWithdrawEvent(contentRoot, 'page', 'home')
    expect(event).toBeNull()
  })

  it('returns review-withdraw event when the sidecar is pending-review', async () => {
    const contentRoot = await setup('pending-review')
    const event = await buildAutoWithdrawEvent(contentRoot, 'page', 'home')
    expect(event).toEqual({
      action: 'review-withdraw',
      outcome: 'success',
      scope: { kind: 'page', name: 'home' },
      metadata: {
        autoWithdrawn: true,
        reason: 'archive',
        priorState: 'pending-review',
      },
    })
  })

  it('handles fragment scope correctly', async () => {
    const storage = memoryStorage()
    const contentRoot = createContentRoot(storage, '')
    await writeReviewSidecar(contentRoot, 'fragment', 'header', sidecar('pending-review'))
    const event = await buildAutoWithdrawEvent(contentRoot, 'fragment', 'header')
    expect(event?.scope).toEqual({ kind: 'fragment', name: 'header' })
  })
})

describe('archiveReviewMetadata', () => {
  it('returns empty object when the item has no review sidecar', async () => {
    const contentRoot = await setup()
    const meta = await archiveReviewMetadata(contentRoot, 'page', 'home')
    expect(meta).toEqual({})
  })

  it('captures priorReviewState when the sidecar is approved', async () => {
    const contentRoot = await setup('approved')
    const meta = await archiveReviewMetadata(contentRoot, 'page', 'home')
    expect(meta).toEqual({ priorReviewState: 'approved' })
  })

  it('captures priorReviewState when the sidecar is pending-review', async () => {
    const contentRoot = await setup('pending-review')
    const meta = await archiveReviewMetadata(contentRoot, 'page', 'home')
    expect(meta).toEqual({ priorReviewState: 'pending-review' })
  })
})

describe('resetReviewStateForItem', () => {
  it('tears down the review sidecar tree (back to draft)', async () => {
    const contentRoot = await setup('pending-review')
    expect(await readReviewSidecar(contentRoot, 'page', 'home')).not.toBeNull()

    await resetReviewStateForItem(contentRoot, 'page', 'home')

    expect(await readReviewSidecar(contentRoot, 'page', 'home')).toBeNull()
  })

  it('is a no-op when the item has no sidecar', async () => {
    const contentRoot = await setup()
    await expect(resetReviewStateForItem(contentRoot, 'page', 'home')).resolves.toBeUndefined()
  })
})

describe('stripReviewStateForRestore', () => {
  it('returns manifest unchanged when no reviewState present', () => {
    const result = stripReviewStateForRestore(baseManifest)
    expect(result).toBe(baseManifest)
  })

  it('strips reviewState from restored manifest (defensive; manifests never carry it today)', () => {
    const manifest = { ...baseManifest, reviewState: 'pending-review' } as ComponentManifest
    const result = stripReviewStateForRestore(manifest)
    expect(result).toEqual(baseManifest)
    expect((result as ComponentManifest & { reviewState?: unknown }).reviewState).toBeUndefined()
  })

  it('preserves all other fields when stripping', () => {
    const manifest = {
      template: 'page-default',
      content: { title: 'Test' },
      components: ['hero'],
      reviewState: 'approved',
    } as ComponentManifest
    const result = stripReviewStateForRestore(manifest)
    expect(result).toEqual({
      template: 'page-default',
      content: { title: 'Test' },
      components: ['hero'],
    })
  })

  it('strips approved state too (restore always to draft per Q9 N-B.1)', () => {
    const manifest = { ...baseManifest, reviewState: 'approved' } as ComponentManifest
    const result = stripReviewStateForRestore(manifest)
    expect((result as ComponentManifest & { reviewState?: unknown }).reviewState).toBeUndefined()
  })
})
