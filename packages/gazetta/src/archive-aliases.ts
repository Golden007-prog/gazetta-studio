/**
 * Archive-alias-targets sidecar binding for the generic dep-sidecars
 * module.
 *
 * Answers "which archived items have `aliasOf === X`?" via the same
 * per-edge sidecar shape as `asset-refs` and `fragment-deps`:
 *
 *   `{root}/.gazetta/alias-targets/{X}/{encoded-source-item}`
 *
 * Without this index, the purge handler (Cut 5) would have to walk
 * every page + fragment manifest on every purge attempt to find
 * aliases pointing at the target. At the 5K-page envelope per
 * `design-scale.md`, that's a ~30s walk on real cloud storage —
 * unacceptable for an interactive admin operation. The sidecar
 * makes it a single `readDir` (~5ms).
 *
 * Per `team-preferences.md` rule 24: "Validate every primitive
 * against the 5K-page envelope" — the sidecar IS the perf design.
 *
 * # Lifecycle
 *
 * - Save handler: when an item is archived with `aliasOf` set,
 *   `rebuildArchiveAliases` writes the sidecar at
 *   `.gazetta/alias-targets/{aliasTarget}/{item}`.
 * - Save handler: when the same item is unarchived OR has its
 *   `aliasOf` field changed, the diff drops the old target's
 *   sidecar and adds the new target's sidecar.
 * - Delete/purge handler: pass `newManifest = null` to tear down
 *   the sidecar for the item being purged.
 * - Cross-target: source-and-target consistent (same shape on
 *   both); the publish flow propagates the `.gazetta/` namespace.
 *
 * Per Q3's flatten-on-rename lock: aliases never form chains.
 * `aliasOf` always points at a live item (or at a missing item,
 * which the `dangling-alias` validator surfaces). The sidecar
 * stores ONE target per archive — the relation's `extract`
 * returns either `{aliasOf}` or `∅`.
 */
import type { ContentRoot } from './content-root.js'
import type { ComponentManifest } from './types.js'
import { type DepRelation, type ItemRef, type ManifestLike, applyDepDiff, rebuildItemDeps } from './dep-sidecars.js'

/**
 * The archive-aliases relation.
 *
 * Extracts the alias target from a manifest. The set is at most
 * one element — Q3 flatten guarantees one-hop aliases. A live
 * manifest (or an archived-without-alias manifest) yields the
 * empty set, which means no sidecars are written for it.
 */
export const ARCHIVE_ALIASES: DepRelation = {
  rootName: 'alias-targets',
  extract: (manifest: ManifestLike) => {
    // Cast: ComponentManifest is the full shape; ManifestLike is
    // the dep-sidecars module's loose type. The `archived` and
    // `aliasOf` fields aren't part of `ManifestLike`'s declaration,
    // so the cast names what we're looking at.
    const m = manifest as Partial<ComponentManifest>
    if (m.archived !== true) return new Set<string>()
    if (typeof m.aliasOf !== 'string' || m.aliasOf.length === 0) return new Set<string>()
    return new Set<string>([m.aliasOf])
  },
}

/**
 * Apply the alias-targets diff for one item's manifest change.
 *
 * Pass the pre-save manifest as `oldManifest` and the post-save
 * manifest as `newManifest`. The diff drops sidecars for any
 * removed alias targets and writes sidecars for any added targets.
 *
 * Cases:
 *   - Live → archive(aliasOf=X)         : write `.gazetta/alias-targets/X/{item}`
 *   - Live → archive(no aliasOf)         : no I/O
 *   - Archive(X) → archive(Y)            : remove X's sidecar, write Y's
 *   - Archive(X) → archive(no aliasOf)   : remove X's sidecar
 *   - Archive(X) → live                  : remove X's sidecar
 *   - Archive(X) → null (purge)          : remove X's sidecar
 *   - Live → null (purge)                : no I/O
 */
export function rebuildArchiveAliases(
  contentRoot: ContentRoot,
  item: ItemRef,
  oldManifest: ManifestLike | null,
  newManifest: ManifestLike | null,
): Promise<void> {
  return rebuildItemDeps(ARCHIVE_ALIASES, contentRoot, item, oldManifest, newManifest)
}

/**
 * Apply a pre-computed diff (used in tests + cases where the
 * caller has the alias names already).
 */
export function applyArchiveAliasesDiff(
  contentRoot: ContentRoot,
  item: ItemRef,
  oldTargets: ReadonlySet<string>,
  newTargets: ReadonlySet<string>,
): Promise<void> {
  return applyDepDiff(ARCHIVE_ALIASES, contentRoot, item, oldTargets, newTargets)
}
