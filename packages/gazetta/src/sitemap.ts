/**
 * Sitemap generation — produces sitemap.xml from target sidecars.
 *
 * SRP: this module owns sitemap XML assembly. It takes the sidecar
 * listing from a target's `pages/` directory (already available via
 * `listSidecars`) and produces the XML string. No I/O — the caller
 * reads sidecars and writes the result to storage.
 *
 * The sitemap reflects what's ACTUALLY published on the target, not
 * what's in the source. A page that exists in source but was never
 * published won't appear. A page that was deleted from source but
 * is still live on the target WILL appear (until the next full
 * publish removes its sidecars).
 *
 * Pages with `.pub-*-noindex` sidecars are excluded. System pages
 * (e.g. 404) are excluded by name.
 */
import type { SidecarState } from './sidecars.js'
import { deriveRoute } from './site-loader.js'
import { trimTrailingSlashes } from './url.js'

/** hreflang alternate for a single page — locale code + absolute URL. */
interface HreflangAlternate {
  locale: string
  url: string
}

export interface GenerateSitemapOptions {
  /** Absolute base URL (e.g. "https://gazetta.studio"). */
  siteUrl: string
  /** Target sidecar listing — keyed by page name (e.g. "home", "about"). */
  pages: Map<string, SidecarState>
  /** System page names to exclude (e.g. ["404"]). */
  systemPages?: string[]
  /**
   * hreflang alternates per page — keyed by page name. Each entry lists
   * all locale variants (including self). Only pages with 2+ alternates
   * get hreflang in the sitemap. Noindex variants are excluded by the caller.
   */
  hreflangGroups?: Map<string, HreflangAlternate[]>
  /** Default locale code — used for x-default in hreflang. */
  defaultLocale?: string
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Generate sitemap XML from target sidecars. Returns null when no
 * pages qualify (all noindex, or empty target).
 */
export function generateSitemap(opts: GenerateSitemapOptions): string | null {
  const systemSet = new Set(opts.systemPages ?? [])
  const base = trimTrailingSlashes(opts.siteUrl)
  const urls: string[] = []

  // Sort by page name for deterministic output across runs.
  const sorted = [...opts.pages.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  for (const [name, state] of sorted) {
    // Locale-qualified entries (home:fr) are handled as separate <url> entries
    // with their locale-prefixed route. The base page name is before the colon.
    const isLocaleEntry = name.includes(':')
    const baseName = isLocaleEntry ? name.split(':')[0] : name
    const locale = isLocaleEntry ? name.split(':')[1] : null

    if (systemSet.has(baseName)) continue
    if (state.pub?.noindex) continue
    if (baseName.includes('[')) continue // dynamic routes — can't sitemap template patterns

    // For locale entries, use the locale-prefixed route (e.g. /fr/about).
    // For default entries, use the standard route (e.g. /about).
    const baseRoute = deriveRoute(baseName)
    const route = locale ? (baseRoute === '/' ? `/${locale}` : `/${locale}${baseRoute}`) : baseRoute
    const loc = `${base}${route}`
    const lastmod = state.pub?.lastPublished

    const parts = [`    <loc>${escapeXml(loc)}</loc>`]
    if (lastmod) {
      // Sitemap spec wants YYYY-MM-DD or full ISO — use date only
      parts.push(`    <lastmod>${lastmod.slice(0, 10)}</lastmod>`)
    }
    // hreflang cross-links — only when 2+ locale variants exist.
    // Locale entries share the same hreflang group as their base page.
    const alternates = opts.hreflangGroups?.get(baseName)
    if (alternates && alternates.length > 1) {
      for (const alt of alternates) {
        parts.push(
          `    <xhtml:link rel="alternate" hreflang="${escapeXml(alt.locale)}" href="${escapeXml(alt.url)}" />`,
        )
      }
      if (opts.defaultLocale) {
        const defaultAlt = alternates.find(a => a.locale === opts.defaultLocale)
        if (defaultAlt) {
          parts.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(defaultAlt.url)}" />`)
        }
      }
    }
    urls.push(`  <url>\n${parts.join('\n')}\n  </url>`)
  }

  if (urls.length === 0) return null

  const hasHreflang = opts.hreflangGroups && [...opts.hreflangGroups.values()].some(alts => alts.length > 1)
  const xmlns = hasHreflang
    ? '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">'
    : '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'

  return ['<?xml version="1.0" encoding="UTF-8"?>', xmlns, ...urls, '</urlset>', ''].join('\n')
}
