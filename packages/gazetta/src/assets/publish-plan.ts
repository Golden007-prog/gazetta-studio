/**
 * Publish-plan — figures out *what* to publish before any bytes move.
 *
 * Single responsibility: turn a set of items being published into either
 * a `Plan` (the asset names to copy + the items that referenced them) or
 * a structured `missing-on-source` failure. No I/O on the destination —
 * actually copying bytes is `publish.ts`'s job.
 *
 * Splitting the planner from the executor lets the validation failure
 * short-circuit before a single stream is opened. It also lets the
 * orchestrator wire publish-assets into the broader publish flow with
 * full knowledge of what's about to happen — useful for ordering writes
 * (assets before pages) and for surfacing per-asset progress.
 */
import type { ContentRoot } from '../content-root.js'
import { manifestPath } from './manifest.js'
import { collectAssetRefs } from './scan-manifest-for-asset.js'

export interface PlanInput {
  /** Source content root (where pages/, fragments/, and assets/ live on the source side). */
  readonly sourceRoot: ContentRoot
  /** Target content root (where pages/, fragments/, and assets/ will land on the target side). */
  readonly targetRoot: ContentRoot
  /** Items being published — e.g., `['pages/home', 'fragments/header']`. */
  readonly itemNames: readonly string[]
}

export type Plan =
  | { readonly ok: true; readonly assets: readonly string[]; readonly itemsWithRefs: readonly string[] }
  | { readonly ok: false; readonly reason: 'missing-on-source'; readonly missing: readonly string[] }

/**
 * Compute the set of assets to publish given the items being published,
 * after running the source-existence pre-flight check.
 *
 * Empty refs short-circuit to `ok: true` with no assets — sites without
 * media still publish fine.
 */
export async function planAssetCopy(input: PlanInput): Promise<Plan> {
  const { refs, itemsWithRefs } = await collectRefsAcrossItems(input)

  if (refs.size === 0) return { ok: true, assets: [], itemsWithRefs: [] }

  const missing: string[] = []
  for (const name of refs) {
    const exists = await input.sourceRoot.storage.exists(input.sourceRoot.path('assets', manifestPath(name)))
    if (!exists) missing.push(name)
  }
  if (missing.length > 0) {
    return { ok: false, reason: 'missing-on-source', missing }
  }

  return { ok: true, assets: [...refs], itemsWithRefs }
}

interface CollectedRefs {
  readonly refs: Set<string>
  readonly itemsWithRefs: string[]
}

async function collectRefsAcrossItems(input: PlanInput): Promise<CollectedRefs> {
  const refs = new Set<string>()
  const itemsWithRefs = new Set<string>()
  for (const item of input.itemNames) {
    // Every locale variant of the item can carry its own asset refs
    // (#1350): an asset used only by page.fr.json must publish too.
    for (const filename of await manifestFilenamesFor(input, item)) {
      const path = input.sourceRoot.path(item, filename)
      const raw = await input.sourceRoot.storage.readFile(path).catch(() => null)
      if (raw === null) continue
      // Page/fragment manifests have the same `Walkable` shape that
      // `collectAssetRefs` accepts; cast here rather than parse-and-validate
      // since the planner's job is ref discovery, not manifest validation.
      // An unparseable manifest is skipped like an unreadable one: one
      // corrupt locale variant must not abort the target's asset publish.
      // Warn the way the site loader does when it skips a broken item.
