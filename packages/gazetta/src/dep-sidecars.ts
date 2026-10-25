/**
 * Reverse-rooted dependency sidecars — per-edge zero-byte index for
 * "which items depend on this target?" queries.
 *
 * Shape:
 *   `{root}/.gazetta/{relation-root}/{target}/{encoded-source-item}`
 *
 * Where:
 *   - `{relation-root}` is the directory name for the relationship kind
 *      (e.g. `asset-refs`, `fragment-deps`)
 *   - `{target}` is the depended-upon name (asset name, fragment name, …),
 *      slashes encoded via `encodeRefName`
 *   - `{encoded-source-item}` is `pages.{name}` or `fragments.{name}`,
 *      with `/` → `.` and an optional `:locale` suffix for locale variants
 *
 * Files are zero bytes. Existence is the index.
 *
 * Why per-edge sidecars over an aggregate JSON file:
 *   - Multi-instance correctness: two admin instances saving different
 *     items both adding refs to `hero` write to *different paths*. No
 *     race, no optimistic concurrency, no retry. Granularity solves the
 *     write-contention problem an aggregate JSON would face.
 *   - Pattern consistency: matches the existing `.gazetta/` namespace
 *     for runtime-never-served metadata.
 *   - Self-sufficient targets: same shape on source AND target so any
 *     target promoted to source is immediately usable.
 *
 * Single responsibility: filename encoding + per-target directory I/O.
 * Save handlers, publish flow, and reindex CLI compose this with their
 * own walks.
 */
import type { ContentRoot } from './content-root.js'
import { encodeRefName } from './hash.js'
import { stateFolderPath, type StateFolder } from './state-folders.js'

/**
 * Loose manifest shape for `extract` callers. Page/fragment manifests
 * (with their inline-component descendants) all satisfy this. Avoids
 * coupling the generic dep-sidecar module to a specific manifest type.
 */
export type ManifestLike = {
  readonly template?: string
  readonly content?: Record<string, unknown>
  readonly components?: readonly unknown[]
}

/**
 * One kind of reverse dependency: a domain-specific extractor + the
 * directory under `.gazetta/` where its sidecars live.
 *
 * Each shipping relation is a module-level constant (see
 * `assets/asset-deps.ts`, `fragment-deps.ts`). Add a new relation by
 * declaring another constant; this module needs no changes.
 */
export interface DepRelation {
  /** Registered `.gazetta/` index folder for this relation. */
  readonly rootName: Extract<StateFolder, 'fragment-deps' | 'asset-refs' | 'alias-targets'>
  /**
   * Extract the set of target names this manifest depends on. Pure;
   * implementations must not perform I/O.
   *
   * Examples:
   *   - asset-refs: walks content for `_asset` refs
   *   - fragment-deps: walks components for `@fragment` refs
   *   - template-deps (if added): emits the manifest's `template` field
   */
  readonly extract: (manifest: ManifestLike) => Set<string>
}

/**
 * Identity of a depending item. Distinct entries for each locale variant
 * (per design-media.md → i18n: "Each referencing manifest, including
 * locale variants, is a separate entry").
 */
export interface ItemRef {
  source: 'page' | 'fragment'
  /** Bare item name, e.g. `home` or `blog/[slug]`. */
  name: string
  /** Locale code for locale variants; absent for the default-locale manifest. */
  locale?: string
}

/**
 * Encode an `ItemRef` into a sidecar filename.
 *   { source: 'page', name: 'home' } → 'pages.home'
 *   { source: 'page', name: 'blog/[slug]' } → 'pages.blog.[slug]'
 *   { source: 'fragment', name: 'header', locale: 'fr' } → 'fragments.header:fr'
 */
export function itemRefToFilename(ref: ItemRef): string {
  const prefix = ref.source === 'page' ? 'pages' : 'fragments'
  const encodedName = encodeRefName(ref.name)
  const base = `${prefix}.${encodedName}`
  return ref.locale ? `${base}:${ref.locale}` : base
}

const FILENAME_RE = /^(pages|fragments)\.(.+?)(?::([a-z]{2}(?:-[a-z]+)?))?$/

/**
 * Parse a sidecar filename back to an `ItemRef`. Returns null for any
 * filename that doesn't match the encoding shape so unrelated files
 * accidentally placed in the directory don't poison reads.
 */
export function filenameToItemRef(filename: string): ItemRef | null {
  const m = FILENAME_RE.exec(filename)
  if (!m) return null
  const source = m[1] === 'pages' ? 'page' : 'fragment'
  // Decode `.` → `/` to recover the original name. encodeRefName rejects
  // dots in input, so this is unambiguous: every `.` came from a slash.
  const name = m[2]!.replace(/\./g, '/')
  const locale = m[3]
  return locale ? { source, name, locale } : { source, name }
}

