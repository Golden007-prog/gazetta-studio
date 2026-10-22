/**
 * Delete an asset — the blocked-by-refs flow.
 *
 * Contract:
 * 1. Read the manifest (404-equivalent if missing).
 * 2. Scan site content for references to this asset.
 * 3. If any refs exist, throw `AssetInUseError` with the usage list.
 *    The admin surfaces the list so the author can rewrite refs or pick
 *    a replacement.
 * 4. If no refs, remove every storage path associated with the asset in
 *    removal-safe order (bytes + variants first, manifest last). If a
 *    crash lands between any two steps, at worst the manifest points at
 *    missing bytes — a state the resolver already degrades gracefully.
 *
 * Single responsibility: policy — "either delete cleanly or refuse with a
 * reason." Owns the three-step flow and nothing else:
 *   - reads manifest (via `manifest.ts`)
 *   - scans refs (`scanManifestForAsset` over the loaded site's pages and fragments)
 *   - enumerates paths (via `asset-paths.ts`) and removes them
 *     idempotently (via `providers/_rm-ignore-missing.ts`)
 *
 * Adding a new manifest dimension (variants, locale bytes, posters)
 * means extending `asset-paths.ts`. This module stays unchanged — the
 * enumeration loop picks up the new paths automatically.
 *
 * History atomicity:
 *   When `history` is provided, delete records ONE revision marking
 *   every removed path as a deletion (`content: null`). Recording
 *   happens BEFORE any rm so the recorder's first-time baseline scan
 *   captures pre-op state — same pattern as `replace.ts` and
 *   `ingest.ts`. If recording succeeds but a subsequent rm fails, the
 *   revision still records the deletion intent; on undo, the restorer
 *   re-creates the missing paths from the previous revision's blobs.
 */
import type { ContentRoot } from '../content-root.js'
import type { HistoryProvider } from '../history.js'
import { recordWrite, type WrittenItem } from '../history-recorder.js'
import type { StorageProvider, SiteManifest } from '../types.js'
import { createContentRoot } from '../content-root.js'
import { rmIgnoreMissing } from '../providers/_rm-ignore-missing.js'
import { assetPathsInRemovalOrder, enumerateAssetStoragePaths } from './asset-paths.js'
import { AssetInUseError, AssetStorageError } from './errors.js'
import { readManifest } from './manifest.js'
import { scanManifestForAsset } from './scan-manifest-for-asset.js'
import { allFragmentEntries, allPageEntries, loadSite, type Site } from '../site-loader.js'
import type { AssetRef } from './refs.js'

export interface DeleteAssetInput {
  /** Storage holding both the asset and the content tree. */
  storage: StorageProvider
  /** Path prefix for assets (typically `"assets"`). */
  assetsRoot: string
  /**
   * Path prefix for site content (where `pages/` and `fragments/` live).
   * Required — refs are scanned from here.
   */
  siteDir: string
  /** The asset name to delete. */
  assetName: string
  /** Project-level manifest passed to the ref-scanner's `loadSite`. */
  manifest?: SiteManifest
  /**
   * Optional history provider. When set, delete records ONE revision
   * covering the removed manifest + bytes + variants (each as
   * `content: null`). Reuses the `siteDir`-rooted contentRoot built
   * for ref scanning, so callers don't need to pass it separately.
   */
  history?: HistoryProvider
  /** Author identifier passed through to the history revision. */
  author?: string
  /**
   * Optional content root. When omitted, one is built from `storage`
   * + `siteDir`. Tests pass an explicit one to share a single root
   * with other operations.
   */
  contentRoot?: ContentRoot
  /**
   * Optional already-loaded site for the ref scan. The admin route
   * passes the source's cached site; when omitted, the site is loaded
   * here (the path tests and other direct callers take).
   */
  site?: Site
}

function manifestPath(
  root: 'pages' | 'fragments',
  itemName: string,
  baseName: 'page' | 'fragment',
  locale: string | undefined,
): string {
  const file = locale ? `${baseName}.${locale}.json` : `${baseName}.json`
  return `${root}/${itemName}/${file}`
}

/**
 * Delete an asset after verifying no references exist. Returns on
 * success; throws `AssetInUseError` (with the usage list),
 * `AssetManifestNotFoundError`, `AssetMimeUnsupportedError`, or
 * `AssetStorageError` otherwise.
 */
export async function deleteAsset(input: DeleteAssetInput): Promise<void> {
  // Step 1 — read manifest. Throws AssetManifestNotFoundError when missing.
  const manifest = await readManifest(input.storage, input.assetsRoot, input.assetName)

  // Step 2 — scan for refs in the loaded site. The `.gazetta/
  // asset-refs/` index is derived state and isn't committed, so a
  // fresh clone or a `git pull` can leave it missing or stale (#1139);
  // the scan walks the in-memory manifests with the same `_asset`
  // extraction as the index builder — no storage reads beyond the
  // site load, milliseconds at the 5K-page envelope.
  const contentRoot = input.contentRoot ?? createContentRoot(input.storage, input.siteDir)
  const site = input.site ?? (await loadSite({ contentRoot, manifest: input.manifest ?? { name: '(refs-scan)' } }))
  const refs: AssetRef[] = []
  for (const { name, page, locale } of allPageEntries(site)) {
    refs.push(
      ...scanManifestForAsset({
        manifest: page,
        manifestPath: manifestPath('pages', name, 'page', locale),
        source: 'page',
        assetName: input.assetName,
      }),
    )
  }
  for (const { name, fragment, locale } of allFragmentEntries(site)) {
    refs.push(
      ...scanManifestForAsset({
        manifest: fragment,
        manifestPath: manifestPath('fragments', name, 'fragment', locale),
        source: 'fragment',
        assetName: input.assetName,
      }),
    )
  }

  // Step 3 — refuse if in use.
  if (refs.length > 0) {
    throw new AssetInUseError(input.assetName, refs)
  }

  // Step 4 — enumerate paths, including any locale/theme overrides
  // discovered on disk. `enumerateAssetStoragePaths` throws
  // `AssetMimeUnsupportedError` when the manifest's MIME has no
  // extension mapping (misconfiguration — surface as-is rather than
  // silently skipping bytes).
  const paths = await enumerateAssetStoragePaths(input.storage, input.assetsRoot, manifest)
  const orderedPaths = assetPathsInRemovalOrder(paths)

  // Step 5 — record history BEFORE any rm. Same pattern as
  // ingest/replace: the recorder's first-time baseline scan must
  // capture pre-op state. Each removed path becomes a deletion
  // (`content: null`) so the next revision's snapshot drops them.
  if (input.history) {
    const items: WrittenItem[] = orderedPaths.map(path => ({ path, content: null }))
    await recordWrite({
      history: input.history,
      contentRoot,
      operation: 'save',
      author: input.author,
      items,
      message: `Delete ${input.assetName}`,
    })
  }

  // Step 6 — remove every enumerated path in removal-safe order.
  for (const path of orderedPaths) {
    try {
      await rmIgnoreMissing(input.storage, path)
    } catch (err) {
      throw new AssetStorageError('delete', path, err)
    }
  }
}
