/**
 * Archived-name-conflict resolver — implements the three resolution
 * modes per `design-soft-delete.md` Q5 I3 lock.
 *
 *   - `restore`: unarchive the existing archive. Skip creation.
 *     Most common author intent ("oh, I forgot we already had this
 *     content").
 *   - `replace`: purge the archive (force=true, accepting alias
 *     re-targeting per Q5 I3) and create new content. Aliases that
 *     pointed at the archive get re-targeted to the new item via the
 *     flatten cascade.
 *   - `moveAside`: rename the existing archive to
 *     `<name>-archived-<YYYYMMDD>` (with counter on collision), then
 *     create new content under the original name.
 *
 * Each mode is best-effort sequential per the multi-write contract
 * from `design-media.md` (no cross-object transactions). Failures
 * surface as throws for the route handler to map to 5xx.
 *
 * # SOLID
 *
 *   - SRP: this module owns conflict resolution. Doesn't audit
 *     (caller emits one composite audit event); doesn't validate
 *     `onConflict` mode (caller validates).
 *   - DIP: depends on storage primitives + dep-sidecar primitives;
 *     doesn't reach into Hono context.
 */
import { join } from 'node:path'
import type { ContentRoot } from '../content-root.js'
import type { ComponentManifest, FragmentManifest, PageManifest } from '../types.js'
import { rebuildArchiveAliases } from '../archive-aliases.js'
import { loadSiteFromSource } from './source-context.js'
import { findArchivesAliasingInSite } from '../site-users.js'
import { rebuildAssetRefs } from '../assets/asset-deps.js'
import { rebuildFragmentDeps } from '../fragment-deps.js'
import type { ItemRef } from '../dep-sidecars.js'
import type { SourceContext } from './source-context.js'

export type ArchivedNameConflictMode = 'restore' | 'replace' | 'moveAside'
const ARCHIVED_NAME_CONFLICT_MODES: ReadonlySet<ArchivedNameConflictMode> = new Set(['restore', 'replace', 'moveAside'])

export type ArchivedNameConflictResult =
  | { kind: 'restored' }
  | { kind: 'replaced'; flattenedAliases: string[] }
  | { kind: 'moved-aside'; archivedAs: string; flattenedAliases: string[] }
  | { kind: 'invalid-mode' }

export interface ResolveOptions {
  source: SourceContext
  kind: 'page' | 'fragment'
  name: string
  existing: (PageManifest | FragmentManifest) & { dir: string }
  mode: ArchivedNameConflictMode | string
  newTemplate: string
  newContent?: Record<string, unknown>
  /** Principal ID — used as `archivedBy` for the moved-aside archive. */
  actorId: string
}

export async function resolveArchivedNameConflict(opts: ResolveOptions): Promise<ArchivedNameConflictResult> {
  if (!ARCHIVED_NAME_CONFLICT_MODES.has(opts.mode as ArchivedNameConflictMode)) {
    return { kind: 'invalid-mode' }
  }
  const mode = opts.mode as ArchivedNameConflictMode

  switch (mode) {
    case 'restore':
      return await runRestore(opts)
    case 'replace':
      return await runReplace(opts)
    case 'moveAside':
      return await runMoveAside(opts)
  }
}

// ─── restore ──────────────────────────────────────────────────────────
//
// Strip archive fields from the existing archive's manifest; leave the
// content + components intact. Author keeps the archive's content; the
// new template/content from the create request is silently ignored
// (per Q6 D1 — restore = "flip the bit", no content overwrite).

async function runRestore(opts: ResolveOptions): Promise<ArchivedNameConflictResult> {
  const filename = filenameFor(opts.kind)
  const path = join(opts.existing.dir, filename)
  const restored = stripArchiveFields(opts.existing)
  await opts.source.storage.writeFile(path, JSON.stringify(restored, null, 2) + '\n')

  // Tear down the archive-aliases sidecar — `extract` on a live
  // manifest returns the empty set, so the diff cleans up.
  const itemRef: ItemRef = { source: opts.kind, name: opts.name }
  await rebuildArchiveAliases(opts.source.contentRoot, itemRef, opts.existing, restored)

  return { kind: 'restored' }
}

// ─── replace ──────────────────────────────────────────────────────────
//
// Purge the archive (rm dir + tear down ALL dep-sidecars including the
// archive-aliases entry); create new content; flatten any archives
// that aliased the old archive over to the new item per Q5 I3 (alias
// re-targeting). Best-effort sequential.

