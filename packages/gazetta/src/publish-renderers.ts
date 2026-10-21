/**
 * Pure-fn renderers — Cut 2 of publish pipeline extraction.
 *
 * Each renderer takes a resolved item + render context and returns
 * a `RenderOutput` describing what should be written to storage:
 * the index HTML body, plus zero-or-more hashed files (CSS/JS) that
 * the spine emits as separate writes.
 *
 * Renderers are PURE — no I/O, no side effects. They produce data;
 * the spine writes it. This separation lets us test each render
 * mode in isolation (fast unit tests, no storage mocks) and lets
 * future modes plug in without touching the spine.
 *
 * Per Q2 lock: 4 modes, each their own pure fn.
 *   - `renderPageWithEsi` — page-rendered (ESI placeholders for `@fragment`
 *     refs; fragments composed at request time by worker)
 *   - `renderPageStatic` — page-static (full-bake; fragments inlined)
 *   - `renderFragmentRendered` — fragment-rendered (standalone for ESI
 *     composition)
 *   - `renderArchiveMarker` — archive-marker (body-skip; emit ONLY the
 *     HTML comment marker line)
 *
 * Cut 2 introduces these as standalone fns; the existing 5 publish-*
 * exports in publish-rendered.ts stay and call into them inline.
 * Cut 3 wires them through `publishItemCore`'s spine; Cut 8 deletes
 * the publish-rendered.ts orchestration.
 */

import { createHash } from 'node:crypto'
import { isArchived } from './archive-helpers.js'
import { renderComponent, renderPage } from './renderer.js'
import { resolveFragment, resolvePage } from './resolver.js'
import { archiveMarker } from './runtime/archive-marker.js'
import { escapeAttr, resolveSeoTags, type SeoContext } from './seo.js'
import type { Site } from './site-loader.js'
import type { CacheConfig, PageManifest } from './types.js'

/**
 * One file to write. The spine emits these — renderer produces the
 * descriptor. `path` is relative to the target's content root;
 * `content` is the body bytes.
 *
 * Hashed files (CSS/JS) get their content-hash computed by the
 * renderer (so the renderer can build the `<link>` / `<script>` tags
 * pointing at the hashed filename). The spine writes them as-is.
 */
interface RenderedFile {
  readonly path: string
  readonly content: string
}

/**
 * Output of a renderer pass. Spine consumes this:
 *   1. Writes `indexFile` content to `{itemDir}/{indexFile}`
 *   2. Writes each `files[i]` content to `files[i].path`
 *   3. Lists pre-existing hashed files at `itemDir`, removes any
 *      not in `files[]` (cleanup)
 *   4. Writes sidecars (hash + pub-state) if `sidecarHash` provided
 *
 * `archived` is true for the archive-marker renderer — spine uses it
 * to set the `noindex` flag on the publish-state sidecar.
 */
export interface RenderOutput {
  /** Filename for the index HTML write (e.g., 'index.html' or 'index.fr.html'). */
  readonly indexFile: string
  /** HTML body to write at `{itemDir}/{indexFile}`. */
  readonly indexHtml: string
  /** Hashed CSS / JS files to write alongside the index. */
  readonly files: readonly RenderedFile[]
  /** True for archived-marker renderer (drives noindex flag in pub sidecar). */
  readonly archived: boolean
}

/**
 * Page render context — assembled by per-kind wrapper from the
 * loaded site + target config. Renderers are agnostic to where this
 * came from; pure-fn input.
 */
export interface PageRenderContext {
  /** Loaded site (shared across the publish run). */
  readonly site: Site
  /** Locale variant being rendered; undefined = default locale. */
  readonly locale?: string
  /** SEO fallback-chain context (target siteUrl + site name + locale + defaultOgImage). */
  readonly seo?: SeoContext
  /** Target-level cache config (browser / edge TTL); page-level overrides win in renderer. */
  readonly targetCache?: CacheConfig
}

/** Fragment render context — same shape minus page-only fields. */
export interface FragmentRenderContext {
  readonly site: Site
  readonly locale?: string
}

/** 8-char MD5 prefix per the existing `.{8hex}.hash` sidecar convention. */
function contentHash(content: string): string {
  return createHash('md5').update(content).digest('hex').slice(0, 8)
}

/**
 * The manifest a locale page renders from. Locale variants are whole
 * files, not overlays on the default page (design-i18n.md), so metadata,
 * cache, route and component order all come from the variant.
 */
function pageForLocale(pageName: string, page: PageManifest, ctx: PageRenderContext): PageManifest {
  if (!ctx.locale) return page
  return ctx.site.pageLocales.get(pageName)?.locales.get(ctx.locale) ?? page
}

