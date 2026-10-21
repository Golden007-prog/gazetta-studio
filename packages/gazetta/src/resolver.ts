import type {
  ResolvedComponent,
  ComponentEntry,
  InlineComponent,
  ComponentManifest,
  FragmentManifest,
} from './types.js'
import { loadTemplate } from './template-loader.js'
import { processContent } from './content.js'
import { resolveAssetRefs, type AssetResolveContext } from './assets/resolve.js'
import type { Site } from './site-loader.js'
import { resolveLocaleFallback, resolveSiteLocales, type ResolvedLocales } from './locale.js'
import { resolveSiteThemes, type ResolvedThemes } from './themes.js'
import { resolveFragmentArchiveAlias } from './archive-helpers.js'

/**
 * Build the asset-resolve context from the site being rendered. Shared
 * across all `processContent` + `resolveAssetRefs` pairs in a single
 * resolution pass. Locale + theme flow in from the render-time
 * `ResolveContext`; locales/themes config is derived from `site.manifest`
 * once and reused.
 */
function assetContext(
  site: Site,
  locale: string | undefined,
  theme: string | undefined,
  resolvedLocales: ResolvedLocales | null,
  resolvedThemes: ResolvedThemes | null,
): AssetResolveContext {
  return {
    storage: site.storage,
    assetsRoot: 'assets',
    locale,
    theme,
    locales: resolvedLocales,
    themes: resolvedThemes,
  }
}

/** Process content: sync transforms (markdown) + async asset resolution. */
async function processAndResolve(
  content: Record<string, unknown> | undefined,
  schema: unknown,
  site: Site,
  ctx: { locale?: string; theme?: string; resolvedLocales?: ResolvedLocales; resolvedThemes?: ResolvedThemes | null },
): Promise<Record<string, unknown> | undefined> {
  const processed = processContent(content, schema)
  return resolveAssetRefs(
    processed,
    assetContext(site, ctx.locale, ctx.theme, ctx.resolvedLocales ?? null, ctx.resolvedThemes ?? null),
  )
}

interface ResolveContext {
  site: Site
  templatesDir: string
  visited: Set<string>
  path: string[]
  /** When set, fragment references resolve the locale-specific variant first. */
  locale?: string
  /**
   * Active theme for asset resolution. v1 doesn't yet route a theme value
   * from runtime callers (page/fragment templates emit theme-aware CSS via
   * tokens, not via SSR theme branching); the field is wired so step 18+
   * runtime work can pass it without resolver changes.
   */
  theme?: string
  /** Resolved site locales — cached for fallback resolution. */
  resolvedLocales?: ResolvedLocales
  /** Resolved site themes — needed for font variant enumeration. */
  resolvedThemes?: ResolvedThemes | null
}

export async function resolveComponent(entry: ComponentEntry, ctx: ResolveContext): Promise<ResolvedComponent> {
  if (typeof entry === 'string') {
    if (!entry.startsWith('@')) {
      throw new Error(
        `Invalid component entry "${entry}" — string entries must be fragment references starting with @.\n` +
          `  Referenced in: ${ctx.path.join(' → ') || 'page root'}`,
      )
    }
    const fragmentName = entry.slice(1)
    return resolveFragmentRef(fragmentName, ctx)
  }

  return resolveInlineComponent(entry, ctx)
}

/**
 * Look up a fragment by name with locale fallback. Returns null when the
 * fragment doesn't exist (in any locale). Doesn't follow aliasOf —
 * that's the caller's job (via `resolveFragmentArchiveAlias`).
 *
 * Locale resolution: a locale-specific variant (`fragment.fr.json`)
 * wins when available + reachable per the resolved-locales fallback
 * chain; otherwise the default-locale manifest is used.
 *
 * Used by both `resolveFragmentRef` (per-component path) and
 * `resolveFragment` (entry-point path). Sharing the lookup keeps
 * locale + alias resolution coherent across both paths.
 */
