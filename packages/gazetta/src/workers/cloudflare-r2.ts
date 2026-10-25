/// <reference types="@cloudflare/workers-types" />

/**
 * Gazetta Cloudflare Worker — serves pages from R2 with ESI fragment assembly.
 *
 * Reads pre-rendered pages and fragments from an R2 bucket,
 * assembles them using ESI-style composition, and serves with
 * Cache API + ETag support. Locale-aware: extracts locale prefix
 * from URL, reads locale-suffixed files, falls back to default.
 *
 * Usage: import and re-export from your worker entry point:
 *
 *   import { createWorker } from 'gazetta/workers/cloudflare-r2'
 *   export default createWorker()
 *
 * Or customize:
 *
 *   import { createWorker } from 'gazetta/workers/cloudflare-r2'
 *   const worker = createWorker({
 *     bucketBinding: 'SITE_BUCKET',
 *     locales: ['en', 'fr', 'de'],
 *     defaultLocale: 'en',
 *   })
 *   export default worker
 */

import { Hono } from 'hono'
import { assembleEsi, parseCacheComment } from '../assemble.js'
import { archiveResponse } from '../runtime/archive-response.js'
import { fetchFragmentEntries } from '../runtime/fragment-fetch.js'
import { stateFolderPath } from '../state-folders.js'
import { isPublicSitePath } from '../public-site-path.js'
import { assetMimeForPath, dispositionFor, ifNoneMatches, parseAssetUrlInput } from '../assets/serve-shared.js'

export interface CloudflareR2WorkerOptions {
  /** R2 bucket binding name (default: 'SITE_BUCKET') */
  bucketBinding?: string
  /** Supported locale codes (lowercase). Enables locale-prefix routing. */
  locales?: string[]
  /** Default locale — no URL prefix. Falls back to first in `locales`. */
  defaultLocale?: string
  /** When true, the default locale also gets a URL prefix (e.g. /en/about). */
  defaultPrefix?: boolean
  /** Custom middleware to add before page serving */
  middleware?: (app: Hono<{ Bindings: Record<string, R2Bucket> }>) => void
}

// ---------------------------------------------------------------------------
// Publish generation cache key (#1125)
// ---------------------------------------------------------------------------

// Each publish writes a new generation to the target before purging, so a
// response read from R2 before the publish but stored after the purge can
// never be served again: the generation in the key no longer matches. A
// missing file gives a fixed key part, so targets published before this
// change cache as before until their next publish. The generation is kept
// for 5 seconds per isolate, so a cache hit doesn't wait for an R2 read and
// a page is stale for at most those 5 seconds after a publish.
const GENERATION_PATH = stateFolderPath('publish-generation')
const GENERATION_TTL_MS = 5000
const NO_GENERATION_KEY_PART = 'pre-generation'

let generationMemo: { value: string; expires: number } | null = null

async function publishGeneration(bucket: R2Bucket): Promise<string> {
  const now = Date.now()
  if (generationMemo && generationMemo.expires > now) return generationMemo.value
  const obj = await bucket.get(GENERATION_PATH)
  const text = obj ? (await obj.text()).trim() : ''
  const value = text === '' ? NO_GENERATION_KEY_PART : text
  generationMemo = { value, expires: now + GENERATION_TTL_MS }
  return value
}

function generationCacheKey(request: Request, generation: string): Request {
  const url = new URL(request.url)
  url.searchParams.set('gazetta-generation', generation)
  return new Request(url.toString(), request)
}

// ---------------------------------------------------------------------------
// Locale extraction (same logic as serve.ts — SRP)
// ---------------------------------------------------------------------------

function extractLocale(requestPath: string, locales: string[]): { locale: string | undefined; path: string } {
  if (locales.length === 0) return { locale: undefined, path: requestPath }
  const parts = requestPath.split('/').filter(Boolean)
  if (parts.length > 0 && locales.includes(parts[0])) {
    return { locale: parts[0], path: '/' + parts.slice(1).join('/') || '/' }
  }
  return { locale: undefined, path: requestPath }
}

// ---------------------------------------------------------------------------
// Fragment fetching with locale fallback (SRP)
// ---------------------------------------------------------------------------

async function readFragmentHtml(bucket: R2Bucket, path: string): Promise<string | null> {
  const key = path.slice(1)
  const obj = await bucket.get(key)
  if (obj) return obj.text()

  // Locale fallback: index.fr.html → index.html
  const localeFallback = key.replace(/\/index\.[a-z-]+\.html$/, '/index.html')
  if (localeFallback !== key) {
    const fallbackObj = await bucket.get(localeFallback)
    if (fallbackObj) return fallbackObj.text()
  }

  return null
}

// ---------------------------------------------------------------------------
// Page lookup with locale support (SRP)
// ---------------------------------------------------------------------------

