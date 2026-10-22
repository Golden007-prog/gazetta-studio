import { join } from 'node:path'
import { memoryCache } from './cache/factories.js'
import { forSite } from './cache/per-site.js'
import { loadSite } from './site-loader.js'
import { fragmentHashLookup } from './fragment-hashes.js'
import { hashManifest } from './hash.js'
import { scanTemplates, templateHashesFrom, type TemplateInfo } from './templates-scan.js'
import { listSidecars } from './sidecars.js'
import { isArchived } from './archive-helpers.js'
import { publishedPageNoindex } from './seo.js'
import type { StorageProvider } from './types.js'
import type { ContentRoot } from './content-root.js'

export interface CompareResult {
  /** Items present locally but not on target (no sidecar found) */
  added: string[]
  /** Items present on both, hashes or published indexing state differ */
  modified: string[]
  /** Items present on target but not locally */
  deleted: string[]
  /** Items present on both with matching hashes and published indexing state */
  unchanged: string[]
  /** Target has no sidecars at all (never published, or pre-sidecar) */
  firstPublish: boolean
  /** Templates that failed to scan — compare still completes, but hashes for affected pages may be off */
  invalidTemplates: { name: string; errors: string[] }[]
}

export interface CompareOptions {
  /** Source content root. */
  sourceRoot: ContentRoot
  target: StorageProvider
  templatesDir: string
  projectRoot: string
  /** Project-level manifest — passed to loadSite so targets don't need their own site config. */
  manifest?: import('./types.js').SiteManifest
  /**
   * Target's rendering type. In static mode fragments are baked into pages, so
   * they're not published as separate items — omit them from compare to avoid
   * listing @header / @footer as "added" when they can't actually be published.
   * Defaults to 'dynamic' (include fragments).
   */
  type?: 'static' | 'dynamic'
  /**
   * Injectable template scanner. The default reads from disk every call; the
   * admin-api server injects a memoized version invalidated by the template
   * file watcher (5s → 0ms on large projects).
   */
  scanTemplates?: (templatesDir: string, projectRoot: string) => Promise<TemplateInfo[]>
}

/**
 * Compare local source state against a published target.
 *
 * Local: hashes each page/fragment manifest with template hashes substituted in memory.
 * Target: lists `pages/` and `fragments/` recursively, reading sidecar filenames
 * (`.{8hex}.hash`) — no per-file content reads needed.
 *
 * Returns added/modified/deleted/unchanged lists. Items use `pages/{name}` or
 * `fragments/{name}` form so they can be passed back to publish.
 */