export function lookupFragmentForLocale(
  fragmentName: string,
  ctx: { site: Site; locale?: string; resolvedLocales?: ResolvedLocales },
): (FragmentManifest & { dir: string }) | null {
  let fragment = ctx.site.fragments.get(fragmentName) ?? null
  if (ctx.locale && ctx.resolvedLocales) {
    const localeEntry = ctx.site.fragmentLocales.get(fragmentName)
    if (localeEntry) {
      const available = new Set(localeEntry.locales.keys())
      const bestLocale = resolveLocaleFallback(ctx.locale, available, ctx.resolvedLocales)
      const localeVariant = localeEntry.locales.get(bestLocale)
      if (localeVariant) fragment = localeVariant
    }
  }
  return fragment
}

async function resolveFragmentRef(fragmentName: string, ctx: ResolveContext): Promise<ResolvedComponent> {
  const key = `@${fragmentName}`
  if (ctx.visited.has(key)) {
    throw new Error(`Circular reference detected: ${key}\n` + `  Resolution path: ${ctx.path.join(' → ')} → ${key}`)
  }
  ctx.visited.add(key)
  ctx.path.push(key)

  // Look up the fragment, following aliasOf when archived (Q2 F1 lock).
  // Throws ArchivedNoAliasError if archived without alias; throws on
  // alias chains > MAX_ALIAS_HOPS or cycles (defensive — Q3 flatten
  // guarantees one hop in practice).
  const lookup = (name: string): ComponentManifest | null => lookupFragmentForLocale(name, ctx)
  let resolution: ReturnType<typeof resolveFragmentArchiveAlias>
  try {
    resolution = resolveFragmentArchiveAlias(fragmentName, lookup, ctx.path.join(' → '))
  } catch (err) {
    ctx.path.pop()
    ctx.visited.delete(key)
    throw err
  }

  if (!resolution) {
    const available = [...ctx.site.fragments.keys()]
    ctx.path.pop()
    ctx.visited.delete(key)
    throw new Error(
      `Fragment "@${fragmentName}" not found.\n` +
        `  Referenced in: ${ctx.path.join(' → ') || 'page root'}\n` +
        `  Available fragments: ${available.length > 0 ? available.join(', ') : '(none)'}`,
    )
  }
  // Cast: lookup callback only returns Site fragment entries which carry `dir`.
  const fragment = resolution.manifest as FragmentManifest & { dir: string }

  // After `resolveFragmentArchiveAlias` the returned manifest is live
  // (the alias chain has been followed; archived-without-alias surfaced
  // as ArchivedNoAliasError). Template must be present at this point;
  // defensive throw catches an invariant break before it produces a
  // confusing template-loader error.
  if (typeof fragment.template !== 'string') {
    ctx.path.pop()
    ctx.visited.delete(key)
    throw new Error(
      `Fragment "@${fragmentName}" resolved to a manifest with no template; this should not happen after alias resolution`,
    )
  }
  const loaded = await loadTemplate(ctx.site.storage, ctx.templatesDir, fragment.template)
  const children: ResolvedComponent[] = []
  if (fragment.components) {
    for (const child of fragment.components) {
      children.push(await resolveComponent(child, ctx))
    }
  }

  const treePath = ctx.path.slice(1).join('/')
  ctx.path.pop()
  ctx.visited.delete(key)

  return {
    template: loaded.render,
    content: await processAndResolve(fragment.content, loaded.schema, ctx.site, ctx),
    children,
    path: fragment.dir,
    treePath,
  }
}

async function resolveInlineComponent(comp: InlineComponent, ctx: ResolveContext): Promise<ResolvedComponent> {
  const key = comp.name
  if (ctx.visited.has(key)) {
    throw new Error(`Circular reference detected: ${key}\n` + `  Resolution path: ${ctx.path.join(' → ')} → ${key}`)
  }
  ctx.visited.add(key)
  ctx.path.push(comp.name)

  const loaded = await loadTemplate(ctx.site.storage, ctx.templatesDir, comp.template)
  const children: ResolvedComponent[] = []
  if (comp.components) {
    for (const child of comp.components) {
      children.push(await resolveComponent(child, ctx))
    }
  }

  const treePath = ctx.path.slice(1).join('/')
  ctx.path.pop()
  ctx.visited.delete(key)

  return {
    template: loaded.render,
    content: await processAndResolve(comp.content, loaded.schema, ctx.site, ctx),
    children,
    treePath,
  }
}