async function runReplace(opts: ResolveOptions): Promise<ArchivedNameConflictResult> {
  // Step 1 — collect alias-pointers BEFORE purge so the flatten cascade
  // can rewrite them after the new manifest exists. Read from the loaded
  // site, not the `.gazetta/alias-targets/` index: derived state isn't
  // committed, so a fresh clone or `git pull` can leave it missing or
  // stale (#1139).
  const aliasingArchives = findArchivesAliasingInSite(await loadSiteFromSource(opts.source), opts.name)

  // Step 2 — purge the existing archive entirely (manifest dir + sidecars).
  const itemRef: ItemRef = { source: opts.kind, name: opts.name }
  await opts.source.storage.rm(opts.existing.dir)
  await Promise.all([
    rebuildArchiveAliases(opts.source.contentRoot, itemRef, opts.existing, null),
    rebuildAssetRefs(opts.source.contentRoot, itemRef, opts.existing, null),
    rebuildFragmentDeps(opts.source.contentRoot, itemRef, opts.existing, null),
  ])

  // Step 3 — create the new live manifest.
  const filename = filenameFor(opts.kind)
  const newDir = opts.source.contentRoot.path(`${opts.kind}s`, opts.name)
  await opts.source.storage.mkdir(newDir)
  const newManifest = {
    template: opts.newTemplate,
    content: opts.newContent ?? { title: opts.name },
    components: [],
  }
  await opts.source.storage.writeFile(join(newDir, filename), JSON.stringify(newManifest, null, 2) + '\n')
  // Initialize dep-sidecars for the new live manifest.
  await Promise.all([
    rebuildAssetRefs(opts.source.contentRoot, itemRef, null, newManifest),
    rebuildFragmentDeps(opts.source.contentRoot, itemRef, null, newManifest),
  ])

  // Step 4 — flatten cascade: archives that aliased the old name now
  // point at the new item. Same name, but aliasOf points at a fresh
  // live target → maintains Q3 G1 invariant.
  const flattenedAliases: string[] = []
  for (const ref of aliasingArchives) {
    if (ref.source !== opts.kind) continue
    const refDir = opts.source.contentRoot.path(`${ref.source}s`, ref.name)
    const refFilename = ref.locale ? filename.replace(/\.json$/, `.${ref.locale}.json`) : filename
    const refPath = join(refDir, refFilename)
    const raw = await opts.source.storage.readFile(refPath).catch(() => null)
    if (!raw) continue
    const oldManifest = JSON.parse(raw) as ComponentManifest
    if (oldManifest.aliasOf !== opts.name) continue // no longer points here
    // The `aliasOf` value is the same string (opts.name), but the
    // target is a different physical item now (live, not archived).
    // The sidecar update is therefore a no-op for the archive-aliases
    // index — same source ref, same target name. No write needed; only
    // report the cascade, once per archive (locale variants share the
    // bare name).
    if (!flattenedAliases.includes(ref.name)) flattenedAliases.push(ref.name)
  }

  return { kind: 'replaced', flattenedAliases }
}

// ─── moveAside ────────────────────────────────────────────────────────
//
// Generate a fresh archive name (`<name>-archived-<YYYYMMDD>` with
// counter on collision); rename the existing archive's directory;
// rewrite the archive-aliases sidecar at the new name; then create
// the new content under the original name.

