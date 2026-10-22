/**
 * Replace-and-delete an asset.
 *
 * Author-facing semantics (design-media.md → Delete semantics):
 *   "1+ refs, replacement picked → Rewrite all refs to the replacement
 *    asset, then delete original."
 *
 * This is the "atomic replace" verb: a single logical operation that
 * rewrites every referencing manifest to point at `newName`, then
 * removes the `oldName` asset. One history revision covers the whole
 * operation so undo reverts it as a unit.
 *
 * Single responsibility: policy — "either rewrite every ref + delete
 * cleanly, or refuse with a structured reason." This module owns:
 *   - read both manifests (404 if either missing)
 *   - verify kind/MIME compatibility (409 if not)
 *   - scan refs (via `scan-manifest-for-asset.ts` over the site)
 *   - rewrite manifests in memory (delegates to
 *     `rewrite-manifest-asset-ref.ts`)
 *   - write updated manifests + delete old asset as a batch
 *
 * It does NOT own:
 *   - HTTP concerns (the route adapter does)
 *   - per-manifest parsing (delegated to site-loader)
 *   - history recording (optional; the caller wires it)
 *
 * History atomicity:
 *   Per design, "Replace writes one history revision covering all
 *   rewritten manifests + the delete." Caller passes a `HistoryProvider`
 *   via `history`; this module gathers every written item (rewritten
 *   manifests + deleted asset's manifest with `content: null`) and
 *   records ONE revision. No history = no revision, operation still
 *   succeeds.
 */
import { join } from 'node:path'
import type { ComponentManifest, SiteManifest, StorageProvider } from '../types.js'
import type { HistoryProvider } from '../history.js'
import { createContentRoot } from '../content-root.js'
import { allFragmentEntries, allPageEntries, loadSite } from '../site-loader.js'
import { recordWrite, type WrittenItem } from '../history-recorder.js'
import { assetPathsInRemovalOrder, enumerateAssetStoragePaths } from './asset-paths.js'
import { checkKindCompat } from './kind-compat.js'
import { AssetKindMismatchError, AssetStorageError } from './errors.js'
import { rmIgnoreMissing } from '../providers/_rm-ignore-missing.js'
import { manifestPath, readManifest } from './manifest.js'
// `manifestPath` is used when composing the deleted-manifest history item.
import { rewriteManifestAssetRef } from './rewrite-manifest-asset-ref.js'
import { rebuildAssetRefs, type ItemRef } from './asset-deps.js'

export interface ReplaceAssetInput {
  /** Storage holding both the asset and the content tree. */
  storage: StorageProvider
  /** Path prefix for assets (typically `"assets"`). */
  assetsRoot: string
  /** Path prefix for site content (where `pages/` and `fragments/` live). */
  siteDir: string
  /** The asset to remove after refs are redirected. */
  oldName: string
  /** The asset every ref should point at after the operation. */
  newName: string
  /** Project-level manifest passed to `loadSite`. */
  manifest?: SiteManifest
  /** Optional — record one revision covering every manifest rewrite + the delete. */
  history?: HistoryProvider
  /** Author identifier passed through to the history revision. */
  author?: string
}

export interface ReplaceAssetResult {
  /** How many references were rewritten across all manifests. */
  readonly refsRewritten: number
  /** How many distinct manifests were touched. */
  readonly manifestsRewritten: number
}

/**
 * Rewrite every reference to `oldName` to point at `newName`, then
 * delete `oldName`. Returns counts on success. Throws:
 *   - `AssetManifestNotFoundError` — either asset missing
 *   - `AssetKindMismatchError` — kinds/MIME-categories don't align
 *   - `AssetMimeUnsupportedError` — old asset's MIME can't be laid out
 *     (misconfiguration; thrown during delete-path enumeration)
 *   - `AssetStorageError` — any underlying write/rm failure
 */