/** Directory path for one target's sidecars under a relation. */
function depDir(rel: DepRelation, contentRoot: ContentRoot, targetName: string): string {
  return contentRoot.path(stateFolderPath(rel.rootName, encodeRefName(targetName)))
}

/** Path of one sidecar file inside its target's directory. */
export function depSidecarPath(rel: DepRelation, contentRoot: ContentRoot, targetName: string, item: ItemRef): string {
  return contentRoot.path(stateFolderPath(rel.rootName, encodeRefName(targetName), itemRefToFilename(item)))
}

/**
 * Read all `ItemRef`s currently sidecar-indexed for `targetName`.
 * Returns empty when the directory is missing (no deps, or freshly-
 * created site).
 */
export async function readDepsFor(rel: DepRelation, contentRoot: ContentRoot, targetName: string): Promise<ItemRef[]> {
  const dir = depDir(rel, contentRoot, targetName)
  let entries: { name: string; isDirectory: boolean }[]
  try {
    entries = await contentRoot.storage.readDir(dir)
  } catch {
    // Missing directory — treat as no deps. Storage providers vary in
    // exact error shape, so we accept any read failure here.
    return []
  }
  const refs: ItemRef[] = []
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const ref = filenameToItemRef(entry.name)
    if (ref) refs.push(ref)
  }
  return refs
}

/**
 * Apply the diff for one item's deps in this relation.
 *
 * For each target in `oldTargets ∪ newTargets`:
 *   - If new and not old → write the sidecar file (creating the target dir)
 *   - If old and not new → remove the sidecar file
 *   - If both or neither → no I/O
 *
 * Sidecar writes are idempotent (zero-byte files at fixed paths), so
 * concurrent writes from multiple admin instances converge to the same
 * final state. The diff is per (item × target): each instance's save
 * updates only the sidecars for the item it just wrote.
 */
export async function applyDepDiff(
  rel: DepRelation,
  contentRoot: ContentRoot,
  item: ItemRef,
  oldTargets: ReadonlySet<string>,
  newTargets: ReadonlySet<string>,
): Promise<void> {
  const added: string[] = []
  const removed: string[] = []
  for (const t of newTargets) if (!oldTargets.has(t)) added.push(t)
  for (const t of oldTargets) if (!newTargets.has(t)) removed.push(t)

  // Adds first — order doesn't affect correctness, but adds-before-removes
  // means a transient observer mid-update sees a superset of refs (safe
  // for delete-blocking) rather than a subset.
  await Promise.all(added.map(target => writeSidecar(rel, contentRoot, target, item)))
  await Promise.all(removed.map(target => removeSidecar(rel, contentRoot, target, item)))
}

async function writeSidecar(rel: DepRelation, contentRoot: ContentRoot, target: string, item: ItemRef): Promise<void> {
  const dir = depDir(rel, contentRoot, target)
  await contentRoot.storage.mkdir(dir).catch(() => {
    // Already exists — fine.
  })
  await contentRoot.storage.writeFile(depSidecarPath(rel, contentRoot, target, item), '')
}

async function removeSidecar(rel: DepRelation, contentRoot: ContentRoot, target: string, item: ItemRef): Promise<void> {
  await contentRoot.storage.rm(depSidecarPath(rel, contentRoot, target, item)).catch(() => {
    // Already gone — fine. rm is idempotent for our purposes.
  })
}

/**
 * Rebuild the deps sidecars for one item by diffing old vs new manifest
 * via the relation's `extract` function.
 *
 * Use cases:
 *   - Save handler: pass `oldManifest` (loaded for history-recording);
 *     module re-extracts both old and new dep sets.
 *   - Reindex CLI: pass `oldManifest = null` to write fresh sidecars
 *     for every dep the item now references.
 *   - Delete handler: pass `newManifest = null` to tear down all this
 *     item's sidecars in this relation.
 */
export async function rebuildItemDeps(
  rel: DepRelation,
  contentRoot: ContentRoot,
  item: ItemRef,
  oldManifest: ManifestLike | null,
  newManifest: ManifestLike | null,
): Promise<void> {
  const oldTargets = oldManifest ? rel.extract(oldManifest) : new Set<string>()
  const newTargets = newManifest ? rel.extract(newManifest) : new Set<string>()
  await applyDepDiff(rel, contentRoot, item, oldTargets, newTargets)
}
