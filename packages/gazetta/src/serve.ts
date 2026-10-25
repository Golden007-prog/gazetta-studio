/**
 * Gazetta Node production server — serves pages from any StorageProvider
 * with ESI fragment assembly. Same role as the Cloudflare Worker, but
 * runs on Node/Bun for self-hosted deployments (VPS, Docker, Fly.io).
 *
 * SOLID breakdown:
 * - extractLocale: strips locale prefix from URL (SRP)
 * - fetchFragmentEntries: reads fragment files with locale fallback + alias handling (SRP)
 * - findPage: resolves a request path to page HTML (SRP)
 * - acceptLanguageRedirect: middleware for language detection (SRP, OCP)
 * - createServer: composes the above into a Hono app
 */

import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { createHash } from 'node:crypto'
import type { SiteManifest, StorageProvider, TargetType } from './types.js'
import { assembleEsi, parseCacheComment } from './assemble.js'
import { isPublicSitePath } from './public-site-path.js'
import { assetServeRoutes } from './assets/serve-route.js'
import { assetMimeForPath, exactArrayBuffer } from './assets/serve-shared.js'
import { archiveGoneResponse, archiveResponse } from './runtime/archive-response.js'
import { aliasTargetIssue, parseArchiveMarker } from './runtime/archive-marker.js'
import { deriveRoute, fillRouteParams } from './runtime/derive-route.js'
import { resolveSiteLocales } from './locale.js'
import { fetchFragmentEntries } from './runtime/fragment-fetch.js'

/** Locale options for `createServer`, resolved from the site manifest.
 * Empty object when the site has no `locales` config. */
export function serveLocaleOptions(
  site: SiteManifest,
): Pick<ServeOptions, 'locales' | 'defaultLocale' | 'defaultPrefix' | 'detection'> {
  const loc = resolveSiteLocales(site)
  if (!loc) return {}
  return {
    locales: loc.supported,
    defaultLocale: loc.default,
    defaultPrefix: loc.defaultPrefix,
    detection: loc.detection,
  }
}

export interface ServeOptions {
  storage: StorageProvider
  /** Target type: 'dynamic' assembles fragments at request time (ESI), 'static' serves pre-rendered HTML directly */
  type?: TargetType
  /** Supported locale codes (lowercase). When set, enables locale-prefix routing (e.g. /fr/about → pages/about/index.fr.html). */
  locales?: string[]
  /** Default locale — requests to the default locale have no URL prefix. Falls back to first in `locales`. */
  defaultLocale?: string
  /** When true, the default locale also gets a URL prefix (e.g. /en/about). */
  defaultPrefix?: boolean
  /** When true, redirects unlocalized requests to the best Accept-Language match (302). */
  detection?: boolean
}

// ---------------------------------------------------------------------------
// Locale resolution (SRP)
// ---------------------------------------------------------------------------

export interface LocaleRoute {
  /** The locale extracted from the URL prefix, or undefined for default locale requests. */
  locale: string | undefined
  /** The request path with locale prefix stripped. */
  path: string
}

/**
 * Extract a locale prefix from a request path. Returns the locale (if any)
 * and the remaining path. Only matches against the provided supported set.
 */
export function extractLocale(requestPath: string, locales: string[]): LocaleRoute {
  if (locales.length === 0) return { locale: undefined, path: requestPath }
  const parts = requestPath.split('/').filter(Boolean)
  if (parts.length > 0 && locales.includes(parts[0])) {
    return { locale: parts[0], path: '/' + parts.slice(1).join('/') || '/' }
  }
  return { locale: undefined, path: requestPath }
}

// ---------------------------------------------------------------------------
// Accept-Language detection (SRP, OCP — pluggable middleware)
// ---------------------------------------------------------------------------

/**
 * Parse the Accept-Language header and return the best matching locale
 * from the supported set. Returns undefined if no match.
 */
