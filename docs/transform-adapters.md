# Transform Adapters

How Gazetta delivers asset images to browsers — what the default does,
when to switch to a CDN-side resizer, and how to plug in your own.

For the design model and `TransformAdapter` interface contract, see
[`.claude/rules/design-media.md`](../.claude/rules/design-media.md) →
"Transform adapters."

## What an adapter does

Every target has a transform adapter. The adapter owns three coupled
concerns:

| Concern | Question it answers |
|---|---|
| **URL composition** | What URL points to this asset's bytes? |
| **`srcset` semantics** | Which widths are available, and how do clients pick? |
| **Cache policy** | What `Cache-Control` (and optional `Vary`) header should the asset-serve route emit? |

Co-locating these on one interface means future adapters with non-trivial
delivery (signed URLs, format negotiation, server-side proxying) plug in
without spreading knowledge across the codebase.

## Shipped adapters

| Adapter | Primary URL | `srcset` | Cache policy | Use when |
|---|---|---|---|---|
| **`sharp` (default)** | `/assets/hero-{hash}.jpg` (origin) | Pre-generated ladder from manifest variants | `public, max-age=31536000, immutable` | You're the image origin; sharp ran at upload to generate variants |
| **`cloudflare`** | `https://{zone}/cdn-cgi/image/format=auto/{originUrl}` | On-the-fly width variants via `width=N` param | `public, max-age=31536000, immutable` + `Vary: Accept` | Cloudflare in front of your origin and you want format-auto (AVIF/WebP/JPEG per browser) without storing 3× the bytes |

### Default behavior: `sharp`

If a target's `site.config.ts` doesn't declare `transforms`, the `sharp`
adapter is used. Origin URLs, content-addressed by hash. Variants
generated at upload time and stored as separate files
(`hero-{hash}-400w.jpg`, `-800w.jpg`, etc.) — the browser picks via
`srcset`.

```ts
// site.config.ts
import { defineSite, r2Storage } from 'gazetta'

export default defineSite({
  targets: {
    production: {
      storage: r2Storage({ bucket: 'site-prod' }),
      siteUrl: 'https://cdn.example.com',
      // transforms: not declared → sharp adapter is used
    },
  },
})
```

### Switching to `cloudflare`

Cloudflare's image-resizing service generates variants on demand at
the edge. Origin stores one byte set; the CDN serves
format-negotiated, width-resized derivatives.

```ts
// site.config.ts
import { defineSite, r2Storage, cloudflareAdapter } from 'gazetta'

export default defineSite({
  targets: {
    production: {
      storage: r2Storage({ bucket: 'site-prod' }),
      siteUrl: 'https://cdn.example.com',
      transforms: cloudflareAdapter({
        zone: 'cdn.example.com',
      }),
    },
  },
})
```

URLs become:

```
# Default
https://cdn.example.com/cdn-cgi/image/format=auto/assets/hero-a3b2c1d4.jpg

# srcset entries
https://cdn.example.com/cdn-cgi/image/format=auto,width=400/assets/hero-a3b2c1d4.jpg 400w
https://cdn.example.com/cdn-cgi/image/format=auto,width=800/assets/hero-a3b2c1d4.jpg 800w
...
```

The `Vary: Accept` header is added because `format=auto` returns
different bytes per browser; CDNs need to vary their cache key on
the request's `Accept` header.

## Trade-offs

| Property | `sharp` | `cloudflare` |
|---|---|---|
| Storage cost | 5× per image (1 default + 4 variants × widths) | 1× per image |
| Egress | Origin per request | Cloudflare's edge caches everything |
| Format auto-negotiation | No (fixed at upload) | Yes (AVIF/WebP/JPEG per Accept) |
| Per-request cost | Free (origin reads) | Cloudflare Image Resizing pricing |
| Works without Cloudflare | Yes | No |
| Predictable URLs | Yes | Yes (URL shape is documented) |
| Origin bandwidth | Browsers fetch from origin (or origin CDN) | Browsers fetch from Cloudflare; origin reads only on cache miss |

**Use sharp when:**
- You're not on Cloudflare
- Storage is cheap (Cloudflare R2, S3 with reserved capacity, etc.)
- You don't need automatic format negotiation
- Your traffic is small enough that egress costs aren't a concern

**Use cloudflare when:**
- You're on Cloudflare anyway
- You want automatic AVIF/WebP/JPEG selection
- You don't want to store the variant ladder
- You're willing to pay Cloudflare's image-resizing per-request pricing

## When variants are skipped

Both adapters skip the variant ladder for:

- **Vector formats (SVG)** — they scale on the browser; a width ladder
  is meaningless. `srcset` is `null`.
- **Animated images** (GIF, animated WebP/AVIF) — the variant
  generator doesn't preserve animation. `srcset` is `null`; templates
  render the original bytes.
- **Images smaller than the smallest target width** — sharp's variants
  array would be empty. `srcset` is `null`.