// ─── Page (ESI mode) ────────────────────────────────────────────────────

/**
 * Render a page in ESI mode: `@fragment` refs become ESI placeholders
 * for the worker to compose at request time; inline components are
 * baked into the page HTML. Used for `esi` targets.
 *
 * Pure fn: returns descriptors; caller (spine) writes them.
 *
 * Throws if the page is archived — caller must check `isArchived`
 * first and route to `renderArchiveMarker` instead. Same for
 * not-found pages (caller resolves from `site.pages.get` and
 * surfaces NOT_FOUND result).
 */
export async function renderPageWithEsi(pageName: string, ctx: PageRenderContext): Promise<RenderOutput> {
  const page = ctx.site.pages.get(pageName)
  if (!page) throw new Error(`Page "${pageName}" not found`)
  if (isArchived(page)) {
    throw new Error(`Page "${pageName}" is archived; use renderArchiveMarker instead`)
  }

  const localePage = pageForLocale(pageName, page, ctx)
  const resolved = await resolvePage(pageName, ctx.site, ctx.locale)

  // Render each child — fragments become ESI placeholders, local components baked in
  const bodyParts: string[] = []
  const localCssParts: string[] = []
  const localJsParts: string[] = []
  const localHeadParts: string[] = []
  const esiHeadTags: string[] = []

  for (let i = 0; i < resolved.children.length; i++) {
    const childEntry = localePage.components![i]
    const isFragment = typeof childEntry === 'string' && childEntry.startsWith('@')

    if (isFragment) {
      const fragName = childEntry.slice(1)
      const fragFile = ctx.locale ? `index.${ctx.locale}.html` : 'index.html'
      const fragPath = `fragments/${fragName}/${fragFile}`
      esiHeadTags.push(`<!--esi-head:/${fragPath}-->`)
      bodyParts.push(`<!--esi:/${fragPath}-->`)
    } else {
      const rendered = await renderComponent(resolved.children[i])
      bodyParts.push(rendered.html)
      if (rendered.css) localCssParts.push(rendered.css)
      if (rendered.js) localJsParts.push(rendered.js)
      if (rendered.head) localHeadParts.push(rendered.head)
    }
  }

  // Render page-level template (layout CSS, head tags)
  const lang = ctx.seo?.locale || ctx.locale || 'en'
  const childOutputs = await Promise.all(resolved.children.map(c => renderComponent(c, undefined, lang)))
  const pageOutput = await resolved.template({ content: resolved.content, children: childOutputs, locale: lang })
  if (pageOutput.css) localCssParts.unshift(pageOutput.css)
  if (pageOutput.head) localHeadParts.unshift(pageOutput.head)

  const pageDir = `pages/${pageName}`
  const files: RenderedFile[] = []

  // Hashed CSS file
  const pageCss = localCssParts.join('\n')
  let pageCssLink = ''
  if (pageCss) {
    const hash = contentHash(pageCss)
    const cssPath = `${pageDir}/styles.${hash}.css`
    files.push({ path: cssPath, content: pageCss })
    pageCssLink = `<link rel="stylesheet" href="/${cssPath}">`
  }

  // Hashed JS file
  const pageJs = localJsParts.join('\n')
  let pageJsLink = ''
  if (pageJs) {
    const hash = contentHash(pageJs)
    const jsPath = `${pageDir}/script.${hash}.js`
    files.push({ path: jsPath, content: pageJs })
    pageJsLink = `<script type="module" src="/${jsPath}"></script>`
  }

  // SEO tags (renderer dedupes against template head)
  const templateHead = localHeadParts.join('\n')
  const seoHead = resolveSeoTags({
    metadata: localePage.metadata,
    content: localePage.content,
    route: localePage.route,
    seo: ctx.seo ?? {},
    templateHead,
  })

  const headContent = [
    `<meta charset="UTF-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1.0">`,
    seoHead,
    ...localHeadParts,
    pageCssLink,
    ...esiHeadTags,
    pageJsLink,
  ]
    .filter(Boolean)
    .join('\n  ')

  const bodyContent = bodyParts.join('\n')

  // Cache config: page → target → defaults. Comment is read by the
  // worker on serve to set Cache-Control headers.
  const browser = localePage.cache?.browser ?? ctx.targetCache?.browser ?? 0
  const edge = localePage.cache?.edge ?? ctx.targetCache?.edge ?? 86400
  const cacheComment = `<!--cache:browser=${browser},edge=${edge}-->\n`

  const indexHtml = `${cacheComment}<!DOCTYPE html>
<html lang="${escapeAttr(lang)}">
<head>
  ${headContent}
</head>
<body>
${bodyContent}
</body>
</html>`

  const indexFile = ctx.locale ? `index.${ctx.locale}.html` : 'index.html'

  return { indexFile, indexHtml, files, archived: false }
}