export function matchAcceptLanguage(header: string | undefined, locales: string[]): string | undefined {
  if (!header || locales.length === 0) return undefined
  // Parse Accept-Language: fr-FR,fr;q=0.9,en;q=0.8 → sorted by quality
  const entries = header.split(',').map(part => {
    const [lang, ...params] = part.trim().split(';')
    const q = params.find(p => p.trim().startsWith('q='))
    return { lang: lang.trim().toLowerCase(), q: q ? parseFloat(q.trim().slice(2)) : 1 }
  })
  entries.sort((a, b) => b.q - a.q)

  for (const { lang } of entries) {
    // Exact match (e.g. fr-fr → fr-fr)
    if (locales.includes(lang)) return lang
    // Language-only match (e.g. fr-fr → fr)
    const base = lang.split('-')[0]
    if (locales.includes(base)) return base
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Fragment fetching with locale fallback (SRP)
// ---------------------------------------------------------------------------

async function readFragmentHtml(storage: StorageProvider, path: string): Promise<string | null> {
  try {
    return await storage.readFile(path.slice(1))
  } catch {
    // Locale fragment not found — fall back to default locale
    // e.g. /fragments/header/index.fr.html → /fragments/header/index.html
    const localeFallback = path.replace(/\/index\.[a-z-]+\.html$/, '/index.html')
    if (localeFallback !== path) {
      try {
        return await storage.readFile(localeFallback.slice(1))
      } catch {
        /* fallback also missing */
      }
    }
    return null
  }
}

// ---------------------------------------------------------------------------
// Page lookup (SRP)
// ---------------------------------------------------------------------------

export interface FindPageResult {
  html: string
  locale: string | undefined
  /** Values captured from the request's dynamic route segments. */
  params?: Record<string, string>
}

/**
 * Resolve a request path to page HTML. Handles locale-suffixed files
 * (index.fr.html) and dynamic route segments ([param]).
 */
export async function findPage(
  storage: StorageProvider,
  requestPath: string,
  locales?: string[],
): Promise<FindPageResult | null> {
  const { locale, path: resolvedPath } = locales?.length
    ? extractLocale(requestPath, locales)
    : { locale: undefined, path: requestPath }
  const indexFile = locale ? `index.${locale}.html` : 'index.html'

  // Try exact page path
  const pagePath = resolvedPath === '/' ? `pages/home/${indexFile}` : `pages${resolvedPath}/${indexFile}`
  try {
    return { html: await storage.readFile(pagePath), locale }
  } catch {
    // Locale page not found — fall back to default locale file
    if (locale) {
      const fallback = resolvedPath === '/' ? 'pages/home/index.html' : `pages${resolvedPath}/index.html`
      try {
        return { html: await storage.readFile(fallback), locale }
      } catch {
        /* fallback also missing — continue to dynamic routes */
      }
    }
  }

  // Dynamic segments — list parent dir, find [param] entries
  const parts = resolvedPath.split('/').filter(Boolean)
  for (let i = parts.length - 1; i >= 0; i--) {
    const parentDir = parts.slice(0, i).join('/')
    const prefix = parentDir ? `pages/${parentDir}` : 'pages'
    try {
      const entries = await storage.readDir(prefix)
      for (const entry of entries) {
        if (entry.isDirectory && entry.name.startsWith('[') && entry.name.endsWith(']')) {
          const dynamicParts = [...parts]
          dynamicParts[i] = entry.name
          const params = { [entry.name.slice(1, -1)]: parts[i] }
          const dynamicPath = `pages/${dynamicParts.join('/')}/${indexFile}`
          try {
            return { html: await storage.readFile(dynamicPath), locale, params }
          } catch {
            if (locale) {
              try {
                return { html: await storage.readFile(`pages/${dynamicParts.join('/')}/index.html`), locale, params }
              } catch {
                /* fallback also missing */
              }
            }
          }
        }
      }
    } catch {
      /* dir not found */
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Server composition
// ---------------------------------------------------------------------------

export function createServer(options: ServeOptions) {
  const { storage, type = 'dynamic', locales, defaultLocale, defaultPrefix, detection } = options
  const nonDefaultLocales = locales?.filter(l => l !== (defaultLocale ?? locales?.[0])) ?? []
  const archiveFor = (html: string, locale: string | undefined, params?: Record<string, string>) =>
    archiveResponse(html, { locale, defaultLocale: defaultLocale ?? locales?.[0], defaultPrefix, params })

  // Static targets store each language's version at the language's route,
  // so an alias redirect keeps the request's language only when the
  // destination has a version in it; otherwise the 301 goes to the
  // destination's default-language page, like the `_redirects` row
  // (design-soft-delete.md Q10).
  const staticArchiveFor = async (html: string, locale: string | undefined) => {
    const siteDefault = defaultLocale ?? locales?.[0]
    let effectiveLocale = locale
    if (locale && locale !== siteDefault) {
      const marker = parseArchiveMarker(html)
      if (marker?.kind === 'alias' && aliasTargetIssue(marker.target) === null) {
        const route = fillRouteParams(deriveRoute(marker.target))
        if (route === null) return archiveGoneResponse()
        const rel = `${locale}${route === '/' ? '' : route}/index.html`
        let hasVersion = false
        for (const candidate of [`/${rel}`, rel]) {
          if (await storage.exists(candidate)) {
            hasVersion = true
            break
          }
        }
        if (!hasVersion) effectiveLocale = undefined
      }
    }
    // Static publish writes default-language pages unprefixed until #1146,
    // so prefixing the default locale here would redirect to a 404.
    return archiveResponse(html, { locale: effectiveLocale, defaultLocale: siteDefault, defaultPrefix: false })
  }
  const readFragment = (path: string) => readFragmentHtml(storage, path)
  const app = new Hono()

  app.use(logger())

  // Strip trailing slashes — normalize /fr/ to /fr, /about/ to /about.
  // Re-dispatches through Hono router. No redirect — preserves POST body.
  app.use(async (c, next) => {
    const url = new URL(c.req.url)
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1)
      return app.fetch(new Request(url, c.req.raw), c.env)
    }
    return next()
  })

  app.get('/health', c => c.json({ ok: true }))

  /**
   * Cache lifetime for a stored non-page file on a static target (#1249):
   * publish fingerprints /assets/ names, so they can be immutable; other
   * files (robots.txt, sitemap.xml, favicon) get the ESI routes' one hour.
   */
  function staticFileCacheControl(requestPath: string): string {
    if (requestPath.startsWith('/assets/')) return 'public, max-age=31536000, immutable'
    return 'public, max-age=3600'
  }

  if (type === 'static') {
    app.get('*', async c => {
      const requestPath = new URL(c.req.url).pathname
      // Private storage (audit log, history, manifests, sidecars) answers
      // 404, like a missing page.
      if (!isPublicSitePath(requestPath)) {
        return c.html('<h1>404 — Page not found</h1>', 404)
      }
      const { locale } = extractLocale(requestPath, locales ?? [])
      const filePath = requestPath === '/' ? 'index.html' : `${requestPath.replace(/\/$/, '')}/index.html`
      try {
        const html = await storage.readFile(filePath)
        const archived = await staticArchiveFor(html, locale)
        if (archived) return archived
        const etag = `"${createHash('sha256').update(html).digest('hex').slice(0, 16)}"`
        if (c.req.header('If-None-Match') === etag) return new Response(null, { status: 304, headers: { ETag: etag } })
        return c.html(html, 200, { 'Cache-Control': 'public, max-age=0, must-revalidate', ETag: etag })
      } catch {
        // Not a page — serve the stored file byte-exact with a content
        // type from its extension (#1249). Reading it as UTF-8 text and
        // answering `c.html` corrupted binary files and typed every
        // stored file as text/html. HTML files keep the text path so
        // the archived-page check still runs.
        const contentType = assetMimeForPath(requestPath)
        const isHtml = requestPath.endsWith('.html') || requestPath.endsWith('.htm')
        if (isHtml) {
          try {
            const html = await storage.readFile(requestPath.slice(1))
            const archived = await staticArchiveFor(html, locale)
            if (archived) return archived
            return c.html(html)
          } catch {
            // fall through to the 404 chain below
          }
        }
        try {
          const bytes = await storage.readBytes(requestPath.slice(1))
          return new Response(exactArrayBuffer(bytes), {
            headers: {
              'Content-Type': contentType,
              'Cache-Control': staticFileCacheControl(requestPath),
            },
          })
        } catch {
          // The target's own 404.html, as plain hosts show it (#1152).
          try {
            return c.html(await storage.readFile('404.html'), 404)
          } catch {
            return c.html('<h1>404 — Page not found</h1>', 404)
          }
        }
      }
    })
    return app
  }

  // ESI mode — assemble fragments at request time

  // Root-level files (sitemap.xml, robots.txt) — served from storage
  app.get('/sitemap.xml', async c => {
    try {
      const content = await storage.readFile('sitemap.xml')
      return new Response(content, {
        headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
      })
    } catch {
      return c.notFound()
    }
  })
  app.get('/robots.txt', async c => {
    try {
      const content = await storage.readFile('robots.txt')
      return new Response(content, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
      })
    } catch {
      return c.notFound()
    }
  })

  // Hashed CSS/JS — immutable cache
  app.get('/pages/*', async c => serveAsset(c, storage, true))
  app.get('/fragments/*', async c => serveAsset(c, storage))

  // Published assets (content-addressed uploads) — the same shared route
  // `gazetta dev` mounts, so ESI serve answers the /assets/* URLs that
  // templates emit. Registered before locale detection and the page
  // catch-all, which would otherwise 404 or redirect them (#1330).
  app.route(
    '/',
    assetServeRoutes(async () => storage),
  )

  // Accept-Language detection — redirect unlocalized requests to best match
  if (detection && nonDefaultLocales.length > 0) {
    app.get('*', async (c, next) => {
      const requestPath = new URL(c.req.url).pathname
      // Only redirect paths that don't already have a locale prefix. With
      // defaultPrefix on, the default locale's prefix counts too — otherwise
      // /en/about would look unlocalized and redirect to /fr/en/about.
      const prefixLocales = defaultPrefix ? (locales ?? []) : nonDefaultLocales
      const { locale: existingLocale } = extractLocale(requestPath, prefixLocales)
      if (existingLocale) return next()
      // Check cookie opt-out (user explicitly chose a locale)
      const localeCookie = c.req.header('Cookie')?.match(/(?:^|;\s*)locale=([a-z-]+)/)?.[1]
      if (localeCookie && nonDefaultLocales.includes(localeCookie)) {
        return c.redirect(`/${localeCookie}${requestPath === '/' ? '' : requestPath}`, 302)
      }
      // Match Accept-Language against non-default locales
      const match = matchAcceptLanguage(c.req.header('Accept-Language'), nonDefaultLocales)
      if (match) return c.redirect(`/${match}${requestPath === '/' ? '' : requestPath}`, 302)
      return next()
    })
  }

  // Page serving with ESI assembly
  app.get('*', async c => {
    const requestPath = new URL(c.req.url).pathname

    const result = await findPage(storage, requestPath, locales)
    if (!result) {
      const notFound = await findPage(storage, '/404')
      if (notFound && !archiveResponse(notFound.html)) {
        const { html: raw404 } = parseCacheComment(notFound.html)
        const fragEntries = await fetchFragmentEntries(readFragment, raw404)
        return c.html(assembleEsi(raw404, fragEntries), 404)
      }
      return c.html('<h1>404 — Page not found</h1>', 404)
    }

    const archived = archiveFor(result.html, result.locale, result.params)
    if (archived) return archived

    const { html: rawHtml, browser, edge } = parseCacheComment(result.html)
    const fragEntries = await fetchFragmentEntries(readFragment, rawHtml)
    const html = assembleEsi(rawHtml, fragEntries)

    const etag = `"${createHash('sha256').update(html).digest('hex').slice(0, 16)}"`
    if (c.req.header('If-None-Match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } })
    }

    const headers: Record<string, string> = {
      'Cache-Control': `public, max-age=${browser}, s-maxage=${edge}`,
      ETag: etag,
    }
    // Set locale cookie when visiting a locale-prefixed URL — persists the
    // author's language choice so Accept-Language detection doesn't override it.
    if (result.locale && nonDefaultLocales.length > 0) {
      headers['Set-Cookie'] = `locale=${result.locale}; Path=/; SameSite=Lax; Max-Age=31536000`
    }
    return c.html(html, 200, headers)
  })

  return app
}

async function serveAsset(c: any, storage: StorageProvider, checkArchive = false) {
  const path = new URL(c.req.url).pathname.slice(1)
  try {
    const content = await storage.readFile(path)
    const ext = path.split('.').pop()
    if (checkArchive && ext === 'html') {
      const archived = archiveResponse(content)
      if (archived) return archived
    }
    const contentType = ext === 'css' ? 'text/css' : ext === 'js' ? 'text/javascript' : 'text/html'
    return new Response(content, {
      headers: {
        'Content-Type': `${contentType}; charset=utf-8`,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  } catch {
    return c.notFound()
  }
}