async function runMoveAside(opts: ResolveOptions): Promise<ArchivedNameConflictResult> {
  // Step 1 — choose a non-colliding aside name.
  const archivedAs = await pickAsideName(opts.source, opts.kind, opts.name)

  // Step 2 — read the existing archive's manifest, write at the new path
  // with a fresh `archivedAt` snapshot (the rename is a new lifecycle
  // event); then rm the old dir.
  const filename = filenameFor(opts.kind)
  const oldDir = opts.existing.dir
  const newDir = opts.source.contentRoot.path(`${opts.kind}s`, archivedAs)
  await opts.source.storage.mkdir(newDir)
  // Carry the existing archive shape forward; only the name changes.
  const carried: ComponentManifest = stripDirAndDerived(opts.existing)
  await opts.source.storage.writeFile(join(newDir, filename), JSON.stringify(carried, null, 2) + '\n')
  await opts.source.storage.rm(oldDir)

  // Step 3 — sidecars: tear down the OLD archive's sidecars, write the
  // new ones at the aside name. Reuse the rebuild* primitives.
  const oldRef: ItemRef = { source: opts.kind, name: opts.name }
  const newRef: ItemRef = { source: opts.kind, name: archivedAs }
  await Promise.all([
    rebuildArchiveAliases(opts.source.contentRoot, oldRef, opts.existing, null),
    rebuildAssetRefs(opts.source.contentRoot, oldRef, opts.existing, null),
    rebuildFragmentDeps(opts.source.contentRoot, oldRef, opts.existing, null),
    rebuildArchiveAliases(opts.source.contentRoot, newRef, null, carried),
    rebuildAssetRefs(opts.source.contentRoot, newRef, null, carried),
    rebuildFragmentDeps(opts.source.contentRoot, newRef, null, carried),
  ])

  // Step 4 — flatten cascade: archives that aliased the OLD name now
  // need their aliasOf rewritten to point at... the new live item we're
  // about to create at the original name. Read each aliasing archive
  // and rewrite if needed. Q3 G1 invariant: archive aliases never chain.
  // Read from the loaded site, not the `.gazetta/alias-targets/` index:
  // derived state isn't committed, so a fresh clone or `git pull` can
  // leave it missing or stale (#1139).
  const aliasingArchives = findArchivesAliasingInSite(await loadSiteFromSource(opts.source), opts.name)
  const flattenedAliases: string[] = []
  for (const ref of aliasingArchives) {
    if (ref.source !== opts.kind) continue
    // Locale variants share the bare name — report each archive once.
    if (!flattenedAliases.includes(ref.name)) flattenedAliases.push(ref.name)
  }

  // Step 5 — create the new live manifest at the original name.
  const liveDir = opts.source.contentRoot.path(`${opts.kind}s`, opts.name)
  await opts.source.storage.mkdir(liveDir)
  const liveManifest = {
    template: opts.newTemplate,
    content: opts.newContent ?? { title: opts.name },
    components: [],
  }
  await opts.source.storage.writeFile(join(liveDir, filename), JSON.stringify(liveManifest, null, 2) + '\n')
  const liveRef: ItemRef = { source: opts.kind, name: opts.name }
  await Promise.all([
    rebuildAssetRefs(opts.source.contentRoot, liveRef, null, liveManifest),
    rebuildFragmentDeps(opts.source.contentRoot, liveRef, null, liveManifest),
  ])

  return { kind: 'moved-aside', archivedAs, flattenedAliases }
}

/**
 * Pick a non-colliding aside name. Format: `<name>-archived-<YYYYMMDD>`
 * with a `-N` counter on collision. Per Q5 E1 lock — date-only is
 * stable and human-readable; full ISO timestamp would be ugly.
 */
async function pickAsideName(source: SourceContext, kind: 'page' | 'fragment', name: string): Promise<string> {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '') // YYYYMMDD
  const base = `${name}-archived-${today}`
  let candidate = base
  let counter = 1
  // Cap retries to avoid pathological infinite loops on storage errors.
  for (let i = 0; i < 100; i++) {
    const dir = source.contentRoot.path(`${kind}s`, candidate)
    const existsCheck = await source.storage.exists(join(dir, filenameFor(kind)))
    if (!existsCheck) return candidate
    counter++
    candidate = `${base}-${counter}`
  }
  throw new Error(`Could not find a non-colliding aside name for "${name}" after 100 attempts`)
}

// ─── shared helpers ──────────────────────────────────────────────────

function filenameFor(kind: 'page' | 'fragment'): string {
  return kind === 'page' ? 'page.json' : 'fragment.json'
}

function stripArchiveFields(manifest: PageManifest | FragmentManifest): ComponentManifest {
  const stripped = { ...manifest } as ComponentManifest & Record<string, unknown>
  delete stripped.archived
  delete stripped.archivedAt
  delete stripped.archivedBy
  delete stripped.aliasOf
  delete stripped.dir
  delete stripped.route
  return stripped
}

function stripDirAndDerived(manifest: PageManifest | FragmentManifest): ComponentManifest {
  const stripped = { ...manifest } as ComponentManifest & Record<string, unknown>
  delete stripped.dir
  delete stripped.route
  return stripped
}
