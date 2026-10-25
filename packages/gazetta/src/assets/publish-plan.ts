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
      let manifest: Parameters<typeof collectAssetRefs>[0]
      try {
        manifest = JSON.parse(raw) as Parameters<typeof collectAssetRefs>[0]
      } catch (err) {
        console.warn(`  Warning: skipping ${describeItemManifest(item, filename)}: ${(err as Error).message}`)
        continue
      }
      const itemRefs = collectAssetRefs(manifest)
      if (itemRefs.size === 0) continue
      itemsWithRefs.add(item)
      for (const name of itemRefs) refs.add(name)
    }
  }
  return { refs, itemsWithRefs: [...itemsWithRefs] }
}

/** Loader-style label for a skipped item manifest: page "home" locale "fr". */
function describeItemManifest(itemName: string, filename: string): string {
  const kind = itemName.startsWith('fragments/') ? 'fragment' : 'page'
  const name = itemName.slice(itemName.indexOf('/') + 1)
  const stem = kind
  const locale = filename === `${stem}.json` ? null : filename.slice(stem.length + 1, -'.json'.length)
  return locale === null ? `${kind} "${name}"` : `${kind} "${name}" locale "${locale}"`
}
/**
 * The default manifest filename plus every variant of it on storage
 * (page.json + page.fr.json + ..., fragment.json + fragment.fr.json +
 * ...). A missing item directory (unreadable readDir) yields just the
 * default filename so the caller's missing-item tolerance keeps
 * working unchanged.
 */
async function manifestFilenamesFor(input: PlanInput, itemName: string): Promise<string[]> {
  const base = manifestFilenameFor(itemName)
  const stem = base.slice(0, -'.json'.length)
  let entries: { name: string; isDirectory: boolean }[]
  try {
    entries = await input.sourceRoot.storage.readDir(input.sourceRoot.path(itemName))
  } catch {
    return [base]
  }
  const variants = entries
    .filter(e => !e.isDirectory && e.name.startsWith(stem + '.') && e.name.endsWith('.json') && e.name !== base)
    .map(e => e.name)
    .sort()
  return [base, ...variants]
}

function manifestFilenameFor(itemName: string): string {
  return itemName.startsWith('fragments/') ? 'fragment.json' : 'page.json'
}
