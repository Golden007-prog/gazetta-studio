/**
 * HTTP route: `GET /assets/*` — serve asset bytes from a storage provider.
 *
 * Thin adapter. Opens a `readStream` and pipes it to the response with
 * Content-Type, cache, ETag, Content-Disposition, and CORS headers per
 * the design-media.md "Asset serving" contract. Range request support
 * lets `<video>` seek and `<audio>` resume; a matching `If-None-Match`
 * short-circuits to 304 before any bytes are read.
 *
 * Mount this at the top level of the serving app (dev server,
 * `gazetta serve`), NOT under `/admin` — the resolver emits root-relative
 * `/assets/...` URLs that must match this route. The Cloudflare worker
 * can't mount this module (sharp adapter, node streams), so it keeps an
 * R2-native equivalent of this handler in `workers/cloudflare-r2.ts`;
 * shared logic lives in `assets/serve-shared.ts`.
 *
 * The factory takes a **storage resolver** + an optional **adapter
 * resolver**. Storage gives us the bytes; adapter gives us the cache
 * policy. Without an adapter resolver, the route falls back to the
 * sharp adapter's policy (immutable, the v1 default) — that keeps
 * dev/test flows that don't wire transform config working unchanged.
 *
 * Security:
 * - Rejects paths containing `..` (belt-and-suspenders)
 * - Only public site paths are served (`isPublicSitePath`): `*.asset.json`
 *   manifests, dot-paths, and other private storage answer 404 like a
 *   missing file, same as static `gazetta serve` (#1330)
 * - Cache headers come from `adapter.cachePolicy()` — whatever the
 *   adapter says is right for the URLs it produces. Default
 *   (sharp adapter) returns `immutable` because hash-in-path is
 *   content-addressed: new bytes mean a new URL.
 * - `X-Content-Type-Options: nosniff` + `Content-Disposition`
 *   (`attachment` for non-embedded kinds) keep document uploads from
 *   rendering inline in the asset origin.
 * - `Access-Control-Allow-Origin: *` — assets are public in v1.
 */
import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import type { StorageProvider } from '../types.js'
import type { TransformAdapter } from '../transforms/adapter.js'
import { defaultSharpAdapter } from '../transforms/sharp.js'
import { isPublicSitePath } from '../public-site-path.js'
import { assetMimeForPath, dispositionFor, ifNoneMatches, parseAssetUrlInput } from './serve-shared.js'

/** Where assets live, relative to the target storage root. */
const ASSETS_ROOT = 'assets'

/**
 * Decoded control characters (NUL through unit separator, DEL) make the
 * path unrepresentable or ambiguous for storage backends - the fs
 * provider throws `ERR_INVALID_ARG_VALUE` on NUL, for one - so they are
 * rejected at the edge with 400, next to the `..` check.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/**
 * Resolve the storage provider to serve from, given an optional target
 * query param. Narrower than the admin-api SourceContextResolver — this
 * route only needs storage, not the rest of the source context.
 */
export type AssetStorageResolver = (targetName: string | undefined) => Promise<StorageProvider>

/**
 * Resolve the transform adapter for the active target. Per-target
 * because adapter config (and thus cache policy) is per-target.
 * Optional — when absent, the route uses the sharp adapter's policy.
 */
type AssetAdapterResolver = (targetName: string | undefined) => Promise<TransformAdapter>

export interface AssetServeRoutesOptions {
  resolveStorage: AssetStorageResolver
  resolveAdapter?: AssetAdapterResolver
}

