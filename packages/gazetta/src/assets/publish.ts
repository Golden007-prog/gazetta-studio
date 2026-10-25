/**
 * Publish assets — copy referenced assets from a source target's storage
 * to a destination target's storage during publish.
 *
 * This module is the orchestrator: it asks `publish-plan.ts` what to copy
 * (and stops on a structured failure), then performs the actual byte
 * moves. The two concerns split because validation must complete before
 * any bytes are written — so a missing-on-source asset never produces a
 * half-copied target — and the executor wants nothing to do with the
 * walk that produced the asset list.
 *
 * Dedupe is a runtime check on the destination, not a planner output:
 * the planner can't know whether an asset is *already on target* without
 * the same `exists()` call we'd make at copy time, so checking once at
 * the copy site is cheaper.
 */
import { mapLimit } from '../concurrency.js'
import type { ContentRoot } from '../content-root.js'
import type { StorageProvider } from '../types.js'
import { assetBytePaths, assetManifestPaths, enumerateAssetStoragePaths } from './asset-paths.js'
import { readManifest } from './manifest.js'
import { planAssetCopy } from './publish-plan.js'

export interface PublishAssetsInput {
  /** Source content root (assets live at `sourceRoot.path('assets')`). */
  readonly sourceRoot: ContentRoot
  /** Target content root (assets land at `targetRoot.path('assets')`). */
  readonly targetRoot: ContentRoot
  /** Items being published — e.g., `['pages/home', 'fragments/header']`. */
  readonly itemNames: readonly string[]
}

export type PublishAssetsResult =
  | { readonly ok: true; readonly copiedAssets: number; readonly copiedFiles: number }
  | { readonly ok: false; readonly reason: 'missing-on-source'; readonly missing: readonly string[] }

/**
 * Copy every asset referenced by `itemNames` from source to target.
 *
 * Returns a discriminated-union result. On the failure variant, no
 * writes have happened — validation is complete before any copy starts.
 *
 * Asset copies run in bounded parallel — assets are independent (no
 * cross-asset shared state) and each one's stream-bridge spends most of
 * its time waiting on cloud I/O. Sequential copy serializes those waits;
 * parallel copy lets them overlap. Concurrency is bounded by `mapLimit`'s
 * default to avoid running out of file handles or saturating the SDK's
 * connection pool.
 */
export async function publishAssets(input: PublishAssetsInput): Promise<PublishAssetsResult> {
  const plan = await planAssetCopy(input)
  if (!plan.ok) return plan
  if (plan.assets.length === 0) return { ok: true, copiedAssets: 0, copiedFiles: 0 }

  const ctx: CopyContext = {
    source: input.sourceRoot.storage,
    target: input.targetRoot.storage,
    sourceAssets: input.sourceRoot.path('assets'),
    targetAssets: input.targetRoot.path('assets'),
  }

  const perAsset = await mapLimit(plan.assets, name => copyOneAsset(ctx, name))
  let copiedAssets = 0
  let copiedFiles = 0
  for (const r of perAsset) {
    if (r.copied) copiedAssets++
    copiedFiles += r.files
  }
  return { ok: true, copiedAssets, copiedFiles }
}

interface CopyContext {
  readonly source: StorageProvider
  readonly target: StorageProvider
  readonly sourceAssets: string
  readonly targetAssets: string
}

interface CopyResult {
  /** True when any file was written. False when the target was already current. */
  readonly copied: boolean
  /** Files written for this asset (manifests + bytes + variants). 0 when already current. */
  readonly files: number
}

async function copyOneAsset(ctx: CopyContext, name: string): Promise<CopyResult> {
  const sourceManifest = await readManifest(ctx.source, ctx.sourceAssets, name)
  // Scan the source for locale/theme override slices so their manifests,
  // bytes, and variants travel with the default footprint (#1350).
  const sourcePaths = await enumerateAssetStoragePaths(ctx.source, ctx.sourceAssets, sourceManifest)

  // Re-root a source path under the target's assets root; both sides
  // share the same relative layout.
  const retarget = (sourcePath: string) => ctx.targetAssets + sourcePath.slice(ctx.sourceAssets.length)

  let files = 0

  // Manifests (default + one per override slice) are small JSON and
  // change over an asset's life: an alt or focal-point edit, or an
  // override added after a first publish. Compare content and write
  // when missing or different; a byte-identical manifest is skipped.
  for (const sourcePath of assetManifestPaths(sourcePaths)) {
    const content = await ctx.source.readFile(sourcePath)
    const existing = await ctx.target.readFile(retarget(sourcePath)).catch(() => null)
    if (existing === content) continue
    await ctx.target.writeFile(retarget(sourcePath), content)
    files++
  }

  // Bytes and variants are content-addressed: the hash is in the path,
  // so presence on the target proves byte-equivalence. Copy only what
  // is absent. An override added later has fresh paths, so it copies
  // even when the default bytes were already there.
  for (const sourcePath of assetBytePaths(sourcePaths)) {
    if (await ctx.target.exists(retarget(sourcePath))) continue
    const stream = await ctx.source.readStream(sourcePath)
    await ctx.target.writeStream(retarget(sourcePath), stream)
    files++
  }

  return { copied: files > 0, files }
}
