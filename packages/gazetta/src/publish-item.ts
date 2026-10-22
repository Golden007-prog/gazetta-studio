/**
 * Publish pipeline (per-item) — orchestrator for one Page or Fragment
 * write to one Target.
 *
 * Today's `publish-rendered.ts` has 5 publish-* exports
 * (`publishPageRendered`, `publishPageStatic`, `publishFragmentRendered`,
 * `publishArchiveMarker`, `publishSiteManifest`) each repeating the same
 * 13-step sequence: archive precheck → resolve → render → assemble →
 * list-old-files → write-new → cleanup → write hash sidecar → write
 * publish-state sidecar. Adding the soft-delete archive marker (Cut 3)
 * had to land in three places. Adding scheduled-publish or review-state
 * gates would too.
 *
 * `publishItemCore` is the seam that hides the orchestration. Per-kind
 * wrappers (`publishPage`, `publishFragment` in pages/publish.ts +
 * fragments/publish.ts — Cut 4) own kind-specific dispatch:
 * page resolves render-mode from target.type (static vs esi vs dynamic);
 * fragment has only one mode; archive short-circuit applies to both.
 *
 * Pipeline order is locked semantics, not configuration. Per-item:
 *
 *   1. (RESERVED) review-state precheck — Review Cut 5 (pending-review
 *      behavior at publish time)
 *   2. archive precheck (isArchived → route to archive-marker renderer)
 *   3. resolve item from preloadedSite (locale variant if applicable)
 *   4. (RESERVED) dispatchBeforePublishItem hooks
 *   5. invoke renderer (page-rendered / page-static / fragment-rendered /
 *      archive-marker)
 *   6. assemble HTML + CSS + JS (per renderer's output)
 *   7. list old hashed files at item dir
 *   8. write new hashed files (per-file atomic via storage.writeFile;
 *      transient failures retry inline 3x with backoff)
 *   9. write item HTML + content-hash sidecar (.{8hex}.hash)
 *  10. cleanup oldFiles − newFiles
 *  11. write publish-state sidecar (.pub-{ts}, includes noindex flag)
 *  12. (RESERVED) dispatchAfterPublishItem hooks
 *  13. return PublishItemResult
 *
 * Throws are reserved for storage transport failures after retries
 * exhausted, AND for prerequisite breaches (caller must supply a
 * preloadedSite and target init must have completed). Expected
 * outcomes — NOT_FOUND / RENDER_FAILED / TEMPLATE_INVALID /
 * VALIDATION_FAILED — are typed `PublishItemResult` variants.
 */

import { isArchived } from './archive-helpers.js'
import {
  renderArchiveMarker,
  renderFragmentRendered,
  renderPageStatic,
  renderPageWithEsi,
  type FragmentRenderContext,
  type PageRenderContext,
  type RenderOutput,
} from './publish-renderers.js'
import { writeSidecars } from './sidecars.js'
import { publishedPageNoindex } from './seo.js'
import type { CacheConfig, StorageProvider } from './types.js'
import type { Site } from './site-loader.js'
import type { ContentRoot } from './content-root.js'
import type { Issue } from './validation/types.js'

/**
 * Discriminator for the kind of item being published. Spine is the
 * same per kind; per-kind wrappers in `pages/publish.ts` and
 * `fragments/publish.ts` carry the kind through to dispatch +
 * sidecar + audit calls.
 */
export type PublishItemKind = 'page' | 'fragment'

/**
 * Render mode the item is being published with. Resolved by
 * per-kind wrappers from target.type + archive state:
 *   - `'page-rendered'` — ESI placeholders for `@fragment` refs;
 *     fragments composed at request time. Used for `esi` targets.
 *   - `'page-static'` — full-bake; fragments inlined into page HTML.
 *     Used for `static` targets and as the static fallback for
 *     `dynamic` targets.
 *   - `'fragment-rendered'` — fragment rendered standalone for ESI
 *     composition. Used for ALL fragment publishes regardless of
 *     target type.
 *   - `'archive-marker'` — body-skip; emit ONLY the HTML comment
 *     marker line so the worker reads first 200 bytes and
 *     short-circuits to 301/410 per design-soft-delete.md Q10.
 */
export type PublishRenderMode = 'page-rendered' | 'page-static' | 'fragment-rendered' | 'archive-marker'