export function assetServeRoutes(resolveStorageOrOptions: AssetStorageResolver | AssetServeRoutesOptions): Hono {
  // Accept either the legacy `resolveStorage` callable or an options
  // object. The callable form keeps the pre-step-18 signature working
  // for callers that haven't migrated.
  const opts: AssetServeRoutesOptions =
    typeof resolveStorageOrOptions === 'function'
      ? { resolveStorage: resolveStorageOrOptions }
      : resolveStorageOrOptions

  const app = new Hono()

  app.get('/assets/*', async c => {
    const url = new URL(c.req.url)
    let path: string
    try {
      path = decodeURIComponent(url.pathname.replace(/^\/assets\//, ''))
    } catch {
      return c.text('Invalid asset path', 400)
    }

    if (CONTROL_CHARS.test(path) || path.includes('..') || path.startsWith('/')) {
      return c.text('Invalid asset path', 400)
    }

    // Private storage (manifests, dot-paths) answers 404 like a missing
    // file — one rule shared with static `gazetta serve` (#1330).
    if (!isPublicSitePath(path)) {
      return c.text('Not found', 404)
    }

    const targetName = c.req.query('target')
    const storage = await opts.resolveStorage(targetName)
    const storagePath = `${ASSETS_ROOT}/${path}`
    if (!(await storage.exists(storagePath))) {
      return c.text('Not found', 404)
    }

    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    const mime = assetMimeForPath(path)

    const range = parseRange(c.req.header('range'))

    // Cache policy from the adapter. The route only has the URL path,
    // so it constructs a minimal AssetUrlInput — name/hash/ext parsed
    // from the filename. Today's adapters return constant policies
    // regardless of input; future per-input policy adapters will have
    // what they need.
    const adapter = opts.resolveAdapter ? await opts.resolveAdapter(targetName) : defaultSharpAdapter
    const urlInput = parseAssetUrlInput(path, ext)
    const policy = adapter.cachePolicy(urlInput)

    // Content-addressed ETag: the 8-hex hash in the filename IS the
    // validator. A filename without a hash suffix yields no ETag and
    // no conditional handling (rather than an empty-quoted-string tag).
    const etag = urlInput.hash ? `"${urlInput.hash}"` : undefined

    if (etag && ifNoneMatches(c.req.header('if-none-match'), etag)) {
      c.header('ETag', etag)
      c.header('Cache-Control', policy.cacheControl)
      if (policy.vary) c.header('Vary', policy.vary)
      return c.body(null, 304)
    }

    // Range requests need exact Content-Range bounds, and the storage
    // interface exposes no stat() — so they read the object (size-capped
    // at upload, DEFAULT_ASSET_MAX_BYTES) and slice. Full requests keep
    // the streaming path.
    if (range) {
      let bytes: Uint8Array
      try {
        bytes = await storage.readBytes(storagePath)
      } catch {
        return c.text('Not found', 404) // deleted between exists and read
      }
      const size = bytes.length
      if (range.start >= size) {
        c.header('Content-Range', `bytes */${size}`)
        return c.text('Range not satisfiable', 416)
      }
      const last = Math.min(range.end ?? size - 1, size - 1)
      c.header('Content-Type', mime)
      c.header('X-Content-Type-Options', 'nosniff')
      c.header('Cache-Control', policy.cacheControl)
      if (policy.vary) c.header('Vary', policy.vary)
      if (etag) c.header('ETag', etag)
      c.header('Content-Disposition', dispositionFor(mime))
      c.header('Access-Control-Allow-Origin', '*')
      c.header('Accept-Ranges', 'bytes')
      c.header('Content-Range', `bytes ${range.start}-${last}/${size}`)
      // Copy the range into its own buffer: a Node Buffer's slice()
      // shares memory, so its .buffer is the whole file or a pooled block.
      const body = new Uint8Array(last + 1 - range.start)
      body.set(bytes.subarray(range.start, last + 1))
      return c.body(body.buffer, 206)
    }

    try {
      const bodyStream = await storage.readStream(storagePath)
      c.header('Content-Type', mime)
      c.header('X-Content-Type-Options', 'nosniff')
      c.header('Cache-Control', policy.cacheControl)
      if (policy.vary) c.header('Vary', policy.vary)
      if (etag) c.header('ETag', etag)
      c.header('Content-Disposition', dispositionFor(mime))
      c.header('Access-Control-Allow-Origin', '*')
      c.header('Accept-Ranges', 'bytes')
      return stream(c, async out => {
        await out.pipe(bodyStream)
      })
    } catch {
      return c.text('Error reading asset', 500)
    }
  })

  return app
}

/**
 * Parse a byte-range HTTP header. An omitted end stays undefined (read
 * to the object end, bounded by the caller once the size is known).
 * Suffix ranges (bytes=-N) stay unsupported, and a backwards range
 * (bytes=5-3) is ignored like any grammar the route doesn't serve.
 */
function parseRange(header: string | undefined): { start: number; end?: number } | undefined {
  if (!header) return undefined
  const match = /^bytes=(\d+)-(\d+)?$/.exec(header)
  if (!match) return undefined
  const start = Number.parseInt(match[1], 10)
  const end = match[2] ? Number.parseInt(match[2], 10) : undefined
  if (end !== undefined && end < start) return undefined
  return { start, end }
}
