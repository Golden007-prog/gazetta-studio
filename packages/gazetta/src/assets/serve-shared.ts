/**
 * Sharp-free helpers shared by the node asset route (`assets/serve-route.ts`)
 * and the Cloudflare R2 worker (`workers/cloudflare-r2.ts`). The worker
 * bundles for the V8 isolate and can't pull in the node route's sharp
 * adapter or node stream interop, so the pieces both servers need live
 * here:
 *
 * - the MIME table for the v1 upload allowlist
 * - filename parsing for the content-addressed ETag
 * - `If-None-Match` evaluation (RFC 7232 §3.2 weak comparison)
 * - `Content-Disposition` per the asset rendering contract
 */
import type { AssetUrlInput } from '../transforms/adapter.js'

/**
 * MIME lookup for every extension the upload allowlist can persist
 * (`assets/validate.ts` `ALLOWED_MIMES`, `assets/url.ts` `extFromMime`).
 * Extensions outside the table fall back to `application/octet-stream`,
 * which with `nosniff` + `attachment` disposition is the safe answer for
 * a stored blob we don't recognize.
 */
export const MIME_BY_ASSET_EXT: Record<string, string> = {
  // Images
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  gif: 'image/gif',
  // Audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
}

/** Content-Type for a stored asset path, from its extension. */
export function assetMimeForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_ASSET_EXT[ext] ?? 'application/octet-stream'
}

/**
 * Parse a minimal `AssetUrlInput` from the URL path. Used only for the
 * `cachePolicy()` call and the content-addressed ETag — the route doesn't
 * need to recover full variants/dimensions, just whatever the adapter
 * might key on.
 *
 * Filename shape: `{name}-{hash}[.{loc}][.{theme}][-{w}w].{ext}`. We
 * extract `name` and `hash`; selector/variants/dims default to nulls.
 * Future adapters that need more (e.g. per-locale cache TTL) would
 * expand this parser or we'd thread the resolver-time inputs through
 * a different path.
 */
export function parseAssetUrlInput(path: string, ext: string): AssetUrlInput {
  // Strip extension.
  const stem = path.replace(/\.[^.]+$/, '')
  // Match `{name}-{hash}` where hash is 8 hex chars; everything after
  // the first hash-suffix is selector + width.
  const m = /^(.+)-([0-9a-f]{8})/.exec(stem)
  const name = m ? m[1]! : stem
  const hash = m ? m[2]! : ''
  return {
    name,
    hash,
    ext,
    selector: null,
    variants: [],
    width: null,
    height: null,
  }
}

/**
 * Evaluate `If-None-Match` against the asset's ETag. RFC 7232 §3.2
 * mandates *weak comparison* for `If-None-Match`: a weak validator
 * (`W/"tag"`) matches the strong form (`"tag"`) of the same opaque-tag.
 * Strip the `W/` prefix from both the request token and the ETag before
 * comparing, so a client or proxy sending the weak form still gets the
 * 304. `*` matches any representation — callers check existence first,
 * so it short-circuits to a match.
 */
export function ifNoneMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false
  if (header.trim() === '*') return true
  const want = stripWeakPrefix(etag)
  return header.split(',').some(token => stripWeakPrefix(token.trim()) === want)
}

function stripWeakPrefix(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2) : tag
}

/**
 * `Content-Disposition` per the asset's rendering contract. Embedded
 * kinds (image/video/audio, rendered inline by templates) serve
 * `inline`; everything else serves `attachment` so documents download
 * rather than render in the asset origin. The kind is inferred from the
 * response MIME — reading the manifest's `kind` field is the
 * authoritative upgrade once manifests are consulted at serve time.
 */
export function dispositionFor(mime: string): string {
  return /^(?:image|video|audio)\//.test(mime) ? 'inline' : 'attachment'
}