## Future adapters

The `TransformAdapter` interface is designed for additive growth.
Three are tracked for future ship:

| Adapter | When | Status |
|---|---|---|
| **`imgproxy`** | Self-hosted users wanting on-the-fly resize without Cloudflare | v1.5 — validates HMAC-signed URL contract |
| **`cloudinary`** | Cloudinary customers | Community-contributed |
| **`imgix`** | Imgix customers | Community-contributed |

### Writing your own adapter

The interface is in
[`packages/gazetta/src/transforms/adapter.ts`](../packages/gazetta/src/transforms/adapter.ts):

```ts
interface TransformAdapter {
  readonly name: string
  primaryUrl(input: AssetUrlInput): string
  srcset(input: AssetUrlInput): string | null
  cachePolicy(input: AssetUrlInput): CachePolicy
  mountRoutes?(app: Hono): void
}
```

`AssetUrlInput` carries everything URL/cache decisions need:

```ts
interface AssetUrlInput {
  name: string
  hash: string
  ext: string
  selector: Selector | null      // locale + theme override identifier
  siteUrl?: string
  variants: readonly AssetVariant[]
  width: number | null
  height: number | null
}
```

`mountRoutes` is for adapters that need server-side mediation —
imgproxy's HMAC-signed URLs are generated by a route the adapter
mounts, for example. Most adapters won't need it.

Implementations are user-facing factory calls — operators import the factory from `gazetta` (or from a plugin package) and assign the returned `TransformAdapter` instance directly to `target.transforms`. The internal builder simply trusts whatever instance was assigned (it's already constructed at config-eval time):

```ts
// Operator-facing usage
import { sharpAdapter, cloudflareAdapter } from 'gazetta'
// import { imgproxyAdapter } from '@example/imgproxy-adapter'  // future / plugin

targets: {
  production: {
    transforms: cloudflareAdapter({ zone: 'cdn.example.com' }),
    // or transforms: sharpAdapter() to use the default explicitly
  },
}
```

## Per-target choice, not site-wide

Adapters are per target. You can run `local` and `staging` with
sharp, `production` with cloudflare:

```ts
import { filesystemStorage, r2Storage, cloudflareAdapter } from 'gazetta'

targets: {
  local: {
    storage: filesystemStorage(),
    editable: true,
    // sharp default
  },

  staging: {
    storage: r2Storage({ bucket: 'site-staging' }),
    // sharp default
  },

  production: {
    storage: r2Storage({ bucket: 'site-prod' }),
    siteUrl: 'https://example.com',
    transforms: cloudflareAdapter({ zone: 'example.com' }),
  },
}
```

The publish pipeline doesn't care — it pushes the same bytes to all
targets. The asset-serve route reads `cachePolicy` from the active
target's adapter, so each target gets the right cache headers.

## Cache invalidation

Hash-in-path means URLs change whenever bytes change — `hero-a3b2c1d4.jpg`
is a different URL from `hero-d5e6f7a8.jpg`. Cache invalidation is
automatic: replace bytes → new hash → new URL → new cache entry.
Browsers and CDNs that have the old URL cached will keep serving it
(harmless — those URLs still resolve to valid bytes during the
retention window) until the new hash propagates through your content.

No cache purging. No query strings. No `?v=2` tricks.

## Common questions

### Why not just use Cloudflare Pages / Vercel Image / Astro Image?

Those are framework- or host-specific. Gazetta runs on any WinterTC
host (Workers, Deno, Bun, Node) and any storage provider. The
adapter interface lets you mix-and-match: filesystem storage in
dev + Cloudflare delivery in prod, or S3 + imgproxy + a custom CDN.

### What about `format=auto` breaking my CSP?

The cloudflare adapter sets `Vary: Accept`. Browsers handle
content-negotiation per Accept; CSP doesn't care about response body
shape. If your CSP restricts `img-src`, the adapter's URL host (the
zone you configured) needs to be in the allowlist — but that's the
host part, which doesn't change per-request.

### How do I migrate from sharp to cloudflare without re-uploading?

You don't. The bytes on origin are the same — the adapter swap just
changes how URLs are constructed. Existing pages reference assets by
name (not URL), so they'll regenerate the right URLs at next render.
Cache invalidation propagates as old URLs expire and new URLs are
fetched.

### How do I switch back to sharp?

Remove the `transforms` block from `site.config.ts`, redeploy. The
`sharp` adapter is the default and uses the variants that were
generated at upload time. If those variants were never generated
(you only ran on cloudflare), run `gazetta assets reindex
--generate-variants` to backfill.

## See also

- [`.claude/rules/design-media.md`](../.claude/rules/design-media.md) — full design model
- [template-assets.md](template-assets.md) — for template developers
- [content-assets.md](content-assets.md) — for content authors
- [migration.md](migration.md) — migrating from string URLs