/**
 * Successful publish outcome. `files` and `removed` mirror today's
 * publish-rendered return shape so consumers (CLI progress, admin
 * SSE) need no projection.
 */
export interface PublishItemOk {
  readonly kind: PublishItemKind
  readonly name: string
  readonly locale?: string
  readonly ok: true
  readonly mode: PublishRenderMode
  readonly files: number
  readonly removed: number
}

/**
 * Item not found at the source — caller passed a name that
 * doesn't exist in the preloaded site. Routes/CLI project to a
 * 404 / non-zero exit; orchestrator continues to next item per
 * Q4 fail-soft.
 */
export interface PublishItemNotFound {
  readonly kind: PublishItemKind
  readonly name: string
  readonly locale?: string
  readonly ok: false
  readonly code: 'NOT_FOUND'
  readonly reason: string
}

/**
 * Renderer threw OR returned malformed output (non-string html,
 * missing required field). Per design-rendering.md the renderer
 * is best-effort; one bad page doesn't abort the run.
 */
export interface PublishItemRenderFailed {
  readonly kind: PublishItemKind
  readonly name: string
  readonly locale?: string
  readonly ok: false
  readonly code: 'RENDER_FAILED'
  readonly reason: string
}

/**
 * Template the item references is invalid (didn't pass scan).
 * Run-level template scan happens once at boot per Q5 step 3;
 * surface here for items that reference a scan-failed template.
 */
export interface PublishItemTemplateInvalid {
  readonly kind: PublishItemKind
  readonly name: string
  readonly locale?: string
  readonly ok: false
  readonly code: 'TEMPLATE_INVALID'
  readonly reason: string
}

/**
 * Pre-publish validators (per validation Cut 4) emitted blocking
 * issues for this item. Caller (orchestrator) decides whether to
 * include validators in the per-item run; today admin's POST
 * /api/publish/audit gates separately.
 */
export interface PublishItemValidationFailed {
  readonly kind: PublishItemKind
  readonly name: string
  readonly locale?: string
  readonly ok: false
  readonly code: 'VALIDATION_FAILED'
  readonly issues: readonly Issue[]
}

/**
 * Storage write retries exhausted (transport blip). Item-level
 * fail-soft per Q4; run continues with next item.
 */
export interface PublishItemStorageWriteFailed {
  readonly kind: PublishItemKind
  readonly name: string
  readonly locale?: string
  readonly ok: false
  readonly code: 'STORAGE_WRITE_FAILED'
  readonly reason: string
}

/**
 * Typed union of expected per-item publish outcomes. Routes/CLI
 * `switch` exhaustively to project to wire shape (HTTP / SSE /
 * stdout). Adding a variant produces a TS error at every
 * consumer — intentional, per Q1 lock.
 */
export type PublishItemResult =
  | PublishItemOk
  | PublishItemNotFound
  | PublishItemRenderFailed
  | PublishItemTemplateInvalid
  | PublishItemValidationFailed
  | PublishItemStorageWriteFailed

/**
 * Inputs to `publishItemCore`. Carries the resolved render-mode
 * decision (per-kind wrappers compute it from target.type +
 * archive state) plus the renderer strategy that owns mode-specific
 * assembly.
 */
export interface PublishItemInput {
  readonly kind: PublishItemKind
  readonly name: string
  readonly locale?: string
  /** Render mode resolved by per-kind wrapper before calling core. */
  readonly mode: PublishRenderMode
  /** Loaded site, shared across the publish run (loaded ONCE in publishRun). */
  readonly site: Site
  /** Source content tree the item is read from. */
  readonly sourceRoot: ContentRoot
  /** Target storage being published TO. */
  readonly target: PublishTarget
}

/**
 * Per-target context. Mirrors the relevant subset of `TargetConfig`
 * + provider handle without importing the admin-api boundary type.
 * `publishRun` builds this once per target during boot phase 6
 * (init target storage); per-item core consumes it.
 */
export interface PublishTarget {
  readonly name: string
  readonly storage: StorageProvider
  /** Target type resolved per design-rendering.md (static / esi / dynamic). */
  readonly type: 'static' | 'esi' | 'dynamic'
  /**
   * Optional per-target manifest content hash for the item being
   * published. publishRun precomputes via hashManifest so per-item
   * core doesn't recompute.
   */
  readonly manifestHash?: string
  /** Optional SEO context for fallback-chain rendering. */
  readonly seo?: import('./seo.js').SeoContext
  /** Optional target-level cache config (browser / edge TTL); page-level overrides win in renderer. */
  readonly cache?: CacheConfig
}

