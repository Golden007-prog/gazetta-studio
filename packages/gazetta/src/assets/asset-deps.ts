/**
 * Asset-refs binding for the generic dep-sidecars module.
 *
 * Asset-side conveniences over the generic API:
 *   - `ASSET_REFS` constant fixes the dep-sidecar relation kind for
 *     callers (so they don't need to know "the asset-refs root is named
 *     `asset-refs`").
 *   - `itemRefToAssetRef` reconstructs an `AssetRef` (the schema/types
 *     shape used in 409 delete-blocking responses) from the sidecar's
 *     `ItemRef`. Sidecars don't carry `componentPath`; we synthesize
 *     null and let callers re-read manifests for breadcrumb display.
 */
import type { ContentRoot } from '../content-root.js'
import { type DepRelation, type ItemRef, type ManifestLike, rebuildItemDeps, readDepsFor } from '../dep-sidecars.js'
import type { AssetRef } from './refs.js'
import { collectAssetRefs } from './scan-manifest-for-asset.js'

/** The asset-refs relation: extract `_asset` references from a manifest. */
export const ASSET_REFS: DepRelation = {
  rootName: 'asset-refs',
  // collectAssetRefs accepts a `Walkable` shape — narrower than ComponentManifest
  // but every ComponentManifest is structurally a Walkable for its purposes.
  extract: (manifest: ManifestLike) => collectAssetRefs(manifest as unknown as Parameters<typeof collectAssetRefs>[0]),
}

/** Convert an `ItemRef` to the `AssetRef` shape used by delete.ts and 409 responses. */
export function itemRefToAssetRef(item: ItemRef): AssetRef {
  // The sidecar doesn't carry componentPath — it answers "is this asset
  // referenced by this item?" but not "where exactly in the manifest."
  // For breadcrumb display, callers re-read the manifest on demand.
  const filename = item.source === 'page' ? 'page' : 'fragment'
  const localePart = item.locale ? `.${item.locale}` : ''
  const folder = item.source === 'page' ? 'pages' : 'fragments'
  return {
    source: item.source,
    path: `${folder}/${item.name}/${filename}${localePart}.json`,
    componentPath: null,
  }
}

/** Read every item that references this asset. Thin wrapper around `readDepsFor`. */
export function readRefsForAsset(contentRoot: ContentRoot, assetName: string): Promise<ItemRef[]> {
  return readDepsFor(ASSET_REFS, contentRoot, assetName)
}

/**
 * Apply asset-refs diff for one item's manifest change. Thin wrapper
 * around `rebuildItemDeps` with the asset-refs relation pre-bound.
 */
export function rebuildAssetRefs(
  contentRoot: ContentRoot,
  item: ItemRef,
  oldManifest: ManifestLike | null,
  newManifest: ManifestLike | null,
): Promise<void> {
  return rebuildItemDeps(ASSET_REFS, contentRoot, item, oldManifest, newManifest)
}

// Re-export the generic types/utilities so asset-side callers don't
// need to import from two modules.
export { type DepRelation, type ItemRef } from '../dep-sidecars.js'