async function findPage(
  bucket: R2Bucket,
  requestPath: string,
  locales?: string[],
): Promise<{ html: string; locale: string | undefined; params?: Record<string, string> } | null> {
  const { locale, path: resolvedPath } = locales?.length
    ? extractLocale(requestPath, locales)
    : { locale: undefined, path: requestPath }
  const indexFile = locale ? `index.${locale}.html` : 'index.html'

  // Try exact page path
  const pagePath = resolvedPath === '/' ? `pages/home/${indexFile}` : `pages${resolvedPath}/${indexFile}`
  const obj = await bucket.get(pagePath)
  if (obj) return { html: await obj.text(), locale }

  // Locale fallback to default
  if (locale) {
    const fallback = resolvedPath === '/' ? 'pages/home/index.html' : `pages${resolvedPath}/index.html`
    const fallbackObj = await bucket.get(fallback)
    if (fallbackObj) return { html: await fallbackObj.text(), locale }
  }

  // Dynamic segments — list parent directory, find [param] entries
  const parts = resolvedPath.split('/').filter(Boolean)
  for (let i = parts.length - 1; i >= 0; i--) {
    const parentDir = parts.slice(0, i).join('/')
    const prefix = parentDir ? `pages/${parentDir}/` : 'pages/'
    const listed = await bucket.list({ prefix, delimiter: '/' })
    for (const item of listed.delimitedPrefixes) {
      const segment = item.replace(prefix, '').replace(/\/$/, '')
      if (segment.startsWith('[') && segment.endsWith(']')) {
        const dynamicParts = [...parts]
        dynamicParts[i] = segment
        const params = { [segment.slice(1, -1)]: parts[i] }
        const dynamicPath = `pages/${dynamicParts.join('/')}/${indexFile}`
        const dynObj = await bucket.get(dynamicPath)
        if (dynObj) return { html: await dynObj.text(), locale, params }
        // Dynamic route locale fallback
        if (locale) {
          const dynFallback = await bucket.get(`pages/${dynamicParts.join('/')}/index.html`)
          if (dynFallback) return { html: await dynFallback.text(), locale, params }
        }
      }
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Worker composition
// ---------------------------------------------------------------------------

export function createWorker(options?: CloudflareR2WorkerOptions) {
  const bindingName = options?.bucketBinding ?? 'SITE_BUCKET'
  const locales = options?.locales
  const defaultLocale = options?.defaultLocale
  const defaultPrefix = options?.defaultPrefix
  const nonDefaultLocales = locales?.filter(l => l !== (defaultLocale ?? locales?.[0])) ?? []
  const archiveFor = (html: string, locale: string | undefined, params?: Record<string, string>) =>
    archiveResponse(html, { locale, defaultLocale: defaultLocale ?? locales?.[0], defaultPrefix, params })

  const app = new Hono<{ Bindings: Record<string, R2Bucket> }>()

  // Custom middleware (e.g., www redirect, auth)
  if (options?.middleware) options.middleware(app)

  // Health check
  app.get('/health', async c => {
    const bucket = c.env[bindingName]
    const pages = await bucket.list({ prefix: 'pages/', delimiter: '/' })
    const fragments = await bucket.list({ prefix: 'fragments/', delimiter: '/' })
    return c.json({ ok: true, pages: pages.delimitedPrefixes.length, fragments: fragments.delimitedPrefixes.length })
  })

  // Root-level files (sitemap.xml, robots.txt) — served from R2
  app.get('/sitemap.xml', async c => {
    const obj = await c.env[bindingName].get('sitemap.xml')
    if (!obj) return c.notFound()
    return new Response(obj.body as ReadableStream, {
      headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
    })
  })
  app.get('/robots.txt', async c => {
    const obj = await c.env[bindingName].get('robots.txt')
    if (!obj) return c.notFound()
    return new Response(obj.body as ReadableStream, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
    })
  })

  // Static assets (CSS, JS) — immutable cache
  app.get('/pages/*', async c => serveStatic(c, c.env[bindingName], true))
  app.get('/fragments/*', async c => serveStatic(c, c.env[bindingName]))

  // Published assets (content-addressed uploads) — R2-native equivalent
  // of the node asset route (`assets/serve-route.ts`), which the worker
  // can't reuse because that module imports the sharp adapter and node
  // stream interop. Same serving contract (#1330).
  app.get('/assets/*', async c => servePublishedAsset(c, c.env[bindingName]))

  // Page serving with ESI assembly + Cache API
  app.get('*', async c => {
    const request = c.req.raw
    const cache = (caches as unknown as { default: Cache }).default

    const bucket = c.env[bindingName]
    const cacheKey = generationCacheKey(request, await publishGeneration(bucket))
    const cached = await cache.match(cacheKey)
    if (cached) return cached

    const requestPath = new URL(c.req.url).pathname

    const result = await findPage(bucket, requestPath, locales)
    if (!result) {
      const notFound = await findPage(bucket, '/404')
      if (notFound && !archiveResponse(notFound.html)) {
        const { html: raw404 } = parseCacheComment(notFound.html)
        const fragEntries = await fetchFragmentEntries(path => readFragmentHtml(bucket, path), raw404)
        return c.html(assembleEsi(raw404, fragEntries), 404)
      }
      return c.html('<h1>404 — Page not found</h1>', 404)
    }

    const archived = archiveFor(result.html, result.locale, result.params)
    if (archived) {
      c.executionCtx.waitUntil(cache.put(cacheKey, archived.clone()))
      return archived
    }

    const { html: rawHtml, browser, edge } = parseCacheComment(result.html)

    // Read all fragments in parallel (with locale fallback)
    const fragEntries = await fetchFragmentEntries(path => readFragmentHtml(bucket, path), rawHtml)
    const assembled = assembleEsi(rawHtml, fragEntries)

    // Compute ETag
    const encoder = new TextEncoder()
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(assembled))
    const etag = `"${[...new Uint8Array(hashBuffer)]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16)}"`

    if (c.req.header('If-None-Match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } })
    }

    const response = new Response(assembled, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': `public, max-age=${browser}, s-maxage=${edge}`,
        ETag: etag,
      },
    })

    c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()))
    return response
  })

  return app
}

