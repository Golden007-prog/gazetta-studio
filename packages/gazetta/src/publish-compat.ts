/**
 * Public publish functions of the `gazetta` package, kept with their
 * original signatures for code that scripts a publish.
 *
 * They delegate to the live pipeline — `publishPage` / `publishFragment`
 * → `publishItemCore`, the path the CLI and admin take via `publishRun` —
 * so there is one implementation. These used to be a separate copy; it
 * drifted from the pipeline and hid two regressions (#958, #959).
 *
 * Contract kept from the old functions: resolve `{ files, removed? }` on
 * success, throw on failure (not found, render error, storage error).
 */
import type { CacheConfig, StorageProvider } from './types.js'
import type { ContentRoot } from './content-root.js'
import type { SeoContext } from './seo.js'
import { loadSite, type Site } from './site-loader.js'
import { publishPage } from './pages/publish.js'
import { publishFragment } from './fragments/publish.js'
import type { PublishItemResult, PublishTarget } from './publish-item.js'

async function siteFor(sourceRoot: ContentRoot, templatesDir: string | undefined, preloaded?: Site): Promise<Site> {
  return preloaded ?? (await loadSite({ contentRoot: sourceRoot, templatesDir, manifest: { name: '(publish)' } }))
}

function unwrap(result: PublishItemResult): { files: number; removed: number } {
  if (!result.ok) {
    const detail = 'reason' in result ? result.reason : result.issues.map(i => i.message).join('; ')
    throw new Error(`${result.kind} "${result.name}": ${result.code} — ${detail}`)
  }
  return { files: result.files, removed: result.removed }
}

function target(storage: StorageProvider, type: PublishTarget['type'], extra: Partial<PublishTarget>): PublishTarget {
  return { name: '(publish)', storage, type, ...extra }
}

/** Publish a page to an ESI target: HTML with ESI placeholders + hashed CSS/JS under `pages/{name}/`. */
export async function publishPageRendered(
  pageName: string,
  sourceRoot: ContentRoot,
  targetStorage: StorageProvider,
  targetCache?: CacheConfig,
  templatesDir?: string,
  manifestHash?: string,
  preloadedSite?: Site,
  seo?: SeoContext,
  locale?: string,
): Promise<{ files: number; removed: number }> {
  const site = await siteFor(sourceRoot, templatesDir, preloadedSite)
  return unwrap(
    await publishPage({
      name: pageName,
      locale,
      site,
      sourceRoot,
      target: target(targetStorage, 'esi', { manifestHash, seo, cache: targetCache }),
    }),
  )
}

/** Publish a page to a static target: fully baked HTML at the page's URL path. */
export async function publishPageStatic(
  pageName: string,
  sourceRoot: ContentRoot,
  targetStorage: StorageProvider,
  templatesDir?: string,
  manifestHash?: string,
  preloadedSite?: Site,
  seo?: SeoContext,
  locale?: string,
): Promise<{ files: number }> {
  const site = await siteFor(sourceRoot, templatesDir, preloadedSite)
  const { files } = unwrap(
    await publishPage({
      name: pageName,
      locale,
      site,
      sourceRoot,
      target: target(targetStorage, 'static', { manifestHash, seo }),
    }),
  )
  return { files }
}

/** Publish a fragment: HTML + hashed CSS/JS under `fragments/{name}/`. */
export async function publishFragmentRendered(
  fragmentName: string,
  sourceRoot: ContentRoot,
  targetStorage: StorageProvider,
  templatesDir?: string,
  manifestHash?: string,
  preloadedSite?: Site,
  locale?: string,
): Promise<{ files: number; removed: number }> {
  const site = await siteFor(sourceRoot, templatesDir, preloadedSite)
  return unwrap(
    await publishFragment({
      name: fragmentName,
      locale,
      site,
      sourceRoot,
      target: target(targetStorage, 'esi', { manifestHash }),
    }),
  )
}