/** List existing hashed files at item dir (for cleanup). */
async function listHashedFiles(storage: StorageProvider, dir: string): Promise<string[]> {
  try {
    const entries = await storage.readDir(dir)
    return entries
      .filter(e => !e.isDirectory && /\.(css|js)$/.test(e.name) && /\.[a-f0-9]{8}\./.test(e.name))
      .map(e => `${dir}/${e.name}`)
  } catch {
    return []
  }
}

/** Delete files from oldFiles[] not in newFiles[]; return removed count. */
async function cleanupOldFiles(
  storage: StorageProvider,
  oldFiles: readonly string[],
  newFiles: readonly string[],
): Promise<number> {
  const newSet = new Set(newFiles)
  let removed = 0
  for (const file of oldFiles) {
    if (!newSet.has(file)) {
      try {
        await storage.rm(file)
        removed++
      } catch {
        /* already gone */
      }
    }
  }
  return removed
}

/**
 * Item dir resolution per render mode. ESI + fragment + archive write
 * under `pages/{name}/` or `fragments/{name}/`; static-mode pages
 * write to URL-derived path (`/about` → `about/index.html`). Static
 * mode is handled by `pages/publish.ts` Cut 4 — core treats all kinds
 * uniformly under `{kind}s/{name}/`.
 */
/**
 * Where a static target serves a page: `/` → `index.html`, `/about` →
 * `about/index.html`, locale `fr` → `fr/about/index.html`. Same rule as
 * before publish pipeline Cut 3.
 */
export function staticPageIndexPath(route: string, locale?: string): string {
  const base = route === '/' ? '' : route.replace(/^\/+|\/+$/g, '')
  const urlPath = locale ? (base ? `${locale}/${base}` : locale) : base
  return urlPath ? `${urlPath}/index.html` : 'index.html'
}

async function removeIfExists(storage: StorageProvider, path: string): Promise<void> {
  try {
    if (await storage.exists(path)) await storage.rm(path)
  } catch {
    /* best-effort cleanup */
  }
}

function itemDir(kind: PublishItemKind, name: string): string {
  return `${kind === 'page' ? 'pages' : 'fragments'}/${name}`
}

/**
 * Publish pipeline orchestrator (per-item) — Cut 3.
 *
 * Ports the 13-step spine from `publish-rendered.ts`'s 5 publish-*
 * functions. Mode dispatch (page-rendered / page-static /
 * fragment-rendered / archive-marker) consumes pure-fn renderers
 * from `publish-renderers.ts` (Cut 2). Storage I/O + sidecar writes
 * + cleanup live here.
 *
 * Pipeline sequence (locked per Q5):
 *
 *   1. (RESERVED) review-state precheck — Review Cut 5
 *   2. archive precheck — `mode: 'archive-marker'` → renderArchiveMarker
 *   3. resolve item from preloadedSite (NOT_FOUND if missing)
 *   4. (RESERVED) dispatchBeforePublishItem hooks
 *   5. invoke renderer (mode dispatch)
 *   6-7. (renderer produces RenderOutput; assembly + hashing internal)
 *   8. list old hashed files
 *   9. mkdir + write index file + write hashed files
 *  10. cleanup oldFiles − newFiles
 *  11. write content-hash + publish-state sidecars
 *  12. (RESERVED) dispatchAfterPublishItem hooks
 *  13. return PublishItemResult
 */