export async function resolveFragment(
  fragmentName: string,
  site: Site,
  locale?: string,
  theme?: string,
): Promise<ResolvedComponent> {
  // Always resolve site-level config — even when no active locale/theme
  // is set, the asset resolver may need it (font enumeration walks the
  // configured theme universe).
  const resolvedLocales = resolveSiteLocales(site.manifest) ?? undefined
  const resolvedThemes = resolveSiteThemes(site.manifest)

  // Look up the fragment, following aliasOf when archived (Q2 F1 lock).
  const lookup = (name: string): ComponentManifest | null =>
    lookupFragmentForLocale(name, { site, locale, resolvedLocales })
  const resolution = resolveFragmentArchiveAlias(fragmentName, lookup, `@${fragmentName}`)
  if (!resolution) {
    const available = [...site.fragments.keys()]
    throw new Error(
      `Fragment "${fragmentName}" not found.\n` +
        `  Available fragments: ${available.length > 0 ? available.join(', ') : '(none)'}`,
    )
  }
  const fragment = resolution.manifest as FragmentManifest & { dir: string }

  // Live fragment guaranteed by `resolveFragmentArchiveAlias` (per the
  // same invariant as `resolveComponent`'s fragment branch above).
  if (typeof fragment.template !== 'string') {
    throw new Error(
      `Fragment "${fragmentName}" resolved to a manifest with no template; this should not happen after alias resolution`,
    )
  }

  const templatesDir = site.templatesDir
  const ctx: ResolveContext = {
    site,
    templatesDir,
    visited: new Set(),
    path: ['', `@${resolution.resolvedName}`],
    locale,
    theme,
    resolvedLocales,
    resolvedThemes,
  }

  const loaded = await loadTemplate(site.storage, templatesDir, fragment.template)
  const children: ResolvedComponent[] = []
  if (fragment.components) {
    for (const child of fragment.components) {
      children.push(await resolveComponent(child, ctx))
    }
  }

  return {
    template: loaded.render,
    content: await processAndResolve(fragment.content, loaded.schema, site, ctx),
    children,
    path: fragment.dir,
    treePath: '',
  }
}

export async function resolvePage(
  pageName: string,
  site: Site,
  locale?: string,
  theme?: string,
): Promise<ResolvedComponent> {
  const defaultPage = site.pages.get(pageName)
  if (!defaultPage) {
    const available = [...site.pages.keys()]
    throw new Error(
      `Page "${pageName}" not found.\n` +
        `  Available pages: ${available.length > 0 ? available.join(', ') : '(none)'}`,
    )
  }

  // Use locale variant's content/components when available, fall back to default
  const localeEntry = locale ? site.pageLocales.get(pageName) : undefined
  const page = localeEntry?.locales.get(locale!) ?? defaultPage

  const templatesDir = site.templatesDir
  const resolvedLocales = resolveSiteLocales(site.manifest) ?? undefined
  const resolvedThemes = resolveSiteThemes(site.manifest)
  const ctx: ResolveContext = {
    site,
    templatesDir,
    visited: new Set(),
    path: [pageName],
    locale,
    theme,
    resolvedLocales,
    resolvedThemes,
  }

  // Archived pages (per design-soft-delete.md) are intercepted before
  // `resolvePage` is called — the publish flow short-circuits via
  // `isArchived(page)` and emits an archive marker instead. Reaching
  // this point with a missing template is a structural bug; surface it
  // loudly rather than passing `undefined` into the template loader.
  if (typeof page.template !== 'string') {
    throw new Error(`Page "${pageName}" has no template; archived pages should not be passed to resolvePage`)
  }
  const loaded = await loadTemplate(site.storage, templatesDir, page.template)
  const children: ResolvedComponent[] = []
  if (page.components) {
    for (const child of page.components) {
      children.push(await resolveComponent(child, ctx))
    }
  }

  return {
    template: loaded.render,
    content: await processAndResolve(page.content, loaded.schema, site, ctx),
    children,
    path: page.dir,
    treePath: '',
  }
}