export async function compareTargets(opts: CompareOptions): Promise<CompareResult> {
  const { sourceRoot } = opts

  // 1. Validate + hash templates
  const scan = opts.scanTemplates ?? scanTemplates
  const templateInfos = await scan(opts.templatesDir, opts.projectRoot)
  const invalidTemplates = templateInfos.filter(t => !t.valid).map(t => ({ name: t.name, errors: t.errors }))
  const templateHashes = templateHashesFrom(templateInfos)

  // 2. Load local site, compute manifest hashes.
  // Source-side sidecars (written on save) let us skip re-hashing for items
  // whose manifest + templates haven't changed since the last save. Fall
  // back to hashManifest for items without a source sidecar.
  //
  // Empty source (no site config / no manifest supplied) is a valid state
  // when the "active" target is a publish-target that's never received
  // content — e.g., the author just switched to an empty staging for a
  // peek. Treat as zero items; everything on the destination target becomes
  // "deleted" (present on target, absent from source), matching the
  // logical diff semantics.
  let site: Awaited<ReturnType<typeof loadSite>>
  if (opts.manifest) {
    site = await loadSite({ contentRoot: sourceRoot, templatesDir: opts.templatesDir, manifest: opts.manifest })
  } else {
    site = {
      manifest: { name: '(empty)', targets: {} },
      pages: new Map(),
      pageLocales: new Map(),
      fragments: new Map(),
      fragmentLocales: new Map(),
      contentRoot: sourceRoot,
      storage: sourceRoot.storage,
      siteDir: sourceRoot.rootPath,
      templatesDir: opts.templatesDir,
      // Fresh per-empty-site cache; not shared. Compare doesn't read
      // through this cache, but the Site type now requires the field
      // (Cut 2). forSite-wrapped to keep the contract uniform.
      cache: forSite(memoryCache(), '(empty)'),
    }
  }
  // Hash fragments first (they don't depend on page hashes). Static-mode
  // page hashes include fragment hashes so a fragment content change
  // invalidates every page that bakes it in.
  //
  // Always re-hash from in-memory manifests rather than reading source-
  // side `.{hash}.hash` sidecars. Reasons:
  //   - The source-side cache could go stale after a template-source
  //     edit (the cache holds the pre-edit hash), causing dynamic-mode
  //     targets to falsely report "unchanged" until the next manifest
  //     save. (Static-mode already always re-hashed for the same
  //     reason — fragment hashes change the combined page hash, and
  //     cached source sidecars don't include fragment hashes.)
  //   - `loadSite` already loaded every manifest into memory; re-hashing
  //     is microsecond-scale per manifest. The cache saved nothing
  //     meaningful and introduced a real correctness hole.
  // Each item bakes the fragments it references, resolved for its own
  // locale (and through archive aliases) the way rendering resolves them.
  const fragmentHashes = fragmentHashLookup(site, templateHashes)

  const local = new Map<string, string>()
  const pageNoindex = new Map<string, boolean>()
  // Static pages bake every fragment; ESI pages bake only fragments nested
  // in inline components (their top-level refs are composed per request).
  const pageHashOpts = (locale?: string) => ({
    templateHashes,
    fragmentHashes: fragmentHashes(locale),
    topLevelFragmentsComposedAtRequest: opts.type !== 'static',
  })
  for (const [name, page] of site.pages) {
    local.set(`pages/${name}`, hashManifest(page, pageHashOpts()))
    pageNoindex.set(`pages/${name}`, publishedPageNoindex(page.metadata, isArchived(page)))

    // Per-locale items — each locale variant is compared independently
    const localeEntry = site.pageLocales.get(name)
    if (localeEntry) {
      for (const [locale, localePage] of localeEntry.locales) {
        const localeKey = `pages/${name}:${locale}`
        local.set(localeKey, hashManifest(localePage, pageHashOpts(locale)))
        pageNoindex.set(localeKey, publishedPageNoindex(localePage.metadata, isArchived(page)))
      }
    }
  }
  // Static targets bake fragments into pages — no fragment sidecars exist
  // on the target, and publishing @header/@footer is a no-op server-side. Omit
  // them from local so they don't appear as perpetually "added".
  if (opts.type !== 'static') {
    for (const [name, frag] of site.fragments) {
      local.set(`fragments/${name}`, hashManifest(frag, { templateHashes, fragmentHashes: fragmentHashes() }))
    }
    // Per-locale fragment items
    for (const [name, localeEntry] of site.fragmentLocales) {
      for (const [locale, localeFrag] of localeEntry.locales) {
        local.set(
          `fragments/${name}:${locale}`,
          hashManifest(localeFrag, { templateHashes, fragmentHashes: fragmentHashes(locale) }),
        )
      }
    }
  }

  // 3. List target sidecars — one pass per root, parallel inside.
  const target = new Map<string, string>()
  const [pagesSidecars, fragmentsSidecars] = await Promise.all([
    listSidecars(opts.target, 'pages'),
    opts.type !== 'static' ? listSidecars(opts.target, 'fragments') : Promise.resolve(new Map()),
  ])
  for (const [k, s] of pagesSidecars) target.set(`pages/${k}`, s.hash)
  for (const [k, s] of fragmentsSidecars) target.set(`fragments/${k}`, s.hash)

  // 4. Diff
  const result: CompareResult = {
    added: [],
    modified: [],
    deleted: [],
    unchanged: [],
    firstPublish: target.size === 0,
    invalidTemplates,
  }

  for (const [item, hash] of local) {
    const targetHash = target.get(item)
    const published = item.startsWith('pages/') ? pagesSidecars.get(item.slice('pages/'.length))?.pub : undefined
    const staleIndexing = published && published.noindex !== pageNoindex.get(item)
    if (targetHash === undefined) result.added.push(item)
    else if (targetHash === hash && !staleIndexing) result.unchanged.push(item)
    else result.modified.push(item)
  }
  for (const item of target.keys()) {
    if (!local.has(item)) result.deleted.push(item)
  }

  return result
}
