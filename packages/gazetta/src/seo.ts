/**
 * SEO tag resolution — computes `<head>` tags from a fallback chain:
 *   metadata field → content field → site default → omit
 *
 * Single responsibility: this module owns the fallback logic and HTML
 * tag generation for SEO. The renderer calls `resolveSeoTags()` and
 * injects the result into `<head>` — it doesn't know about title
 * truncation, OG deduplication, or robots directives.
 *
 * Open for extension: adding a new tag type is a new block in
 * `resolveSeoTags()`, not a change to the renderer.
 */
import type { PageMetadata } from './types.js'
import { trimTrailingSlashes } from './url.js'

/** Escape HTML attribute values — prevents XSS in generated meta tags. */
export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * SEO context for a rendering pass — assembled by the caller from
 * whatever sources it has (site manifest, target config, etc.).
 * The renderer and seo module depend on this interface only, not
 * on SiteManifest or TargetConfig (DIP).
 */
export interface SeoContext {
  /** Site name — appended to auto-generated titles ("Page — Site Name"). */
  siteName?: string
  /** Target's public URL for canonical/og:url (e.g. "https://gazetta.studio"). */
  siteUrl?: string
  /** Site locale for `<html lang>` (e.g. "en", "fr"). Default: "en". */
  locale?: string
  /** Default OG image for pages that don't specify their own. */
  defaultOgImage?: string
  /**
   * Locale alternates for hreflang — maps locale code to absolute URL.
   * Only set for subpath targets (same domain, all locales).
   * Cross-domain hreflang is handled via sitemap, not HTML tags.
   * Example: { en: "https://example.com/about", fr: "https://example.com/fr/about" }
   */
  hreflangAlternates?: Record<string, string>
  /** The default locale code — used for x-default hreflang. */
  defaultLocale?: string
}

export interface ResolveSeoTagsInput {
  metadata?: PageMetadata
  content?: Record<string, unknown>
  route?: string
  seo: SeoContext
  /** Template-provided head HTML — tags already present won't be duplicated. */
  templateHead?: string
}

/**
 * Resolve all SEO `<head>` tags using the fallback chain. Returns raw
 * HTML string for injection. Template-provided tags are checked for
 * duplicates — a metadata tag is only emitted when the template head
 * doesn't already include it.
 */
export function resolveSeoTags(input: ResolveSeoTagsInput): string {
  const { metadata: meta, content, route, seo, templateHead } = input
  const parts: string[] = []

  // Title: metadata.title → content.title + " — " + siteName → omit
  const title =
    meta?.title || (content?.title ? `${content.title}${seo.siteName ? ` — ${seo.siteName}` : ''}` : undefined)
  if (title && !templateHead?.includes('<title')) {
    parts.push(`<title>${escapeAttr(title)}</title>`)
  }

  // Description: metadata.description → content.description → omit
  const description = meta?.description || (content?.description as string | undefined)
  if (description && !templateHead?.includes('name="description"')) {
    parts.push(`<meta name="description" content="${escapeAttr(description)}">`)
  }

  // Canonical: metadata.canonical → siteUrl + route → omit
  // siteUrl arrives from loosely-validated operator config (targets are a
  // z.unknown passthrough) and from public-API callers: treat anything
  // that is not a string as absent - the old `?.` tolerated null the same
  // way - rather than throwing on `.length` mid-render (#1110 review).
  const base = typeof seo.siteUrl === 'string' ? trimTrailingSlashes(seo.siteUrl) : undefined
  const canonical = meta?.canonical || (base && route ? `${base}${route}` : undefined)
  if (canonical) {
    parts.push(`<link rel="canonical" href="${escapeAttr(canonical)}">`)
  }

  // OG image: metadata.ogImage → site.defaultOgImage → omit
  const ogImage = meta?.ogImage || seo.defaultOgImage
  if (ogImage) {
    parts.push(`<meta property="og:image" content="${escapeAttr(ogImage)}">`)
  }

  // OG title: same chain as <title>
  if (title && !templateHead?.includes('property="og:title"')) {
    parts.push(`<meta property="og:title" content="${escapeAttr(title)}">`)
  }

  // OG description: same chain as description
  if (description && !templateHead?.includes('property="og:description"')) {
    parts.push(`<meta property="og:description" content="${escapeAttr(description)}">`)
  }

  // OG URL: same as canonical
  if (canonical && !templateHead?.includes('property="og:url"')) {
    parts.push(`<meta property="og:url" content="${escapeAttr(canonical)}">`)
  }

  // OG type: always "website"
  if (!templateHead?.includes('property="og:type"')) {
    parts.push('<meta property="og:type" content="website">')
  }

  // Twitter card: summary_large_image when OG image present, summary otherwise
  if (!templateHead?.includes('name="twitter:card"')) {
    parts.push(`<meta name="twitter:card" content="${ogImage ? 'summary_large_image' : 'summary'}">`)
  }

  // Robots: only when explicitly set (absence = allow indexing)
  if (meta?.robots) {
    parts.push(`<meta name="robots" content="${escapeAttr(meta.robots)}">`)
  }

  // hreflang alternates (subpath targets only — cross-domain uses sitemap)
  if (seo.hreflangAlternates && Object.keys(seo.hreflangAlternates).length > 1) {
    for (const [locale, url] of Object.entries(seo.hreflangAlternates)) {
      parts.push(`<link rel="alternate" hreflang="${escapeAttr(locale)}" href="${escapeAttr(url)}">`)
    }
    // x-default points to the default locale URL
    const defaultUrl = seo.defaultLocale && seo.hreflangAlternates[seo.defaultLocale]
    if (defaultUrl) {
      parts.push(`<link rel="alternate" hreflang="x-default" href="${escapeAttr(defaultUrl)}">`)
    }
  }

  return parts.join('\n  ')
}