async function serveStatic(c: any, bucket: R2Bucket, checkArchive = false) {
  const path = new URL(c.req.url).pathname.slice(1)
  const obj = await bucket.get(path)
  if (!obj) return c.notFound()

  const ext = path.split('.').pop()
  const contentType = ext === 'css' ? 'text/css' : ext === 'js' ? 'text/javascript' : 'text/html'

  if (checkArchive && ext === 'html') {
    const html = await obj.text()
    const archived = archiveResponse(html)
    if (archived) return archived
    return new Response(html, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  }

  return new Response(obj.body as ReadableStream, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}

// ---------------------------------------------------------------------------
// Published asset serving (#1330)
// ---------------------------------------------------------------------------

/** Where assets live, relative to the bucket root. Mirrors serve-route.ts. */
const ASSETS_ROOT = 'assets'

/**
 * The sharp adapter's policy (`transforms/sharp.ts` IMMUTABLE_CACHE),
 * inlined because importing the adapter here would drag sharp into the
 * worker bundle. Hash-in-path is content-addressed: new bytes, new URL.
 */
const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/**
 * `GET /assets/*` from R2. Mirrors the node route's contract:
 * content-addressed ETag with weak-comparison 304, byte ranges (206) for
 * media seek, adapter cache policy, `nosniff` + disposition, public-path
 * gate so manifests and dot-paths answer 404. R2 reports the full object
 * size on ranged reads, so Content-Range gets exact bounds here.
 */
async function servePublishedAsset(c: any, bucket: R2Bucket) {
  const url = new URL(c.req.url)
  let path: string
  try {
    path = decodeURIComponent(url.pathname.replace(/^\/assets\//, ''))
  } catch {
    return c.text('Invalid asset path', 400)
  }
  if (path.includes('..') || path.startsWith('/')) {
    return c.text('Invalid asset path', 400)
  }

  // Private storage (manifests, dot-paths) answers 404 like a missing
  // file — one rule shared with every other server (#1330).
  if (!isPublicSitePath(path)) {
    return c.text('Not found', 404)
  }

  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const mime = assetMimeForPath(path)
  const urlInput = parseAssetUrlInput(path, ext)
  const etag = urlInput.hash ? `"${urlInput.hash}"` : undefined

  if (etag && ifNoneMatches(c.req.header('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: assetHeaders(mime, etag) })
  }

  const key = `${ASSETS_ROOT}/${path}`
  const range = parseRangeHeader(c.req.header('range'))
  const obj = await bucket.get(
    key,
    range === undefined
      ? undefined
      : range.end === undefined
        ? { range: { offset: range.start } }
        : { range: { offset: range.start, length: range.end - range.start + 1 } },
  )
  if (!obj) return c.text('Not found', 404)

  if (range !== undefined) {
    const total = obj.size
    if (range.start >= total) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } })
    }
    const last = Math.min(range.end ?? total - 1, total - 1)
    const headers = assetHeaders(mime, etag)
    headers.set('Content-Range', `bytes ${range.start}-${last}/${total}`)
    headers.set('Accept-Ranges', 'bytes')
    return new Response(obj.body as ReadableStream, { status: 206, headers })
  }

  const headers = assetHeaders(mime, etag)
  headers.set('Accept-Ranges', 'bytes')
  return new Response(obj.body as ReadableStream, { status: 200, headers })
}

function assetHeaders(mime: string, etag: string | undefined): Headers {
  const headers = new Headers({
    'Content-Type': mime,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': ASSET_CACHE_CONTROL,
    'Content-Disposition': dispositionFor(mime),
    'Access-Control-Allow-Origin': '*',
  })
  if (etag) headers.set('ETag', etag)
  return headers
}

/**
 * Parse a byte-range header. Unbounded ends stay undefined (R2 reads to
 * EOF); suffix ranges (bytes=-N) stay unsupported, same as the node route.
 */
function parseRangeHeader(header: string | undefined): { start: number; end?: number } | undefined {
  const match = header ? /^bytes=(\d+)-(\d+)?$/.exec(header) : null
  if (!match) return undefined
  const start = Number.parseInt(match[1]!, 10)
  const end = match[2] ? Number.parseInt(match[2], 10) : undefined
  if (end !== undefined && end < start) return undefined
  return { start, end }
}