// ─── Page (static mode) ─────────────────────────────────────────────────

/**
 * Render a page in static mode: full-bake; fragments inlined; CSS/JS
 * inline. Used for `static` targets (no worker).
 *
 * Different output layout than ESI mode: writes to URL-derived path
 * (`/about` → `about/index.html`) rather than `pages/{name}/`. Caller
 * computes the output path from `page.route` + locale prefix.
 *
 * Returns the rendered HTML; spine handles directory layout decision
 * (caller knows the path conventions for the static-target layout).
 */
export async function renderPageStatic(pageName: string, ctx: PageRenderContext): Promise<RenderOutput> {
  const page = ctx.site.pages.get(pageName)
  if (!page) throw new Error(`Page "${pageName}" not found`)
  if (isArchived(page)) {
    throw new Error(`Page "${pageName}" is archived; use renderArchiveMarker instead`)
  }

  const localePage = pageForLocale(pageName, page, ctx)
  const resolved = await resolvePage(pageName, ctx.site, ctx.locale)
  const indexHtml = await renderPage(resolved, {
    metadata: localePage.metadata,
    route: localePage.route,
    seo: ctx.seo,
  })

  // Static mode bakes everything inline — no separate hashed CSS/JS files.
  // The renderPage helper handles that internally.
  const indexFile = ctx.locale ? `index.${ctx.locale}.html` : 'index.html'

  return { indexFile, indexHtml, files: [], archived: false }
}

// ─── Fragment (rendered) ────────────────────────────────────────────────

/**
 * Render a fragment standalone for ESI composition. Output is the
 * fragment's HTML wrapped in a `<head>` section if CSS/JS exist —
 * the worker injects head content before `</head>` and body content
 * at the ESI placeholder.
 */
export async function renderFragmentRendered(fragmentName: string, ctx: FragmentRenderContext): Promise<RenderOutput> {
  const fragment = ctx.site.fragments.get(fragmentName)
  if (!fragment) throw new Error(`Fragment "${fragmentName}" not found`)

  const resolved = await resolveFragment(fragmentName, ctx.site, ctx.locale)
  const rendered = await renderComponent(resolved)

  const fragDir = `fragments/${fragmentName}`
  const files: RenderedFile[] = []
  const headParts: string[] = []

  if (rendered.css) {
    const hash = contentHash(rendered.css)
    const cssPath = `${fragDir}/styles.${hash}.css`
    files.push({ path: cssPath, content: rendered.css })
    headParts.push(`<link rel="stylesheet" href="/${cssPath}">`)
  }

  if (rendered.js) {
    const hash = contentHash(rendered.js)
    const jsPath = `${fragDir}/script.${hash}.js`
    files.push({ path: jsPath, content: rendered.js })
    headParts.push(`<script type="module" src="/${jsPath}"></script>`)
  }

  if (rendered.head) {
    headParts.push(rendered.head)
  }

  const headSection = headParts.length ? `<head>\n${headParts.join('\n')}\n</head>\n` : ''
  const indexHtml = `${headSection}${rendered.html}`
  const indexFile = ctx.locale ? `index.${ctx.locale}.html` : 'index.html'

  return { indexFile, indexHtml, files, archived: false }
}

// ─── Archive marker ─────────────────────────────────────────────────────

/**
 * Render the soft-delete archive marker — body-skip, single line.
 * The worker reads the first 200 bytes, sees the marker, and emits
 * 301 (alias) or 410 (gone) without composing. Per
 * design-soft-delete.md Q10.
 *
 * Caller checks `isArchived(page)` first; this is the dispatch
 * target for that branch.
 */
export function renderArchiveMarker(
  page: { aliasOf?: string; metadata?: { robots?: string } },
  locale?: string,
): RenderOutput {
  // Caller has already checked isArchived (dispatched HERE because of it).
  // Read aliasOf directly — `aliasTarget()` re-checks archived state and
  // returns null for non-archived inputs, which would emit gone-form for
  // every test fixture that doesn't bother synthesizing an archived flag.
  const target = page.aliasOf ?? null
  const indexHtml = target ? archiveMarker({ kind: 'alias', target }) : archiveMarker({ kind: 'gone' })
  const indexFile = locale ? `index.${locale}.html` : 'index.html'

  // Archive emits no CSS/JS; spine's cleanup pass removes any stale
  // hashed files from the prior live publish.
  return { indexFile, indexHtml, files: [], archived: true }
}