export async function publishItemCore(input: PublishItemInput): Promise<PublishItemResult> {
  const { kind, name, locale, mode, site, target } = input

  // Step 3 — resolve item. Mode dispatch reads from site.pages /
  // site.fragments to verify existence; renderers do their own lookup
  // but we surface NOT_FOUND here (via typed result) before render.
  const map = kind === 'page' ? site.pages : site.fragments
  const item = map.get(name)
  if (!item) {
    return {
      kind,
      name,
      locale,
      ok: false,
      code: 'NOT_FOUND',
      reason: `${kind === 'page' ? 'Page' : 'Fragment'} "${name}" not found in source`,
    }
  }

  // Step 5 — invoke renderer per mode. Each renderer is pure;
  // assembly + hashing happen inside.
  let output: RenderOutput
  try {
    if (mode === 'archive-marker') {
      // Step 2 — archive precheck materializes here. Renderer reads
      // aliasOf directly; caller (per-kind wrapper) chose this mode
      // because isArchived(item) was true.
      output = renderArchiveMarker(item, locale)
    } else if (mode === 'page-rendered') {
      const ctx: PageRenderContext = { site, locale, seo: target.seo, targetCache: target.cache }
      output = await renderPageWithEsi(name, ctx)
    } else if (mode === 'page-static') {
      const ctx: PageRenderContext = { site, locale, seo: target.seo, targetCache: target.cache }
      output = await renderPageStatic(name, ctx)
    } else {
      // fragment-rendered
      const ctx: FragmentRenderContext = { site, locale }
      output = await renderFragmentRendered(name, ctx)
    }
  } catch (err) {
    // Renderer threw (template SSR fail, malformed manifest). Surface
    // as RENDER_FAILED per Q4 fail-soft — orchestrator continues with
    // next item.
    const reason = err instanceof Error ? err.message : String(err)
    return { kind, name, locale, ok: false, code: 'RENDER_FAILED', reason }
  }

  // Step 8 — list old hashed files at item dir for cleanup pass below.
  // Hashed files and sidecars live under `{kind}s/{name}/` for every
  // layout; only a static page's index HTML moves (see indexPath).
  const dir = itemDir(kind, name)
  // Pages on a static target are served by a plain file server, so the
  // index (page or archive marker) goes to the page's URL path. ESI
  // pages and fragments keep `{kind}s/{name}/{indexFile}`.
  const staticRoute = kind === 'page' && target.type === 'static' ? site.pages.get(name)?.route : undefined
  const staticPage = staticRoute !== undefined
  const indexPath = staticPage ? staticPageIndexPath(staticRoute, locale) : `${dir}/${output.indexFile}`
  const oldFiles = await listHashedFiles(target.storage, dir)
  const newFiles: string[] = []

  // Step 9 — mkdir, write index, write hashed files. Per-file atomic
  // via storage.writeFile; surface storage failures as
  // STORAGE_WRITE_FAILED per Q4.
  try {
    await target.storage.mkdir(dir)
    if (staticPage) {
      const parent = indexPath.includes('/') ? indexPath.slice(0, indexPath.lastIndexOf('/')) : ''
      if (parent) await target.storage.mkdir(parent)
    }
    await target.storage.writeFile(indexPath, output.indexHtml)
    // A static page published between publish pipeline Cut 3 and this
    // fix left its index under `pages/{name}/`; nothing serves it there.
    if (staticPage) await removeIfExists(target.storage, `${dir}/${output.indexFile}`)
    let fileCount = 1 // index file
    for (const f of output.files) {
      await target.storage.writeFile(f.path, f.content)
      newFiles.push(f.path)
      fileCount++
    }

    // Step 10 — cleanup old hashed files not in newFiles.
    const removed = await cleanupOldFiles(target.storage, oldFiles, newFiles)

    // Step 11 — sidecars (hash + publish-state). Skipped when caller
    // doesn't pass manifestHash (CLI / tests sometimes omit). Archive
    // marker forces noindex: true; live pages read it from
    // metadata.robots; fragments don't carry pub state at all.
    if (target.manifestHash) {
      // Pages can declare noindex via metadata.robots; fragments have no
      // metadata field. Archive marker always forces noindex.
      const page = kind === 'page' && locale ? (site.pageLocales.get(name)?.locales.get(locale) ?? item) : item
      const pageMeta = kind === 'page' ? (page as { metadata?: { robots?: string } }).metadata : undefined
      const noindex = publishedPageNoindex(pageMeta, output.archived === true)
      await writeSidecars(
        target.storage,
        dir,
        {
          hash: target.manifestHash,
          // Fragments don't get pub-state sidecars (they're composition
          // primitives, not addressable URLs). Pages always get one.
          pub: kind === 'page' ? { lastPublished: new Date().toISOString(), noindex } : null,
        },
        locale,
      )
    }

    return {
      kind,
      name,
      locale,
      ok: true,
      mode,
      files: fileCount,
      removed,
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { kind, name, locale, ok: false, code: 'STORAGE_WRITE_FAILED', reason }
  }
}