export async function replaceAsset(input: ReplaceAssetInput): Promise<ReplaceAssetResult> {
  // Step 1 — fetch both manifests. Throws AssetManifestNotFoundError
  // from readManifest when either is missing; that bubbles to 404.
  const [oldManifest, newManifest] = await Promise.all([
    readManifest(input.storage, input.assetsRoot, input.oldName),
    readManifest(input.storage, input.assetsRoot, input.newName),
  ])

  // Step 2 — compatibility gate (design-media.md).
  const compat = checkKindCompat(oldManifest, newManifest)
  if (!compat.compatible) {
    throw new AssetKindMismatchError(compat.oldKind, compat.oldMimeCategory, compat.newKind, compat.newMimeCategory)
  }

  // Step 3 — load the site once, iterate every manifest, rewrite refs.
  // Keep rewrites in memory so we can bundle them into one history
  // revision and write atomically as a group.
  const contentRoot = createContentRoot(input.storage, input.siteDir)
  const site = await loadSite({ contentRoot, manifest: input.manifest ?? { name: '(replace-asset)' } })

  type Rewrite = {
    path: string
    serialized: string
    /** The pre-rewrite manifest — needed for asset-refs sidecar diff. */
    oldManifest: ComponentManifest
    /** The rewritten manifest. */
    newManifest: ComponentManifest
    /** Identity of this rewritten item — needed for sidecar update. */
    item: ItemRef
  }
  const rewrites: Rewrite[] = []
  let refsRewritten = 0

  for (const { name, page, locale } of allPageEntries(site)) {
    const { manifest, rewriteCount } = rewriteManifestAssetRef({
      manifest: page,
      fromAssetName: input.oldName,
      toAssetName: input.newName,
    })
    if (rewriteCount === 0) continue
    refsRewritten += rewriteCount
    rewrites.push({
      path: localeManifestPath('pages', name, 'page', locale),
      // Same formatting as admin-api save paths: two-space JSON + trailing newline.
      serialized: `${JSON.stringify(stripRuntimeFields(manifest), null, 2)}\n`,
      oldManifest: page,
      newManifest: manifest,
      item: locale ? { source: 'page', name, locale } : { source: 'page', name },
    })
  }

  for (const { name, fragment, locale } of allFragmentEntries(site)) {
    const { manifest, rewriteCount } = rewriteManifestAssetRef({
      manifest: fragment,
      fromAssetName: input.oldName,
      toAssetName: input.newName,
    })
    if (rewriteCount === 0) continue
    refsRewritten += rewriteCount
    rewrites.push({
      path: localeManifestPath('fragments', name, 'fragment', locale),
      serialized: `${JSON.stringify(stripRuntimeFields(manifest), null, 2)}\n`,
      oldManifest: fragment,
      newManifest: manifest,
      item: locale ? { source: 'fragment', name, locale } : { source: 'fragment', name },
    })
  }

  // Step 4 — record the history revision BEFORE any writes.
  //
  // Rationale (mirrors admin-api/routes/pages.ts save handler): the
  // recorder captures a pre-op baseline on first call. If we wrote to
  // disk first, the baseline would capture post-op state and "undo
  // this replace" would be a no-op. Recording first lets the baseline
  // see pre-op state; the incoming `items` delta represents the post-op
  // state we're about to write.
  if (input.history) {
    const items: WrittenItem[] = [
      ...rewrites.map(r => ({ path: r.path, content: r.serialized })),
      // The old asset's manifest is going away — represent as a deletion.
      {
        path: `${input.assetsRoot}/${manifestPath(input.oldName)}`,
        content: null,
      },
    ]
    await recordWrite({
      history: input.history,
      contentRoot,
      operation: 'save',
      author: input.author,
      items,
      message: `Replace ${input.oldName} with ${input.newName}`,
    })
  }

  // Step 5 — write every rewritten manifest. Best-effort: if any
  // write fails, subsequent writes still attempt (so partial rewrites
  // land), and we surface the first error. A follow-up rollback is
  // out of scope for v1 (design-media.md → Multi-write contract).
  for (const r of rewrites) {
    const abs = contentRoot.path(r.path)
    try {
      await input.storage.writeFile(abs, r.serialized)
    } catch (err) {
      throw new AssetStorageError('write', abs, err)
    }
  }

  // Step 5b — update asset-refs sidecars for each rewritten manifest.
  // Each rewrite is "oldName ref dropped, newName ref added" for this
  // item. `rebuildItemRefs` reads the old/new manifests' asset-ref
  // sets and applies the diff: removes sidecar at .gazetta/asset-refs/
  // {oldName}/{item}, adds at .gazetta/asset-refs/{newName}/{item}.
  // Errors here are non-fatal — the manifest writes are the source of
  // truth; sidecar drift is recoverable via reindex CLI.
  await Promise.all(
    rewrites.map(r =>
      rebuildAssetRefs(contentRoot, r.item, r.oldManifest, r.newManifest).catch(err => {
        // eslint-disable-next-line no-console
        console.warn(`asset-refs sidecar update failed for ${r.path}: ${(err as Error).message}`)
      }),
    ),
  )

  // Step 6 — delete the old asset's bytes + variants + manifest in
  // removal-safe order. Reuses the same enumeration as `deleteAsset`;
  // we don't invoke deleteAsset directly because it would re-run ref
  // scanning (refs are 0 now, so it'd pass, but the scan is waste).
  // Enumerated form picks up any locale/theme overrides on disk so the
  // replace removes them too — atomic with the rest of the operation.
  const paths = await enumerateAssetStoragePaths(input.storage, input.assetsRoot, oldManifest)
  for (const path of assetPathsInRemovalOrder(paths)) {
    try {
      await rmIgnoreMissing(input.storage, path)
    } catch (err) {
      throw new AssetStorageError('delete', path, err)
    }
  }

  return { refsRewritten, manifestsRewritten: rewrites.length }
}

/**
 * `loadSite` decorates page/fragment manifests with a `dir` field (and
 * `route` on pages) for its own bookkeeping. `dir` is not part of the
 * stored manifest JSON, so strip it before serialization — otherwise
 * the on-disk file grows runtime noise every time a replace fires.
 *
 * `route` is kept: it's stored in the original manifest of every
 * starter page. Stripping would regress data.
 */
function stripRuntimeFields(manifest: ComponentManifest): ComponentManifest {
  const copy: Record<string, unknown> = { ...manifest }
  delete copy.dir
  return copy as unknown as ComponentManifest
}

function localeManifestPath(
  root: 'pages' | 'fragments',
  itemName: string,
  baseName: 'page' | 'fragment',
  locale: string | undefined,
): string {
  const file = locale ? `${baseName}.${locale}.json` : `${baseName}.json`
  return join(root, itemName, file)
}
