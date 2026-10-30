/**
 * Render-for-analysis (Validation Cut 3).
 *
 * Renders a page or fragment to its complete HTML output for consumption by
 * quality validators (a11y, html-validity). Same renderer as preview/publish;
 * no storage write. Caches per (item, locale, theme, content+template+
 * dependency hash).
 *
 * # Multi-instance discipline
 *
 * Per-instance scope. Each admin instance maintains its own cache; cache hits
 * are bounded to one process. Acceptable because:
 *   - Render output is deterministic given the same content + template +
 *     fragment dependencies + locale + theme — different instances arrive at
 *     identical bytes from identical inputs.
 *   - The cache key folds in the hashes that drive determinism, so a stale
 *     instance can't return divergent output: if the content changed, the key
 *     changed, and the new render runs.
 *   - Render-for-analysis is fire-and-forget per scanner pass; no consumer
 *     depends on cross-instance cache sharing.
 *
 * # SOLID lenses
 *
 *   - SRP: this module renders + caches. It doesn't run validators or write
 *     storage; consumers feed the output into their own logic.
 *   - DIP: depends on `AdminCache` interface, not `MemoryCache`; depends on
 *     `Site` and the resolver/renderer functions.
 *   - OCP: adding new validators that consume the rendered output is one new
 *     file in `validators/`; this module unchanged.
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { access, readFile } from 'node:fs/promises'
import type { AdminCache } from './cache/types.js'
import { fragmentHashLookup } from './fragment-hashes.js'
import { hashManifest } from './hash.js'
import { renderPage } from './renderer.js'
import { resolvePage } from './resolver.js'
import type { FragmentManifest, PageManifest } from './types.js'
import type { Site } from './site-loader.js'

/** Output captured by the validators. */
export interface RenderedOutput {
  /** Full document HTML. */
  html: string
}

export interface RenderForAnalysisOptions {
  site: Site
  /** Cache for render results — typically the source's `AdminCache` instance. */
  cache: AdminCache
  /** Templates directory; needed to compute template-source hashes. */
  templatesDir: string
}

/**
 * Render the named page for analysis. Returns null when the item doesn't
 * exist or rendering fails (failures log via `console.warn` but don't throw —
 * validators that depend on output simply skip when output is null).
 */
export async function renderPageForAnalysis(
  pageName: string,
  opts: RenderForAnalysisOptions & { locale?: string; theme?: string },
): Promise<RenderedOutput | null> {
  const { site, cache, templatesDir, locale, theme } = opts
  const page = pageManifestFor(site, pageName, locale)
  if (!page) return null

  const templateHashes = await computeTemplateHashes(site, templatesDir)
  const fragmentHashes = fragmentHashLookup(site, templateHashes)(locale)
  const contentHash = hashManifest(page, { templateHashes, fragmentHashes })
  const key = cacheKey('page', pageName, locale, theme, contentHash)

  const cached = await cache.get<RenderedOutput>(key)
  if (cached !== null) return cached

  try {
    const resolved = await resolvePage(pageName, site, locale, theme)
    const html = await renderPage(resolved, {
      metadata: page.metadata,
      route: page.route,
      seo: { siteName: site.manifest.name, locale: locale ?? 'en', defaultOgImage: site.manifest.defaultOgImage },
    })
    const output: RenderedOutput = { html }
    await cache.set(key, output)
    return output
  } catch (err) {
    console.warn(`[validation/render-for-analysis] page "${pageName}" failed: ${(err as Error).message}`)
    return null
  }
}

// ---- helpers --------------------------------------------------------------

function pageManifestFor(site: Site, name: string, locale?: string): (PageManifest & { dir: string }) | null {
  if (locale) {
    const variant = site.pageLocales.get(name)?.locales.get(locale)
    if (variant) return variant
    // fall through to default-locale page if no variant exists
  }
  return site.pages.get(name) ?? null
}

function cacheKey(
  kind: 'page',
  name: string,
  locale: string | undefined,
  theme: string | undefined,
  hash: string,
): string {
  const loc = locale ?? '_'
  const thm = theme ?? '_'
  return `render-for-analysis:${kind}:${encodeName(name)}:${loc}:${thm}:${hash}`
}

function encodeName(name: string): string {
  return name.replace(/[/]/g, '.').replace(/[^a-zA-Z0-9._-]/g, '_')
}

const TEMPLATE_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx']

/**
 * Compute MD5 hashes of every template's source file. Reused by the
 * publish-side `hashManifest()` machinery; same shape so cache keys
 * align across surfaces.
 */
async function computeTemplateHashes(site: Site, templatesDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const seen = new Set<string>()
  const collect = (manifest: PageManifest | FragmentManifest) => {
    if (manifest.template) seen.add(manifest.template)
    walkTemplates(manifest.components, seen)
  }
  for (const page of site.pages.values()) collect(page)
  for (const frag of site.fragments.values()) collect(frag)
  for (const entry of site.pageLocales.values()) {
    for (const page of entry.locales.values()) collect(page)
  }
  for (const entry of site.fragmentLocales.values()) {
    for (const frag of entry.locales.values()) collect(frag)
  }

  for (const tplName of seen) {
    const hash = await tryHashTemplate(templatesDir, tplName)
    if (hash) out.set(tplName, hash)
  }
  return out
}

function walkTemplates(components: PageManifest['components'] | undefined, out: Set<string>): void {
  if (!components) return
  for (const entry of components) {
    if (typeof entry === 'object' && entry !== null) {
      if (entry.template) out.add(entry.template)
      walkTemplates(entry.components, out)
    }
  }
}

async function tryHashTemplate(templatesDir: string, name: string): Promise<string | null> {
  for (const file of TEMPLATE_FILES) {
    const path = join(templatesDir, name, file)
    try {
      await access(path)
      const bytes = await readFile(path)
      return createHash('md5').update(bytes).digest('hex').slice(0, 8)
    } catch {
      // continue
    }
  }
  return null
}
