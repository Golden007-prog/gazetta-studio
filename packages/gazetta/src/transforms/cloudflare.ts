/**
 * Cloudflare Images transform adapter.
 *
 * Routes URLs through Cloudflare's `/cdn-cgi/image/` endpoint at the
 * configured zone. Cloudflare fetches the origin URL (the asset bytes
 * served from the target's storage), applies the requested transforms
 * (resize, format conversion, quality), and returns the transformed
 * bytes to the browser.
 *
 * URL shape:
 *   https://{zone}/cdn-cgi/image/{params}/{originUrl}
 *
 * Where params is a comma-separated list (e.g. `format=auto,width=800`).
 * For the primary URL we use `format=auto` only — Cloudflare picks the
 * best supported format (AVIF, WebP, JPEG) per the browser's Accept
 * header. For srcset entries we add `width={W}` per ladder rung.
 *
 * # Why a fixed ladder
 *
 * Sharp generates 400/800/1200/1600 widths at upload. Cloudflare can
 * generate any width on the fly, but srcset still needs a concrete
 * ladder for the browser to pick from. We use the same widths as the
 * sharp adapter — consistent visual delivery between targets that
 * happen to use different adapters.
 *
 * # Why `Vary: Accept`
 *
 * `format=auto` returns AVIF or WebP per browser support. Caches MUST
 * vary on `Accept` to avoid serving an AVIF response to a WebP-only
 * browser. The cache policy carries that header.
 *
 * # What this adapter ignores
 *
 * `input.variants` — Cloudflare generates widths on demand; the
 * pre-generated ladder is irrelevant. Sites that use Cloudflare can
 * still upload variants (they cost nothing on egress, just a tiny bit
 * of storage), but the URLs the browser receives won't reference them.
 */
import { buildAssetUrl } from '../assets/url.js'
import type { AssetUrlInput, CachePolicy, TransformAdapter } from './adapter.js'
import { trimTrailingSlashes } from '../url.js'

/** Widths the srcset ladder generates. Same as sharp's `VARIANT_WIDTHS`. */
const LADDER_WIDTHS: readonly number[] = [400, 800, 1200, 1600]

const CDN_CACHE_POLICY: CachePolicy = {
  cacheControl: 'public, max-age=31536000, immutable',
  // Cloudflare's `format=auto` returns different bytes per Accept header;
  // caches must vary or they'll serve AVIF to WebP-only clients.
  vary: 'Accept',
}

export interface CloudflareAdapterOptions {
  /**
   * The zone (hostname) where `/cdn-cgi/image/` is served. Typically
   * the same hostname as `siteUrl`. Required — without it we can't
   * compose a CDN URL.
   */
  zone: string
}

/**
 * Build a Cloudflare-Images-flavored TransformAdapter for the given zone.
 * Factory function (not a singleton) because the zone is per-target —
 * sites with multiple Cloudflare zones get one adapter instance per
 * configured target.
 */
export function createCloudflareAdapter(opts: CloudflareAdapterOptions): TransformAdapter {
  if (!opts.zone || typeof opts.zone !== 'string') {
    throw new Error('cloudflareAdapter requires a `zone` (e.g. "cdn.example.com")')
  }
  const zone = trimTrailingSlashes(opts.zone.replace(/^https?:\/\//, ''))

  return {
    name: 'cloudflare',

    primaryUrl(input: AssetUrlInput): string {
      const origin = absoluteOriginUrl(input)
      // Primary URL uses format=auto only — no width; the browser gets
      // the source-resolution version (within Cloudflare's max).
      return `https://${zone}/cdn-cgi/image/format=auto/${origin}`
    },

    srcset(input: AssetUrlInput): string | null {
      // No srcset for non-images — same skip rule as sharp adapter.
      // We detect by extension; future kinds can refine this.
      if (!isImageExt(input.ext)) return null
      // Skip widths larger than the source image (no point upscaling).
      const sourceWidth = input.width ?? Infinity
      const widths = LADDER_WIDTHS.filter(w => w <= sourceWidth)
      if (widths.length === 0) return null
      const origin = absoluteOriginUrl(input)
      return widths.map(w => `https://${zone}/cdn-cgi/image/format=auto,width=${w}/${origin} ${w}w`).join(', ')
    },

    cachePolicy(_input: AssetUrlInput): CachePolicy {
      return CDN_CACHE_POLICY
    },
  }
}

/**
 * Compose the absolute origin URL for the asset bytes — the URL
 * Cloudflare fetches from. Always absolute because Cloudflare's
 * `/cdn-cgi/image/` endpoint requires it. When `siteUrl` isn't set
 * the adapter can't function — origin URLs need to be reachable
 * from Cloudflare's edge.
 */
function absoluteOriginUrl(input: AssetUrlInput): string {
  if (!input.siteUrl) {
    throw new Error(
      `cloudflareAdapter requires siteUrl on the resolve context — Cloudflare needs an absolute origin URL to fetch.`,
    )
  }
  // Use buildAssetUrl for path composition (handles selector suffix);
  // it returns the full URL when siteUrl is set.
  return buildAssetUrl({
    name: input.name,
    hash: input.hash,
    ext: input.ext,
    siteUrl: input.siteUrl,
    selector: input.selector,
  })
}

/** Whether the extension is one Cloudflare can transform. */
function isImageExt(ext: string): boolean {
  return ext === 'jpg' || ext === 'jpeg' || ext === 'png' || ext === 'webp' || ext === 'avif' || ext === 'gif'
}
