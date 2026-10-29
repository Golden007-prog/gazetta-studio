# Media (Assets)

How the CMS handles media — images, videos, audio, documents, and fonts — as first-class content primitives. Designed for the stateless, multi-target, edge-delivered model.

**This doc covers the design:** scope, data model, storage, integrity, template contract, security, admin UX, publish/history, operations, and distinctive choices.

**Companion docs:**
- [design-media-reference.md](design-media-reference.md) — fact-checked tooling specifics, library versions, licensing, codebase-alignment notes. Consulted during implementation.
- [design-media-implementation.md](design-media-implementation.md) — v1 scope, phased alternative, out-of-v1, adjacent v1.5/v2 capabilities, frontier opportunities, open implementation questions, migration path.

## Scope

**In v1:**
- Internal assets (bytes on target) — images, video, audio, documents
- Flat library with tag-based organization (no folders)
- Hash-in-path URLs for cache invalidation
- Variant (srcset) generation for images at upload time (sharp)
- TransformAdapter interface with `sharp` (default, origin bytes + pre-generated ladder) and `cloudflare` (`/cdn-cgi/image/` URLs with on-the-fly transforms) adapters
- Per-target upload size cap via `assets.maxBytes` config (default 50 MB)
- Replace-and-delete as a flow; delete blocked when refs > 0
- Rename rewrites all references (across all locale variants)
- Usage panel (reverse-dep lookup; shows locale coverage per referencing page)
- Publish carries transitive asset dependencies
- i18n — locale-suffix asset manifests (`hero.asset.fr.json`) with fallback chain, active-locale editing in library, resolution-chain UX in picker, and optional per-locale byte overrides (`hero-{hash}.fr.jpg`) for text-in-image or region-specific assets
- Theme dimension (`light` / `dark` / etc.) as a peer override axis to locale — assets carry per-theme byte overrides; resolver picks per render context. v1 ships theme on **assets only**; page/fragment theme variants and runtime SSR theme branching are deferred (templates emit theme-aware CSS via PrimeVue tokens / class-based cascade — see css-theming.md). Cross-dimension fallback is **locale-priority**: `(fr, dark) → (fr, light) → (default-locale, dark) → (default-locale, light)`. Documented as a non-configurable contract — language matters more than visual presentation when content has to fall back.
- **Three asset kinds: embedded, downloadable, font.** Fonts are first-class because typography is locale-dimensioned (Arabic needs different glyphs than Latin, CJK needs different fonts entirely) and the `@font-face` with `unicode-range` pattern needs first-class resolver support for multi-script rendering

**Reserved in v1 (model supports, UI does not expose):**
- External-direct (URL stored, partner serves bytes) — manifest schema currently hardcodes `source: 'internal'`; widening to `'internal' | 'external-direct'` is a future-additive change. Punted because no UI surface ships it and no concrete user demand has surfaced.
- External-proxy (Worker proxies + caches partner bytes on our domain)

**Out of v1 (explicit):**
- Folders UI (tag-based org only)
- Hotspot rectangle (focal point only)
- LQIP / blurhash placeholders
- URL-param transforms beyond fixed variants
- Signed / private assets
- OEmbed auto-fetch
- Pin (convert external to internal)
- Cross-asset byte deduplication
- Resumable uploads
- Video transcoding / quality variants
- Concurrent-edit safety (same class as pages)
- `gazetta gc` (unreachable-blob reclamation)

## Model

### Entity

One `Asset` entity. Two axes of variation:

| | Embedded (rendered inline) | Downloadable (linked for download) |
|---|---|---|
| **Internal** (bytes on target) | Images, video, audio uploaded to the CMS | PDFs, docs, zips uploaded to the CMS |
| **External-direct** (URL, partner serves) | Hotlinked images, iframe embeds, CDN URLs | Link to partner-hosted files |
| **External-proxy** (reserved) | Future: Worker caches partner bytes | Future: Worker caches partner files |

`kind` discriminates three rendering contracts: **embedded** (`<img>`/`<video>`/`<audio>` — URL-in-element), **downloadable** (`<a href download>` — linked file), and **font** (`@font-face` — CSS declaration, used by name). `source` discriminates internal vs external variants. Both are set at upload time; `kind` is inferred from MIME and overridable for ambiguous cases (e.g., SVG could theoretically be either). `source` is inferred from the upload flow (file upload → internal, URL paste → external-direct).

### Reference shape (stored in page/fragment content)

```ts
// Embedded (rendered inline by templates)
type EmbeddedAssetRef = {
  _asset: string                       // asset name (path-like)
  alt?: string                         // overrides asset default
  focalPoint?: { x: number; y: number } // 0–1 normalized; image only
}

// Downloadable (linked for download)
type DownloadableAssetRef = {
  _asset: string
  title?: string        // overrides asset default title
  description?: string  // optional blurb near the link
}

// Font (loaded via @font-face, used by CSS name)
type FontAssetRef = {
  _asset: string        // asset name
}
```

Reserved keys: `_asset` (for named internal or external assets via the library). The `_` prefix is reserved for Gazetta-interpreted fields — templates must not define their own `_`-prefixed content keys.

### Resolved shape (templates receive this after the resolver runs)

```ts
type ResolvedEmbeddedAsset = {
  url: string                 // absolute or root-relative
  srcset: string | null       // null for external, SVG, animated
  width: number | null
  height: number | null
  duration: number | null     // video/audio/animated-image
  animated: boolean           // true for GIF/APNG/animated-WebP/animated-AVIF
  poster: string | null       // first-frame URL for animated; null for static
  alt: string                 // always a string; '' = decorative
  focalPoint: { x: number; y: number } | null
  mime: string
}

type ResolvedDownloadableAsset = {
  url: string
  title: string
  description: string | null
  size: number | null
  mime: string
}

type ResolvedFontAsset = {
  cssName: string             // Gazetta-stable font-family name to use in CSS (NOT the font file's intrinsic family)
  variants: Array<{
    url: string               // WOFF2/TTF URL
    format: 'woff2' | 'woff' | 'ttf' | 'otf'
    weight: number | 'variable'
    style: 'normal' | 'italic'
    unicodeRange: string | null // per-variant unicode-range for multi-script fallback
    mime: string
  }>
}
```

Templates always receive the full shape, with `null` for missing values. No missing keys.

### Alt text: three-state model

| State | Meaning | Rendered |
|---|---|---|
| `alt: "text"` | Meaningful description | `alt="text"` |
| `alt: ""` | Intentionally decorative | `alt=""` (skipped by screen readers) |
| `alt: null` | Missing / not set | Admin warns; resolver falls back to `''` |

**Alt is contextual to usage, not to the asset.** WCAG treats alt as a property
of how an image is used, not what it depicts. The same logo needs alt as a
hero, doesn't need alt in a footer where a sibling text label describes the
brand. Gazetta's data model honors this by making alt overridable at the
reference layer (per-ref override on the page) on top of the asset's
default. Authors see the chain — per-ref → asset → null — explicitly in
the picker's reference-options step.

**Where alt enforcement lives.** Alt is collected and surfaced at multiple
layers, each optimized for what it can know:

| Layer | What it does | Why |
|---|---|---|
| **Asset upload (inline in upload-list rows)** | Optional alt input + "Decorative" checkbox per image upload, non-blocking | Bulk-friendly; no modal overhead per file |
| **Library card badge** | Shows a "no alt" pill on cards where `alt === null` AND the asset is an image | Retroactive nag — catches existing assets that lack alt; persistent across sessions |
| **Asset detail pane** | Inline editable alt field with three-state radio (text / decorative / not set) | Author can resolve at their pace; the badge points here |
| **Picker reference-options step** | Alt override field with the resolution chain shown ("Falls back to: …") | Use-time decision; alt-for-this-context vs. alt-for-the-asset are explicit |
| **Save-time enforcement (`altRequired: true`)** | *(v1.5 — schema producer side ready, consumer deferred)* Page/fragment save would return 409 when a referenced asset's resolved alt is `null` AND the schema field is declared `altRequired` | The template author knows whether alt is needed; the editor enforces. Deferred because cross-cutting schema introspection at save time isn't yet wired through the page-save pipeline |

**No upload-time modal.** Earlier drafts of this doc specified a modal-per-file
prompt. That was wrong: modal-per-file is hostile to bulk uploads (5 files,
5 modals), stacks badly with the locale-bytes upload prompt, and forces a
decision the author may not yet have made (alt depends on use, not file).
Every surveyed CMS (Sanity, Contentful, Strapi, Storyblok, Payload, Directus)
defers alt to "fill it later" via the asset detail pane. Gazetta does the
same at the asset layer + adds save-time template-driven enforcement —
distinctive without the modal-fatigue cost.

The upload-list inline UI exists so authors who *do* know the alt at upload
time can enter it without leaving the queue surface. Skipping is fine; the
library card badge surfaces the unset state until the author resolves it.

### Override dimensions: locale and theme

Assets can vary along two peer dimensions: **locale** (content-level — language-specific bytes or metadata) and **theme** (presentation-level — typically light/dark). Both are first-class. An asset can opt into either, both, or neither.

```ts
// site.config.ts — opt into theme dimension
export default defineSite({
  themes: {
    supported: ['light', 'dark'],
    default: 'light',
  },
})
```

When `themes` is absent, the theme dimension is unused — assets are theme-agnostic. When present, assets can carry per-theme byte overrides keyed under the same selector model as locale.

| Selector | Filename | Resolved at |
|---|---|---|
| _(none)_ | `hero.asset.json` + `hero-{hash}.jpg` | always read; the floor |
| `{ locale: 'fr' }` | `hero.asset.fr.json` + `hero-{hash}.fr.jpg` | active locale = fr |
| `{ theme: 'dark' }` | `hero.asset.dark.json` + `hero-{hash}.dark.jpg` | active theme = dark |
| `{ locale: 'fr', theme: 'dark' }` | `hero.asset.fr.dark.json` + `hero-{hash}.fr.dark.jpg` | both active |

**Filename composition order is locked**: locale before theme. Adding a future dimension extends `DIMENSION_ORDER` (`schema/dimensions.ts`); existing filenames stay valid because they have no value for the new dimension.

**Theme name validation**: theme names must be lowercase ASCII, must NOT collide with valid BCP 47 locale codes (so `hero.asset.en.json` is unambiguously a locale variant, never a theme variant). The site config validator enforces.

**Cross-dimension fallback chain — locale-priority**: when active is `(fr, dark)` and the site default is `(en, light)`, the resolver tries:

1. `(fr, dark)` — most specific
2. `(fr, light)` — locale match, default theme
3. `(default-locale, dark)` — theme only
4. `(default-locale, default-theme)` — the base manifest, always read separately

Locale wins over theme because language matters more than visual presentation when content has to fall back. Locked as a non-configurable contract.

**v1 scope of theme**: assets only. Pages/fragments don't yet have theme variants — templates emit theme-aware CSS via PrimeVue tokens / class-based cascade (see `css-theming.md`); the runtime doesn't yet route a theme value into render context. The asset resolver accepts `theme` in its context so step 18+ runtime work (cookie / `prefers-color-scheme`) can pass it without resolver changes.

**Why a closed dimension set (not user-defined)**: 90% of value is locale + theme. Arbitrary dimensions complicate the picker UI ("which dimensions for this asset?"), the fallback chain semantics, and the storage scheme. Deferred until concrete demand.

## Storage

### Layout

```
<target root>/
  site.config.ts
  pages/
  fragments/
  templates/
  assets/
    hero-a3b2c1d4.jpg              # default bytes
    hero-a3b2c1d4-400w.jpg         # default-bytes variants
    hero-a3b2c1d4-800w.jpg
    hero-d5e6f7a8.fr.jpg           # French bytes override (optional)
    hero-d5e6f7a8.fr-400w.jpg      # French-bytes variants
    hero-d5e6f7a8.fr-800w.jpg
    hero.asset.json                # default manifest (required)
    hero.asset.fr.json             # French metadata + hash → has own bytes
    hero.asset.ar.json             # Arabic metadata only → uses default bytes
    products/                      # optional path-style naming (no UI in v1)
      shot-d5e6f7a8.jpg
      shot.asset.json
    .refs/                         # reverse-dep index (derived)
      hero.json
      products--shot.json
  .gazetta/
    history/...
```

**Paths:**
- Default asset bytes: `{name}-{hash8}.{ext}` (hash is 8-char sha256 prefix of bytes)
- Default variants: `{name}-{hash8}-{width}w.{ext}`
- Locale-specific asset bytes: `{name}-{hash8}.{locale}.{ext}` (optional per locale; hash is that locale's own bytes)
- Locale-specific variants: `{name}-{hash8}.{locale}-{width}w.{ext}`
- Default asset manifest: `{name}.asset.json` (required)
- Locale asset manifest: `{name}.asset.{locale}.json` (optional per locale)
- Asset refs: `.refs/{name-with-slashes-replaced}.json`

**Name rules:**
- ASCII lowercase, digits, hyphens, underscores, dots for extensions
- Path separator `/` allowed (model only; v1 UI is flat)
- Max 200 chars per segment, 10 segments deep, 500 chars total. (Underlying filesystem limits vary: ext4/APFS 255 bytes; NTFS 255 UTF-16 code units; our 200-segment cap leaves headroom for extensions and query params.)
- Reserved names (rejected at upload): paths starting `.`, paths starting `.gazetta/`, names ending `.asset.json` or `.asset.{locale}.json`, names ending `.json` inside `.refs/`. Asset names themselves must not contain a `.{locale}.` infix where `{locale}` matches a BCP-47 locale code supported by the site — this pattern is reserved for locale-bytes filenames (`hero-{hash}.fr.jpg`). Authors trying to upload `hero.fr.jpg` as an asset name are rejected with a clear message.
- Unicode filenames: slugified to ASCII by default; "keep original" is an advanced opt-in. Homoglyph attacks (Cyrillic 'а' vs Latin 'a') are not neutralized by NFC normalization alone — proper defense requires UTS #39 mixed-script detection, which is out of v1 scope. Slugify-to-ASCII default sidesteps this class entirely.

### Manifest

```json
{
  "version": 1,
  "name": "hero",
  "kind": "embedded",
  "source": "internal",
  "mime": "image/jpeg",
  "size": 245678,
  "hash": "a3b2c1d4",
  "width": 1920,
  "height": 1080,
  "duration": null,
  "alt": "Mountain sunset at dusk",
  "focalPoint": { "x": 0.5, "y": 0.35 },
  "tags": ["nature", "landscape"],
  "variants": [
    { "width": 400, "path": "hero-a3b2c1d4-400w.jpg", "size": 24567 },
    { "width": 800, "path": "hero-a3b2c1d4-800w.jpg", "size": 68234 }
  ],
  "variantsStatus": "complete",
  "uploadedAt": "2026-04-19T14:23:05Z",
  "uploadedBy": ""
}
```

`variantsStatus: 'generating' | 'complete' | 'failed'`. Resolver returns `srcset: null` while `generating` or `failed`.

External-direct manifest omits `hash`, `size`, `variants`, `variantsStatus`; adds `url` and optional `provider`.

**Locale variants** (`{name}.asset.{locale}.json`) have the same fields as the default manifest but every field except `version` and `name` is optional. Presence of a field overrides the default; absence falls back. `hash` is the key discriminator: when a locale variant includes `hash`, the locale has its own bytes at `{name}-{hash}.{locale}.{ext}` with its own `width`/`height`/`variants`/`variantsStatus`/`size`. When `hash` is absent, the locale reuses default bytes and those byte-describing fields. Metadata fields (`alt`, `title`, `description`, `focalPoint`, `tags`) follow the same presence-wins-over-default rule regardless of whether the locale has its own bytes.

### Format handling

Format-specific rules for upload, variant generation, and rendering. Each row is the authoritative spec for one input format.

| Source format | Variants? | Poster/thumb? | Transcode at upload? | Notes |
|---|---|---|---|---|
| JPEG, PNG | 4 widths | — | No | Stored as-is; ICC preserved via sharp `keepIccProfile()`; EXIF orientation applied then stripped |
| WebP, AVIF (static) | 4 widths (same format) | — | No | Stored as-is |
| GIF, APNG, animated WebP, animated AVIF | **No** | First frame extracted at upload | No | `animated: true` + `frames: N` + `duration: ms` on manifest; served via `<img>` with manifest `poster` URL available for lazy-load UX |
| SVG | **No** (vector) | — | No | Sanitized via DOMPurify SVG profile; dimensions from `viewBox`; hash computed on sanitized bytes |
| HEIC, HEIF | 4 widths (post-transcode) | — | → JPEG | Requires libheif at deploy; reject with clear error if unavailable |
| TIFF | 4 widths (post-transcode, first page only) | — | → JPEG | Multi-page TIFF warns + transcodes first page |
| Video (MP4, WebM, MOV) | No | Icon in v1, extracted frame in v2 | No | Range requests required for seeking; duration extraction deferred (no ffmpeg dep in v1) |
| Audio (MP3, WAV, FLAC, Opus, AAC, M4A, OGG) | No | Icon in v1, waveform in v2 | No | Duration extracted via `music-metadata` at upload; personal metadata stripped by default, opt-in preservation |
| PDF | N/A (downloadable) | Icon in v1, first-page render in v2 | No | `Content-Disposition: inline` so browsers render in-tab |
| ZIP, DOCX, XLSX, PPTX, WASM | N/A (downloadable) | Icon | No | `Content-Disposition: attachment` |
| Font (.woff2, .woff, .ttf, .otf) | N/A | Sample text preview | No | `kind: font`; see font rules below |

**Animated images render as `<img>` in v1.** The modern best practice is to transcode animated GIFs to `<video autoplay muted loop playsinline poster="...">` because MP4/WebM is often an order of magnitude or more smaller at equivalent quality (web.dev's canonical example shows 13.7 MB GIF vs 551 KB MP4 — ~25× — though the actual ratio depends on content). That transcoding requires ffmpeg which we've deliberately excluded as a v1 dependency. v2 may add optional ffmpeg-based transcoding for animated content → `<video>` playback.

**SVG sanitization specifics.** Default policy:
- Strip: `<script>`, event handlers (`onclick`, `onload`, etc.), `<foreignObject>`, `<animate>` with time-triggered events
- Strip external references: `<use href>`, `<image href>`, `<script src>` pointing to any URL (even https) — privacy leak risk via tracking pixels, and defense-in-depth against XSS
- Warn at upload when sanitized bytes contain embedded base64 images over **100 KB**; reject over **1 MB** (bloat heuristic; tunable via site config)
- Hash is computed on sanitized bytes, so re-uploading a malicious SVG with benign content produces the same hash as a benign upload — content addresses the sanitized output, not the input

**SVG served from an isolated origin (strongly recommended).** Beyond sanitization, production deployments should serve user-uploaded content from a different subdomain than the admin origin — GitHub serves all user uploads from `*.githubusercontent.com` (a separate domain from github.com) for exactly this defense-in-depth. This prevents an SVG that slips past sanitization from accessing admin cookies or same-origin privileges. Configure via `TargetConfig.assetsUrl` when it ships; in v1, document the recommendation and the rationale.

**CSS and JS are not asset types.** Code assets don't fit the embedded-asset model (which assumes a URL-in-element rendering contract — `<img>`, `<video>`, `<audio>`) and have security/layout constraints that media formats don't share. Four existing paths cover the real needs:

- **Template code** — `templates/*/index.tsx` returns `{ html, css, js }`. Template-owned, always has been
- **Author-editable custom CSS or scripts per-page** — template exposes a schema field (`z.string()`) for it, author fills it, template renders it inline. Template author controls what's exposable (security choice)
- **Site-wide scripts** (analytics, tracking) — out of media scope; future `site.config.ts` field or template `head` contribution
- **Downloadable code samples** — `kind: downloadable` for CSS/JS files offered for visitors to download

Not in the model: `kind: stylesheet` or `kind: script`. Code assets are a security surface requiring template-author review of each use, and rendering them via the resolver would conflict with templates' existing CSS/JS pipeline.

### Storage provider extensions

Add streaming binary methods; keep existing text methods:

```ts
interface StorageProvider {
  // Existing
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  readDir(path: string): Promise<DirEntry[]>
  exists(path: string): Promise<boolean>
  mkdir(path: string): Promise<void>
  rm(path: string): Promise<void>

  // New — binary streaming
  readStream(path: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>>
  writeStream(path: string, stream: ReadableStream<Uint8Array>): Promise<void>
}

type ByteRange = { start: number; end: number }
```

Contract:
- `writeFile` and `writeStream` must be atomic from readers' perspective (filesystem uses write-then-rename; R2/S3/Azure are naturally atomic on single-object PUT)
- `readStream` must support range requests for video playback

Four providers to update: filesystem, R2, S3, Azure Blob.

### URL construction

Target config in `site.config.ts`:

```ts
export default defineSite({
  targets: {
    production: {
      storage: r2Storage({ /* ... */ }),
      siteUrl: 'https://cdn.example.com/',   // optional; default is root-relative
    },
  },
})
```

Resolver constructs URLs: `{siteUrl}assets/{name}-{hash}.{ext}`. Default (no `siteUrl`) → root-relative `/assets/...` — portable across domains.

**Note:** `siteUrl` already exists on `TargetConfig` (used for SEO canonical URLs). The resolver reuses it rather than introducing a second URL-base field.

### Transform adapters (per-target delivery strategy)

Every target has a transform adapter — `sharp` by default, swappable via `target.transforms.adapter`. The adapter owns three coupled concerns: URL composition, srcset semantics, and cache policy. Co-locating them on one interface (rather than scattering URL construction in the resolver and cache headers in the serve-route) means future adapters with non-trivial delivery (signed URLs, format negotiation, server-side proxying) plug in without leaking knowledge across modules.

```ts
import { defineSite, filesystemStorage, r2Storage, sharpAdapter, cloudflareAdapter } from 'gazetta'

export default defineSite({
  targets: {
    // Default — no transforms config means sharp adapter
    local: {
      storage: filesystemStorage(),
      // transforms unset → sharp adapter, immutable cache, origin URLs
    },

    // Cloudflare CDN
    production: {
      storage: r2Storage({ bucket: 'site-prod' }),
      siteUrl: 'https://cdn.example.com',
      transforms: cloudflareAdapter({
        zone: 'cdn.example.com',   // where /cdn-cgi/image/ is served
      }),
    },
  },
})
```

**Adapter contract** — URL builder + cache policy + optional server-side route:

```ts
interface TransformAdapter {
  readonly name: string
  /** URL for the asset's bytes-of-record. */
  primaryUrl(input: AssetUrlInput): string
  /** Responsive srcset, or null when not supported (non-image, no ladder). */
  srcset(input: AssetUrlInput): string | null
  /** Cache-Control + optional Vary for bytes this adapter produced. */
  cachePolicy(input: AssetUrlInput): CachePolicy
  /** Optional — adapters that mediate delivery server-side mount their own routes. */
  mountRoutes?(app: Hono): void
}

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

interface CachePolicy {
  cacheControl: string
  vary?: string
}
```

The adapter is **required** in the resolver context (defaulting to `sharpAdapter` at the call site). Resolver code paths don't branch on "does an adapter exist" — every URL goes through one. Eliminates conditional URL construction.

**Shipped adapters (v1):**

| Adapter | Primary URL | srcset | Cache policy | Notes |
|---|---|---|---|---|
| `sharp` (default) | `/assets/hero-{hash}.jpg` (origin) | from manifest's pre-generated variants | `public, max-age=31536000, immutable` | Hash-in-path is content-addressed; new bytes = new URL. |
| `cloudflare` | `https://{zone}/cdn-cgi/image/format=auto/{originUrl}` | width-ladder via `/cdn-cgi/image/format=auto,width={w}/...` | same + `Vary: Accept` | `format=auto` returns AVIF/WebP/JPEG per browser; caches must vary on Accept. Skips ladder widths above source width. |

**Future adapters** plug into the same factory (`buildTransformAdapter` in `transforms/index.ts`):

| Adapter | Status | URL shape |
|---|---|---|
| `imgproxy` | v1.5 — validates HMAC-signed URL contract via `mountRoutes` | `https://proxy.example.com/{sig}/rs:fill:800:0/plain/{originUrl}@webp` |
| `cloudinary` | community-contributed | `https://res.cloudinary.com/{cloud}/image/fetch/w_800,f_auto/{originUrl}` |
| `imgix` | community-contributed | `https://{source}.imgix.net/assets/{path}?w=800&auto=format` |

**Cache policy ownership:**

The asset-serve route reads cache headers from `adapter.cachePolicy(input)` instead of hardcoding. That's the load-bearing reason cache lives on the adapter — without it, future adapters with different cache semantics (signed URLs with short TTLs, format-negotiation URLs needing `Vary: Accept`) would leak knowledge into `serve-route.ts`.

### Cache invalidation

Hash-in-path means URL changes whenever bytes change. The serve-route reads `Cache-Control` from `adapter.cachePolicy(input)` rather than hardcoding — see "Transform adapters" above for adapter-owned cache rationale. Both shipped adapters return `public, max-age=31536000, immutable` because hash-in-path is content-addressed; the cloudflare adapter additionally sets `Vary: Accept` because `format=auto` returns different bytes per browser.

No cache purging, no query strings. Replace bytes → new hash → new URL → automatic cache bust. Old bytes remain servable until GC.

Browser support for `immutable` is partial: Firefox 49+ and Safari 11+ implement it; Chrome does not (caniuse/BCD shows Chrome `version_added: false`). It's fine: all browsers honor the long `max-age`, and since the URL itself changes when bytes change, revalidation of a stale copy is just a cheap 304. The `immutable` directive is belt-and-suspenders for Firefox/Safari that avoids even the 304 round-trip.

## Refs and integrity

### Ref index

`.refs/{name}.json` lists all references to an asset:

```json
{
  "asset": "hero",
  "refs": [
    { "source": "page", "path": "pages/home/page.json", "componentPath": "hero" },
    { "source": "fragment", "path": "fragments/promo/fragment.json", "componentPath": "image" }
  ],
  "updatedAt": "2026-04-19T14:30:00Z"
}
```

Written incrementally on every page/fragment save (the admin-API save path diffs old vs new refs and updates affected asset index files).

**The ref index is derived state.** The content tree is authoritative. `gazetta assets reindex` rebuilds the index from a full content scan. Any disagreement between index and content means the index is wrong.

**What's tracked:** refs declared via `embeddedAsset()` / `downloadable()` schema helpers (from `gazetta/schema`). **Not tracked:** asset references inside rich-text/markdown bodies, asset URLs hardcoded in template code. Delete UI surfaces this limitation: "References inside rich-text content are not tracked."

### Delete semantics

| State | Behavior |
|---|---|
| 0 refs | Confirm + delete |
| 1+ refs, replacement picked | Rewrite all refs to the replacement asset, then delete original |
| 1+ refs, no replacement | Blocked. Usage panel shown. Author must remove refs manually or pick a replacement. |

Replace compatibility: same kind (embedded ↔ embedded, downloadable ↔ downloadable). Within embedded, cross-subtype is blocked (image ≠ video). Same kind + different MIME is allowed (JPEG → PNG, PDF → DOCX).

Replace writes one history revision covering all rewritten manifests + the delete.

### Rename

Rename `hero` → `banner` is safe-order:
1. Copy bytes + variants to new hashed paths (`banner-{hash}.jpg`, variants)
2. Copy manifest to `banner.asset.json`
3. Rewrite all refs from `hero` → `banner` (atomic per-manifest)
4. Delete old manifest `hero.asset.json`
5. Delete old bytes + variants (background)

URLs are always valid during rename — old bytes stay until refs are rewritten.

Rename rewrites all references. No CMS in our research does this automatically; it's distinctive and deliberate. Authors coming from Sanity/Contentful will expect rename to be free metadata — document as deliberate choice.

**v1 limitation — rename refuses on assets with locale/theme overrides** (lifted by M7 for language versions; theme versions are still refused).
The default-only happy path is in v1; full override-aware rename
(copy each override slice to the new name, rewrite locale manifests,
delete old slices, all atomically in one history revision) is a
follow-up. v1 surfaces a typed error pointing the author at "remove
overrides first." M7 (cut 5) builds it for language versions; theme versions stay in design-media-implementation.md → "out of v1."

### Multi-write contract

Storage providers offer no cross-object transactions. Multi-write operations (replace, rename) are **best-effort with compensating rollback**:

- Plan all writes
- Execute sequentially in safe order (old bytes preserved until new refs committed)
- On failure, attempt rollback of prior writes
- If rollback fails, log inconsistency; reindex is the recovery path

Realistic contract. Honest about what the underlying storage layer can offer.

**Per-file atomicity is also best-effort.** The current filesystem provider (`packages/gazetta/src/providers/filesystem.ts`) uses a direct `fs.writeFile` — no write-then-rename. A reader mid-write can see a truncated manifest. This affects more than media, but media is where it hurts most (corrupt `.asset.json` means the asset vanishes from the library). Fixing this is a provider-interface concern — add write-then-rename to the filesystem provider as part of the storage-interface widening work. The `write-file-atomic` npm package (v7.0.1, ISC, npm-maintained) is the canonical implementation. Atomicity guarantees: POSIX `rename(2)` is atomic within a single filesystem (Node's `fs.rename` delegates to it on POSIX); Windows `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING` is atomic on NTFS when source and target are on the same volume — write-file-atomic handles this by placing the temp file in the same directory. R2/S3/Azure PUT are naturally atomic per object and need no change.

### Publish ref integrity

Publishing a page to a destination target must not create broken refs on that target.

- Publish resolves transitive asset dependencies — any asset referenced by the published pages/fragments that doesn't exist on the destination is included in the publish
- Before committing writes on the destination, validate that every ref in the incoming content resolves to an asset present on the destination
- If validation fails, publish is blocked with a specific error pointing to the missing asset

Content-addressed storage paths dedupe automatically: if `hero-a3b2c1d4.jpg` already exists on destination, skip the byte copy — the asset is identical.

## Template contract

### Resolver

`packages/gazetta/src/renderer/resolve-asset.ts`:

```ts
// Resolver is invoked through the walker (`resolveAssetRefs`) — there is no
// public single-ref entry point. The walker reads a content object, finds
// every value carrying `_asset`, dispatches by `manifest.kind`, and returns
// a content tree where references are swapped for resolved shapes.

resolveAssetRefs(
  content: Record<string, unknown> | undefined,
  ctx: AssetResolveContext,
): Promise<Record<string, unknown> | undefined>

interface AssetResolveContext {
  storage: StorageProvider
  assetsRoot: string                       // typically 'assets'
  siteUrl?: string
  locale?: string
  theme?: string
  locales?: ResolvedLocales | null         // from resolveSiteLocales(site.manifest)
  themes?: ResolvedThemes | null           // from resolveSiteThemes(site.manifest)
  transformAdapter?: TransformAdapter      // defaults to sharpAdapter
}
```

Called during:
- Publish (static targets) — at SSR time, once per asset ref in page/fragment content
- Request (dynamic targets) — at render time
- Preview (admin) — via the admin-API

Walker reads the default manifest first (to discover `kind`), then dispatches:

- **Embedded / downloadable**: builds the cross-dimension fallback chain via `crossDimensionFallbackChain(ctx)` (locale-priority order), reads each chain entry's locale variant, folds them most-specific-LAST into one effective `Partial<AssetManifest>`, calls the kind resolver. Locale-bytes overrides redirect URL to the locale-suffixed bytes path; metadata-only overrides keep default bytes.
- **Font**: enumerates every (locale, theme) cell in the supported universe, reads each variant that exists, returns the full set as a `FontVariantEntry[]`. Resolver emits one `@font-face` declaration per variant. Fonts ADD variants (unicode-range-keyed), they don't override.

URL composition happens via the resolver context's `transformAdapter` (defaults to `sharpAdapter`). Adapter is required, never branched on within the resolver.

**Per-kind resolver signatures (walker-internal helpers):**

The three per-kind resolvers are **file-scoped** — the walker (`resolveAssetRefs`)
is the only public entry point. They form a symmetric dispatch group but are not
exported; nothing outside `resolve.ts` imports them (tests exercise the walker
end-to-end, not the per-kind functions directly). Keeping the three symmetric
means they're de-exported as a set, not individually.

```ts
resolveEmbeddedRef(ref, defaultManifest, effectiveOverride, selector, ctx) → ResolvedEmbeddedAsset
resolveDownloadableRef(ref, defaultManifest, effectiveOverride, selector, ctx) → ResolvedDownloadableAsset
resolveFontRef(ref, defaultManifest, variants: FontVariantEntry[], ctx) → ResolvedFontAsset
```

Embedded/downloadable take the pre-folded effective override (one merged `Partial<AssetManifest>` from the chain). Font takes the full variant list because it needs all of them in the resolved union — it doesn't pick one. Per Q3 lock, fonts compose differently, and the dispatch shape reflects that honestly (different signature for the kind that has different semantics, rather than forcing uniformity).

### Resolver caching

Per-invocation cache (Map<assetName, Promise<ResolvedAsset>>) scoped to the publish run or the request. Avoids repeated manifest reads when N components on one page reference the same asset. Invalidated between runs.

### Graceful degradation

Resolver failures (manifest missing, corrupt JSON, unsupported state like `external-proxy` in v1) do not halt rendering. The resolver returns a placeholder ResolvedAsset with a broken-image URL and the available alt text, and logs a warning. Pages continue rendering; authors see degraded output instead of crashed pages.

### Template-author types

Templates import types:

```ts
import type { TemplateFunction, Content } from 'gazetta'
import { z } from 'zod'
import { embeddedAsset } from 'gazetta/schema'

export const schema = z.object({
  hero: embeddedAsset({ accept: ['image'] }),
  title: z.string()
})

type ResolvedContent = Content<typeof schema>
// ResolvedContent['hero'] is ResolvedEmbeddedAsset — not the reference shape

const render: TemplateFunction<typeof schema> = ({ content }) => ({
  html: `<section>
    <img src="${content.hero.url}" srcset="${content.hero.srcset ?? ''}"
         alt="${content.hero.alt}" width="${content.hero.width}" height="${content.hero.height}">
    <h1>${content.title}</h1>
  </section>`,
  css: '', js: ''
})
```

`Content<typeof schema>` is a type utility that walks the Zod shape and swaps `EmbeddedAssetRef` → `ResolvedEmbeddedAsset`, `DownloadableAssetRef` → `ResolvedDownloadableAsset`. Template authors never see reference shapes.

### Schema helpers

```ts
embeddedAsset({
  accept?: AcceptFilter[]         // ['image'], ['video'], ['image/svg+xml'], ...
  altOverride?: boolean           // default true (images), false (others)
  altRequired?: boolean           // default false — warn at save if null
  focalPointOverride?: boolean    // default true (images), false (others)
})

downloadable({
  accept?: AcceptFilter[]
  titleOverride?: boolean
  descriptionOverride?: boolean
})

fontAsset({
  accept?: ('woff2' | 'woff' | 'ttf' | 'otf')[]  // default all
  variable?: boolean                              // expects a variable font
})
```

`AcceptFilter` grammar: kind names (`'image'`, `'video'`, `'audio'`, `'document'`, `'font'`, `'other'`), MIME prefixes (`'image/'`), or exact MIMEs (`'image/svg+xml'`).

## Security

### Upload-time validation

- **MIME sniff** from bytes (via `file-type`) — client-supplied Content-Type is advisory. Reject mismatched extension vs sniffed MIME. **SVG is not detected by `file-type`** (it's text-based, not binary; excluded by design per the package README). Handle SVG via a separate path: recognize by `.svg` extension or `image/svg+xml` Content-Type, then validate by parsing as XML + checking for `<svg>` root element. Or use the `@file-type/xml` plugin.
- **Size > 0** required, and `≤ target.assets.maxBytes` (default 50 MB). Per-target config — sites with raw-photo workflows on self-hosted storage can raise to 500 MB; sites on Cloudflare Workers Free tier should cap below 100 MB to fit the worker body limit. Enforced after the bytes are received, against the actual sniffed size, not the client-supplied `Content-Length`.
- **Name validation** (see Storage → Name rules)
- **SVG sanitization** — strip `<script>`, event handlers (`onclick`, `onload`, etc.), `<foreignObject>`, and **all** external `xlink:href`/`href` references (tracking pixels are a privacy leak even when sanitized). Via DOMPurify SVG profile (`USE_PROFILES: { svg: true }`). Run on upload; store sanitized bytes. Hash is computed on sanitized output. Warn at upload when embedded base64 images exceed **100 KB**; reject over **1 MB** (bloat heuristic; tunable via site config).
- **SVG origin isolation (strongly recommended for production)** — serve user-uploaded content from a different subdomain than the admin origin. GitHub serves all user-uploaded content from `*.githubusercontent.com` (separate from github.com) — defense in depth even if sanitization has a gap. Configure via `TargetConfig.assetsUrl` / `siteUrl` to point at a subdomain distinct from the admin. Sanitization + origin isolation together give belt-and-suspenders SVG security.
- **EXIF handling** — apply orientation to bytes via sharp's `.rotate()` (auto-orient), then output. sharp's default output strips all metadata; explicitly `keepIccProfile()` to preserve color profile. GPS and device-info EXIF are removed by the default strip.
- **HEIC transcode** — `image/heic` → `image/jpeg` at upload (most browsers can't display HEIC). IANA distinguishes `image/heic`, `image/heic-sequence`, `image/heif`, `image/heif-sequence` — HEIC and HEIF are distinct formats, not synonyms. Transcode all four to JPEG with the same rule. Note: sharp's prebuilt binary does not include HEIC/HEIF support; requires a globally-installed libvips with libheif. Treat HEIC/HEIF as deployment-dependent capabilities — reject uploads with a clear error when libheif is unavailable.

### External URL validation

- **Scheme allow-list**: `https:` in production; `http:` in dev
- **Reject**: `file:`, `javascript:`, `data:`, `ftp:`
- **Reject URLs resolving to private IPs** (RFC1918, loopback, link-local) — SSRF protection, enforced at upload time

### Asset serving

- `Content-Type`: sniffed MIME
- `X-Content-Type-Options: nosniff` — prevents browser MIME second-guessing
- `Content-Disposition: attachment` for `kind: downloadable`, inline for `kind: embedded`
- `ETag: "{hash}"` — conditional requests return 304 Not Modified
- `Cache-Control` + optional `Vary` from `adapter.cachePolicy(input)` — adapter owns the policy; sharp returns `public, max-age=31536000, immutable`, cloudflare additionally returns `Vary: Accept`
- `Access-Control-Allow-Origin: *` (v1 — private assets are out of scope)
- Range request support for video

### Reserved paths (rejected at upload)

- Names starting `.` (`.DS_Store`, `.env`)
- Anything under `.gazetta/`
- Anything ending `.asset.json`
- Anything inside `.refs/`

## Admin UX

### UX constraints inherited from the existing shell

The admin at `apps/admin/` is a three-pane layout (top bar + split sidebar + iframe preview) with URL-driven state. All existing secondary surfaces (PublishPanel, HistoryPanel, UnsavedDialog, Create dialogs) are **modal dialogs** — there is no persistent side drawer. Layout is desktop-only.

Media features fit this shell via two existing mechanisms:

1. **Modal dialogs** for the library and picker (matches PublishPanel/HistoryPanel pattern)
2. **Custom field widgets** via `meta({ field: 'asset-picker' })` for inline pickers in component forms (matches `brand-color.tsx`)

No layout restructuring, no new drawer system, no new field-registration mechanism.

### Library

**Surface:** modal dialog, opened from the active-target menu (alongside the existing "History" action) and via the `Cmd+L` / `Ctrl+L` keyboard shortcut. Same modal pattern as PublishPanel / HistoryPanel — overlay, dismissible, doesn't restructure layout.

**Bindings:**
- **Active target** — library shows assets from the target that's currently active. Switching target (via the top-bar indicator) refreshes the library.
- **Active locale** — metadata fields (alt, title, description, tags) shown in the active locale's values with fallback chain. Editing metadata edits the active locale's manifest variant (`hero.asset.fr.json` when French is active, `hero.asset.json` otherwise).

- Default view: **grid** with thumbnails; table-view toggle preserves selection
- Default sort: **recently uploaded**
- Search: filename + alt text + tags (in active locale)
- Filters: kind (image/video/audio/document), date, tag
- Bulk: multi-select with shift/cmd-click, bulk delete (blocks if any have refs)
- Drag-drop: full-panel drop zone
- Paste from clipboard: images auto-named with timestamp

Empty state: "Drop files here to upload, or paste a URL for an external asset."

### Upload zone

- Drop zone (full-panel) + file picker
- Inline upload list shows queued / uploading / done / error per file
- For image uploads, each row gains an inline alt text input + "Decorative"
  checkbox once the file lands. Non-blocking — author can fill alt now,
  later, or never (the library-card badge surfaces null-alt state).
- Videos/audio/documents: no alt; title/description live in the detail
  pane (per kind)
- Each successful upload commits one history revision (per file, not
  per batch — granular undo)
- **Same-name upload:** saved under a new name, with "Replace hero instead"
  in the row; no dialog, in any language (M2)

**Locale-specific bytes at upload** (superseded by M2: language versions are added from the detail pane, and the upload zone has no dialog):

When the active locale is not the default and the author is uploading a file that matches an existing asset's name (e.g., dragging `hero.jpg` while French is active, and `hero` already exists as a default asset), the dialog asks:

- **Replace default bytes** — uploads as the default asset; all locales that don't have an override now use the new bytes. Regenerates default variants.
- **Add French bytes override** — keeps the default intact; French pages render the new bytes, other locales unchanged. Generates French-specific variants.
- **Cancel**

For brand-new asset names (no existing asset with that name), upload always creates the default asset regardless of active locale. Locale-bytes overrides are added later via "Add French version" in the library detail pane. Reason: first upload establishes the asset's identity; locale overrides come after.

When the active locale is default (or no other locale is active), upload always writes to the default asset. No prompt.

### External URL dialog

- Paste URL
- Auto-detect kind from `Content-Type` HEAD (best-effort; author can override)
- Manual metadata fields: title, alt, dimensions (if known)
- Confirms creates the manifest

### Asset detail pane (right side of library)

- **Preview**: image/video player, audio player, document icon. Shows default bytes by default; locale chip row above the preview lets the author switch which byte variant is shown.
- **Details**: name, kind, size, dimensions, duration, uploaded. Per-locale bytes show their own size/dimensions when selected.
- **Metadata**: alt (editable), tags (editable), title (downloadables). Scoped to active locale (library's top-bar `LocalePicker`), with fallback indicator as described in i18n UX.
- **Locale bytes** (images/video/audio only): list of per-locale byte overrides with upload/delete buttons.
  - `Default` — always present, shows the base bytes
  - `French (fr) — 1.2 MB, 1920×1080` — locale override, with "Remove override" button (falls back to default, doesn't affect refs)
  - `+ Add locale bytes…` — prompts for locale selection and file upload
- **Usage**: collapsible list of refs with clickable paths to the referencing page/fragment, showing which locales reference the asset
- **Actions**: Download (original or active-locale bytes), Replace (M3), Rename (M7), Delete

### Picker (opened from schema field)

**Surface:** modal dialog owned by the admin shell, three internal panels:

1. **Library browser** — filtered to schema's `accept`, same search/sort as main library
2. **Asset detail** — read-only preview and metadata for the selected asset
3. **Reference options** — alt override and focal-point editor (images only, if schema allows; M1, M6); for downloadables, title and description when `titleOverride` / `descriptionOverride` allow (M6)

Flow: browse → select → detail → (reference options) → confirm → picker closes, form data updates.

Inline upload: dragging a new file into the picker uploads it and auto-selects.

**Mounting mechanism.** The picker is a Vue component in the admin shell, opened via a Pinia store action. Custom field widgets (whether Vue-native or React-via-rjsf) invoke it through `openAssetPicker()` — see "Custom field API" below. The store holds picker state; the component mounts once in the shell and toggles visibility.

**Modal-in-modal concern.** If the picker opens while the author is inside another modal (rare — Publish dialog uses asset refs, History doesn't), modals stack via PrimeVue's z-index layering. No special handling needed.

**Active locale applies.** Alt/title/description shown in the picker's detail pane reflect the active locale. Editing alt in the reference-options step creates a per-reference override — that override lives in the page manifest (locale-specific page file), not on the asset manifest.

### Focal point editor

Image shown with crosshair at current focal point (defaults to center). Click anywhere on the image → focal point moves. Preview panels show sample crops at common aspect ratios (16:9, 4:3, 1:1) with the focal point applied. Visual feedback.

### Custom field API

Custom fields use the existing `FieldMount` contract — actual shape (from `packages/gazetta/src/types.ts`):

```ts
interface FieldMount {
  mount(el: HTMLElement, props: {
    value: unknown
    schema: Record<string, unknown>
    theme: 'dark' | 'light'
    onChange: (value: unknown) => void
  }): void
  unmount(el: HTMLElement): void
}
```

Custom fields can open the picker via a new export:

```ts
import { openAssetPicker } from 'gazetta/editor'

const ref = await openAssetPicker({
  accept: ['image'],
  currentAssetRef: existingRef  // pre-select if replacing
})
if (ref) onChange(ref)
```

Returns the reference shape or `null` if cancelled. Picker auto-closes if the custom field unmounts mid-open (promise rejects with "cancelled"). The picker is new surface — `openAssetPicker` doesn't exist yet; the `FieldMount` contract does.

**Implementation:** `openAssetPicker` lives in `packages/gazetta/src/editor/` and delegates to a Pinia store in the admin shell that owns the modal's open/close state. The store action returns a Promise that resolves on confirm / cancel. Works cross-framework because it's a pure Promise-returning function — field widgets in React (rjsf) or Svelte or vanilla JS all call it the same way. ~30 LOC of shell plumbing.

### Save semantics for assets

Two save contexts with different rules, because they edit different files:

| Context | What's being edited | Save behavior |
|---|---|---|
| **Asset metadata** (from the library or detail pane) | The asset's manifest — default `{name}.asset.json` when default locale is active, `{name}.asset.{locale}.json` when a non-default locale is active (created on first edit, removed when emptied back to defaults) | **Immediate** — save on blur or debounced. Library UX expects fast iteration; a global "save library" button would be an odd fit. |
| **Per-reference overrides** (from the picker's reference options) | The page/fragment manifest being edited (which is itself a locale variant — `page.json` or `page.fr.json`) | **Follows the page editor's pending-edits model** — dirty state tracked by `useEditingStore`, persisted on page Save, blocked by `UnsavedDialog` on navigation. |

The split maps cleanly to the mental model: changing an image's alt across the whole site is an asset operation (takes effect immediately everywhere it's used); overriding alt for a specific use is a page-edit operation (takes effect only when the page saves).

### i18n: system-level rules

Gazetta's i18n model uses file-suffix manifests (`page.fr.json`, `hero.asset.fr.json`) and a top-bar `LocalePicker` that drives all content via `?locale=` URL state. Media follows the same model. These are the cross-cutting rules that shape every surface; the next subsection covers editor-UX specifics.

**What's locale-agnostic (same across all locales):**
- Asset bytes, dimensions, mime, hash, variants, file size, focal point
- Reference index and usage relationships
- Transform adapter URLs (they resolve to the same bytes regardless of locale)

**What varies per locale:**
- Alt text
- Title (downloadables)
- Description (downloadables)
- Tag display labels (optional — authors may keep tags in one language or localize per market)

**Resolver locale rules:**
- Resolver signature: `resolveAsset(ref, { target, storage, locale })` — locale is required context
- Per-invocation cache key includes locale: `Map<(assetName, locale), Promise<ResolvedAsset>>`. French and English resolutions produce different shapes (different alt) and must not share cache entries.
- Fallback chain for a given locale follows `TargetConfig`'s fallback rules — same chain used for pages (`pt-BR` → `pt` → default locale)
- **Default locale is the floor** — if default manifest's alt is null/missing, resolved alt is `""` (per the three-state rule) with a warning. No further fallback.

**Locale-specific bytes — supported as optional overrides:**

One asset, one name, one identity. Bytes per locale are optional overrides layered on top of default bytes. Same pattern as metadata: default manifest always exists; locale variants are optional additions.

- A locale manifest **may** include a `hash` field. Presence means "this locale has its own bytes"; absence means "this locale uses default bytes."
- Byte filenames: `{name}-{hash}.{ext}` for default, `{name}-{hash}.{locale}.{ext}` for locale-specific overrides.
- Resolver with `locale = 'fr'` reads `hero.asset.fr.json`; if it has a `hash`, constructs URL from `hero-{hash}.fr.jpg`. If no `hash`, falls back to default manifest's `hash` and default byte path. Metadata fields (alt, focal) merge with fallback chain independently from bytes.
- The hash-in-path URL model holds per locale. Each locale's bytes have their own hash; cache invalidation works locale by locale. No single "asset hash" — hash is a property of bytes, and bytes can legitimately vary per locale.
- Variants (srcset) are generated per locale's bytes. French bytes produce `hero-{hash}.fr-400w.jpg`, `hero-{hash}.fr-800w.jpg`, etc. Transform adapters receive the per-locale origin URL from the resolver and are unchanged.

Example manifest pair:

```json
// hero.asset.json — default
{
  "version": 1, "name": "hero",
  "hash": "a3b2c1d4", "width": 1920, "height": 1080,
  "variants": [ ... ], "variantsStatus": "complete",
  "alt": "Mountain sunset at dusk"
}

// hero.asset.fr.json — French bytes override (text baked in)
{
  "version": 1, "name": "hero",
  "hash": "d5e6f7a8", "width": 1920, "height": 1080,
  "variants": [ ... ],            // French-bytes-specific variants
  "alt": "Coucher de soleil"
}

// hero.asset.ar.json — alt override only, no locale-specific bytes
{
  "version": 1, "name": "hero",
  "alt": "غروب الشمس"
  // no `hash` → uses default bytes
}
```

Rationale for supporting this in v1: the naming-convention workaround (`hero-en`, `hero-fr`, `hero-ar` as separate assets) creates real authoring friction — library fills with near-duplicate entries, atomic rename/replace across locales is lost, the usage panel misrepresents "one conceptual asset" as three unrelated ones. The architectural cost is finite (manifest gains an optional field; variant generation runs per locale's bytes; upload flow gains a "default vs override" choice). Retrofitting later would require migrating existing sites. Designing it in from v1 is cheaper and distinctive against Contentful (files-per-locale but no override model) and Sanity (no locale-specific bytes at all).

**Locale-override consistency checks at upload:**

When uploading a locale-bytes override, enforce:

- **Kind must match default.** Image default + video override → rejected. Asset `kind` is a single identity; locale variants are bytes-of-that-kind.
- **Animated flag must match default.** Static JPEG default + animated GIF override → rejected. Templates render animated and static differently; mixing within one asset breaks the contract. Authors wanting different animation per locale use separate assets.
- **Dimensions may differ but warn.** Default 1920×1080 + override 1600×900 → warning shown with allow/cancel. Some authors intentionally swap aspect ratio per locale; blocking would be paternalistic.
- **MIME may differ within the kind.** Image/jpeg default + image/webp override → allowed; each locale's variants are generated in its own format.
- **Default bytes cannot be removed independently.** Deleting the default is deleting the asset; locale overrides can be removed individually and fall back to default.
- **Deleting the default cascades.** "Delete asset" removes default bytes + all locale-bytes overrides + all locale-metadata manifests + ref index entry.

**Fonts: locale manifest ADDS a variant, not OVERRIDES bytes.**

Unlike images/video/audio where a locale manifest overrides default bytes, a font's locale manifest contributes an additional variant to the union. The resolver returns all variants; the template emits a `@font-face` per variant with `unicode-range`; the browser picks per character.

Concrete:

```json
// brand-sans.asset.json — default (Latin)
{
  "version": 1, "name": "brand-sans", "kind": "font",
  "cssName": "BrandSans",
  "hash": "a3b2c1d4",
  "format": "woff2", "weight": 400, "style": "normal",
  "unicodeRange": "U+0000-007F, U+00A0-00FF"
}

// brand-sans.asset.ar.json — Arabic contribution
{
  "version": 1, "name": "brand-sans",
  "hash": "b9c0d1e2",
  "format": "woff2", "weight": 400, "style": "normal",
  "unicodeRange": "U+0600-06FF"
}

// brand-sans.asset.ja.json — Japanese contribution
{
  "version": 1, "name": "brand-sans",
  "hash": "e5f6a7b8",
  "format": "woff2", "weight": 400, "style": "normal",
  "unicodeRange": "U+3000-303F, U+3040-309F, U+30A0-30FF, U+4E00-9FFF"
}
```

Resolver returns a `ResolvedFontAsset` with `cssName: "BrandSans"` and three variants. Template code:

```ts
css: content.bodyFont.variants.map(v => `
  @font-face {
    font-family: '${content.bodyFont.cssName}';
    src: url('${v.url}') format('${v.format}');
    font-weight: ${v.weight};
    font-style: ${v.style};
    ${v.unicodeRange ? `unicode-range: ${v.unicodeRange};` : ''}
  }
`).join('\n') + `
  body { font-family: '${content.bodyFont.cssName}', sans-serif; }
`
```

**`cssName` vs the font file's intrinsic family name.** `cssName` is a Gazetta-stable identifier the resolver owns; it does not have to match the font file's metadata. Template code references `cssName` in `font-family`; the browser sees all variants under that name and picks per-character. The actual fonts underneath (Inter, Noto Sans Arabic, Noto Sans JP) are invisible to the template.

**Unicode-range inference at upload.** Upload dialog for a font locale override infers `unicodeRange` from the locale (en → Latin, ar → Arabic, ja → CJK covering the Japanese scripts, etc.). Author can override the inferred range explicitly. Inference is best-effort — complex scripts sometimes need manual ranges.

**Font family name uniqueness.** `cssName` should be unique within a site. Soft-enforced: upload warns if another font asset declares the same `cssName`. Not blocked (different weights/styles legitimately share a family name via separate asset entries).

**Publish locale filtering:**
- Default: publish copies all locale variants of an asset together — `hero.asset.json`, `hero.asset.fr.json`, `hero.asset.ar.json` all move as a unit
- Optional narrowing via `TargetConfig.locales`:

  ```yaml
  targets:
    production:
      locales: [en]   # publish only default-locale variants; skip fr, ar
  ```
- When set, publish filters which locale variants get copied to match the target's configured locales. Same field already narrows which page variants ship to a target; media inherits the same rule.

**History per locale manifest:**
- Each locale variant of an asset manifest is a distinct path in the content-addressed history. A save of `hero.asset.fr.json` produces a history revision referencing just that path's blob.
- Restoring a revision restores the specific locale variants it touched; no built-in "restore all locales of this asset" operation (unusual need; authors select per-variant if required).
- Fallback chain still works after partial restore — a restored French manifest + an unchanged default manifest resolve correctly together.

**Ref index per locale manifest:**
- Each referencing manifest (including locale variants) is a separate entry in the asset's ref index JSON. `page.fr.json` and `page.json` both referencing `hero` produce two entries, not one aggregated entry.
- Rationale: save of `page.fr.json` can update just its own entry without reading or merging the default page's entry — simpler incremental writes
- Usage panel UI groups entries by page for display (see editor UX below)

**CLI locale semantics:**
- `gazetta assets list` lists one entry per asset name with locale-coverage info in a column. `--locale fr` filters to assets that have a French manifest variant.
- `gazetta assets info hero` shows all locale variants by default, sectioned per locale.
- `gazetta assets reindex` walks all locale variants of pages/fragments when rebuilding refs. For orphan bytes (manifest missing), only the default manifest is inferred from bytes; locale variants require explicit author intent, not auto-generation.

### i18n in the editor UX

**Library display with a non-default locale active:**
- Grid thumbnails are unchanged (bytes are locale-agnostic)
- Card subtitle shows alt/title in the active locale with fallback chain applied
- **"(using default)" badge** appears next to any field that's falling back — prevents authors from editing text they thought was localized but was actually a fallback
- Search spans **all locale variants' alt + tags + the filename**. The author wants to find the asset; restricting to one locale's metadata frustrates that. Matched asset still displays in the active locale (with fallback); the author understands the match once they open the detail pane.
- Filter-by-tag shows tag chips in the active locale's labels if localized tags exist

**Asset metadata edits target the active locale:**
- Editing alt while French is active writes to `hero.asset.fr.json` (creates the file on first edit)
- Editing alt while default locale is active writes to `hero.asset.json`
- Library detail pane shows a **"Editing in: French"** indicator near the metadata fields, matching the page editor's locale indication
- Per-field affordances:
  - **"Clear override"** — deletes this field from the locale variant, falling back to default
  - **"Copy from default"** — pre-fills with default-locale value so author can translate in place
  - **"Delete French variant"** — removes the entire locale manifest when emptied

**Upload always prompts for default-locale alt:**
- Even when French is active, the upload dialog's alt field is labelled "Alt text (default — French and other locales fall back to this unless overridden)"
- Reason: default alt is the fallback for every locale; skipping it means missing alt everywhere that doesn't override
- Localization is a separate flow, done after upload in the library detail pane
- The default manifest always exists; locale variants are optional additions layered on top

**Picker reference options show the resolution chain:**
- The "Reference options" panel has an alt-override field with the full fallback chain shown below it:
  ```
  Alt text
  [  Le coucher de soleil sur la tour Eiffel  ] ← per-ref override
    Falls back to: "Coucher de soleil" (from French asset metadata)
    Then to: "Sunset at dusk" (from default asset metadata)
  ```
- This is one of the few places the fallback chain is surfaced explicitly. Necessary because per-reference overrides compete with two levels of asset-level metadata; without the chain, authors would override redundantly or miss that the asset already has a French alt
- Per-reference alt lives on the page manifest where the ref is declared (`page.fr.json`) — not on the asset

**Usage panel shows locales per referencing page:**
- `pages/home (en, fr, ar) — 3 locales` rather than just `pages/home`
- Groups the per-locale-manifest entries from the ref index by page name for display
- Click a locale chip to navigate to that specific locale variant of the page
- Helps authors find pages where the asset is used but not yet localized properly

**Replace / rename / delete operate across all locales atomically:**
- Replace `hero` with `hero-v2` rewrites every page/fragment manifest that references `hero`, including all locale variants (`page.fr.json`, `page.ar.json`)
- Rename `hero` → `banner` moves bytes once and rewrites every locale manifest's refs; `hero.asset.fr.json` becomes `banner.asset.fr.json`
- Delete-blocked check aggregates refs across all locales — removing a ref from only the English page doesn't free the asset if French still references it
- All three operations write one history revision spanning every touched manifest

**Locale coverage badge per asset (nice-to-have):**
- Library grid cards can show small chips indicating which locales have explicit metadata
- `[en ✓ fr ✓ ar —]` — spot un-localized assets at a glance
- Analogous to the existing SiteTree's per-page locale indicator
- v1 if cheap to add via PrimeVue DataView; v1.5 otherwise

**Locale/target switching mid-picker:**
- Picker closes when the route changes (locale or target switch, unsaved-edits guard applies first)
- The edit context is gone; confirming the picker at that point would save a ref to a page that's no longer the focus
- Author reopens the picker if they want to pick again in the new context

**RTL admin support:**
- Library modal, picker modal, and detail pane inherit document `dir` from the admin root (set from active locale). PrimeVue components generally support RTL when `dir="rtl"` is on the ancestor
- Custom components (focal-point editor, upload queue, usage panel) use CSS logical properties (`margin-inline-start` over `margin-left`) so they flip with locale
- Text alignment is automatic via `dir` inheritance; grid layout (first asset placement) flips when `dir="rtl"` via CSS Grid's logical-axis behavior
- The starter site has Arabic content (`page.ar.json`), so admin RTL for media is a must-have, not a nice-to-have. Validate during implementation with Arabic active.

### Keyboard shortcuts

Existing admin shortcuts: `Cmd+S` (save), `Esc` (exit edit / close modal). Media additions:

- **`Cmd+L`** — open the library modal from anywhere in the admin
- **`Enter`** — in picker/library, confirm selection (when a single asset is focused)
- **Arrow keys** — navigate grid in library/picker (needs custom handler; PrimeVue DataView only ships keyboard support for the layout-toggle buttons)
- **`Esc`** — close picker/library modal (inherited from PrimeVue Dialog default)

### Delete dialog

**Delete the whole asset** (default bytes + all overrides + all metadata variants):

- 0 refs: "Delete hero.jpg?" with confirm. If the asset has locale-bytes overrides, confirm names them: "This will also remove 2 locale byte overrides (fr, ar)."
- 1+ refs: usage panel + two actions:
  - **Replace with...** — opens picker filtered to compatible kinds, then executes replace-and-delete. Replacement applies to every locale ref.
  - **Cancel**
- No "delete anyway" option — would create broken refs. Authors remove refs from pages first (usage panel is clickable — jump to referring page, clear the field, save).

**Remove a locale bytes override** (`Remove French bytes override` action in detail pane):

- Always allowed; locale bytes overrides don't own refs independently
- Effect: deletes `hero-{hash}.fr.jpg` + its variants + `hash` field from `hero.asset.fr.json`
- The French locale manifest stays if it still has metadata (alt, etc.); if it only had the `hash` field, the entire French manifest is removed
- Locale that had the override now falls back to default bytes — no broken refs, no code changes in referring pages
- Confirmation: "French pages will use default bytes after this. Continue?"

This gives authors precise control: "I want to remove the French bytes but keep everything else" doesn't require deleting and rebuilding the asset.

### Preview and asset changes

The preview iframe morphs on draft edits (300ms debounce) and target switches; reloads on route changes. Asset interactions with preview:

- **Picker confirms a new ref** → `onChange(ref)` fires → page becomes dirty → preview POSTs with overrides → morphs with new image URL. No new preview code; uses existing mechanism.
- **Author replaces bytes on an asset in use by the currently-previewed page** → asset bytes write immediately (hash changes), but the preview's current HTML has the old hashed URL baked in. The dev-server SSE reload on `assets/` changes (existing mechanism) triggers a full preview reload that picks up the new URL. Acceptable — the scenario is rare (cross-editing).
- **Author switches active locale with picker open** → existing unsaved-edits guard handles it; picker closes when the route changes.

### Navigation from usage panel to references

The asset detail pane's usage list shows "used by page X component Y." Clicking a usage row navigates to `/pages/X/edit?target=current&locale=current#Y` using the existing hash-based component selection. No new navigation code; just URL construction from existing primitives.

## Publish and history

### Publish integration

Save and publish are separate pipelines today: save writes a manifest to storage (pages.ts / fragments.ts routes call `storage.writeFile()` directly — no render, even for static targets), while publish renders + assembles + writes HTML via `publishItems()` and `publishPageRendered()` / `publishPageStatic()`. Both call `recordWrite()` into history. The media work extends the publish pipeline, not save.

**Note on the design-publishing.md "+ render if static" rule for save:** not currently implemented. Save is manifest-only; re-render happens on publish or on preview fetch. The rule is aspirational; the doc here describes actual current behavior.

**Incremental publish is not implemented today** — publish expands the full dependency set and writes every item. The "skip if destination already has this hash" dedupe described below is a new capability the media work introduces; it needs to be wired into the publish loop, not assumed present.

Publishing a page or fragment walks its manifest, extracts asset refs, and:
1. For each ref, check if the destination has the asset at the same hash
2. If missing or different hash, include the asset bytes + manifest in the publish payload
3. Validate ref integrity on destination before writing anything
4. Write manifests, bytes, variants, and target content atomically (best-effort)
5. Write one history revision covering all items

Transitive dependencies mean publishing a single page can publish many assets (if new). Authors see aggregate progress ("publishing 12 items: 3 pages, 7 assets, 2 fragments").

### History integration

History is substantially implemented in the codebase — more so than earlier passes of this doc assumed. Confirmed existing surface:

- `packages/gazetta/src/history.ts` — `Revision` / `RevisionManifest` types; `snapshot: Record<path, hash>` maps content paths to SHA-256 blob hashes
- `history-provider.ts` — content-addressed blob storage at `.gazetta/history/objects/<hh>/<rest>`, dedupes on `exists()` before write
- `history-recorder.ts` — `recordWrite()` called from save (pages/fragments routes) and publish route
- `history-restorer.ts` — rollback restores a revision's content tree
- `.gazetta/history/revisions/rev-<ms>.json`, one file per revision and the source of truth; `index.json` is a cache of the list (#1107)
- Retention via `HistoryRetention.maxRevisions`, default 50 (`DEFAULT_HISTORY_RETENTION`)
- `/api/history` admin route exists

Asset manifests are part of the content tree and flow through the existing recorder with no code changes — the recorder already content-addresses arbitrary paths. Asset bytes also become blob-addressed: the live `assets/{name}-{hash}.{ext}` path can be thought of as a "hot" copy of the same hash-keyed blob that history would write. In v1 we duplicate (store bytes both at the live path and as a history blob); a future optimization unifies them via symlinks or pointer files.

History revisions ejected by retention drop their blob references; a future `gazetta gc` reclaims unreachable bytes. With high asset churn, retention + GC matters more than for text-only content.

### Restoring a revision with assets

Restore writes the revision's manifests back to the content tree. Bytes at the referenced hash paths: if still present, nothing to do; if GC'd (revision was ejected earlier and blobs pruned), the restore reports "missing bytes" for those assets. Ref index rebuilt by the same writer that runs after save.

## Operations

### CLI

| Command | What it does |
|---|---|
| `gazetta assets list [--target X] [--kind K]` | List assets on a target |
| `gazetta assets info <name> [--target X]` | Show manifest, variants, refs |
| `gazetta assets reindex [--target X]` | Rebuild derived state: manifests for orphan bytes, refs index, variants (with `--generate-variants`) |

Additional (nice-to-have, not v1 must-have): `validate`, `export`, `import`.

### Reindex

Walks target storage and reconciles:

1. For each byte file without manifest → generate inferred manifest (sniffed MIME, kind, size, dimensions for images)
2. For each manifest without bytes → mark "missing bytes" (or delete the manifest if `--strict`)
3. Walk pages and fragments → extract declared asset refs
4. Rebuild `.refs/*.json` from walked refs
5. Report broken refs (point to non-existent assets)
6. With `--generate-variants`: run variant generator for images missing variants

Expected runtime: seconds for small sites, minutes for large (1000+ pages or assets).

### GC and retention

Asset bytes accumulate as history keeps old revisions. Two sources of unreachable bytes:

- Revisions ejected by retention → their exclusive blobs become unreachable
- Replace/rename/delete operations → old hashed paths are unreferenced by any revision once the originating revision is ejected

`gazetta gc [--target X] --dry-run` walks all revision manifests, builds the set of reachable blobs, identifies unreferenced byte files. Deletes on confirmation.

Not v1 critical — deferred to its own issue. Document as a known future operation.

## Admin API

Routes under `/api/assets*`. Path-encoded resource identity, query-encoded
selector — same convention pages and fragments already use for locale
addressing (`/api/pages/:name?locale=fr`).

### Resource identity vs selector — why query, not path

Locale and theme are first-class peer dimensions in the data model
(see "Override dimensions" above). On the wire they are **not** path
segments. Two reasons:

1. **Consistency across the admin API.** Pages and fragments already
   address locale via `?locale=fr` query (`design-i18n.md` "Admin UI"
   section). Splitting between path-style for assets and query-style
   for pages would make admin clients carry two patterns.
2. **Selector ≠ identity.** The asset's identity is `:name`. The
   selector picks a *version* of that identity. Path-encoding the
   selector reads as "different resource"; query-encoding reads as
   "this resource, this version" — which matches the model.

Theme follows the same shape: future `?theme=dark` slots in without
inventing a new URL grammar. The compound case is `?locale=fr&theme=dark`.

### Routes (v1)

| Verb | Path | Query | Body | Purpose |
|---|---|---|---|---|
| `GET` | `/api/assets` | `?target=` | — | List assets on the target |
| `GET` | `/api/assets/:name` | `?target=` | — | Read default manifest summary |
| `POST` | `/api/assets` | `?target=` | multipart `{file, name, alt?}` | Upload a new default asset |
| `DELETE` | `/api/assets/:name` | `?target=` | — | Delete an asset (blocks if refs > 0) |
| `POST` | `/api/assets/:name/replace-with/:newName` | `?target=` | — | Atomic replace-and-delete |
| `POST` | `/api/assets/:name/rename-to/:newName` | `?target=` | — | Atomic rename across all refs |
| `POST` | `/api/assets/:name/locale-bytes` | `?target=&locale=fr[&theme=dark]` | multipart `{file}` | Upload bytes override for selector |
| `DELETE` | `/api/assets/:name/locale-bytes` | `?target=&locale=fr[&theme=dark]` | — | Remove bytes override for selector |

The `locale-bytes` segment names the **operation** (this is bytes-override
ingest, not a metadata edit). The query identifies the **selector** — the
specific (locale, theme) variant being written or removed.

### Response shapes

All success bodies match the typed schemas in
`packages/gazetta/src/admin-api/schemas/assets.ts`. Errors map by
class via `respondWithAssetError`:

| Error class | HTTP | Body shape |
|---|---|---|
| `AssetValidationError` (subclasses) | 400 | `{ code, message }` |
| `AssetManifestNotFoundError` | 404 | `{ code, message }` |
| `AssetInUseError` | 409 | `{ code, message, assetName, refs[] }` |
| `AssetKindMismatchError` | 409 | `{ code, message, oldKind, newKind, ... }` |
| `AssetNameCollisionError` | 409 | `{ code, message, newName }` |
| `AssetStorageError` | 500 | `{ code, message }` |

Adding a new asset error subclass propagates the right HTTP status
automatically — `httpStatus` is declared on the class, not in the
route handler.

### Selector parsing

Query params `locale` and `theme` are validated server-side:

- `locale` — BCP 47 lowercase, via `isValidLocale`
- `theme` — lowercase ASCII non-locale token, via `isValidTheme`

Either dimension absent means "use the default for this dimension."
Both absent on a `locale-bytes` route is a 400 — the route exists to
write a non-default selector. The default asset's bytes are written
via `POST /api/assets` (the `alt`-prompting upload path).

## Editor flow decisions (#1357)

Seven parts of the editor flow above were unbuilt or undecided on 2026-10-29 ([#1357](https://github.com/gazetta-studio/gazetta-studio/issues/1357); its discovery research compares Sanity, Payload, Strapi, Storyblok, Contentful and Directus). Where these decisions differ from the sections above, these win; the sections above point here.

What the code does today (checked 2026-10-29): `altOverride`, `focalPointOverride`, `titleOverride`, `descriptionOverride` and `variable` are declared (`schema/helpers.ts`) and read nowhere; a same-name upload in the default language silently replaces the image and drops its alt and focal point ([#1349](https://github.com/gazetta-studio/gazetta-studio/issues/1349)); `PATCH /api/assets/:name` has no language, so alt edited with French active, or an AI suggestion accepted then, overwrites the default alt; uploads accept images and audio only (`assets/validate.ts`) and ingest always writes `kind: 'embedded'`; replacing an asset with another one exists only inside the delete flow, replacing an asset's own file has no route or UI, and Rename has no UI.

### M1 — Alt and focal point per use

When an author picks an image for a page, the picker's third step (Picker, panel 3) lets them give that use its own alt text and focal point, showing what the alt falls back to. The override is stored on the reference in the page manifest, as "Reference shape" already allows. A logo can be meaningful in the hero and decorative in the footer.

Decided: maintainer, 2026-10-29 (#1553)

| Rejected | Why |
|---|---|
| Focal point per use only (Sanity's model) | A logo needing different alt in two places needs two assets |
| Nothing per use (Strapi, Storyblok) | Alt can't follow how the image is used, which WCAG asks for |

### M2 — An upload never replaces an image

Uploading a file whose name matches an existing image saves it under a new name (`hero-2`), and its upload row says so: "Saved as hero-2 · Replace hero instead". The link runs the detail pane's Replace (M3), which keeps alt, focal point and uses, and then deletes the now unused `hero-2`, in one revision. This is the same in every language: a language version is added from the image's detail pane ("+ Add French version"), so the upload zone's language dialog ("Locale-specific bytes at upload" above) goes.

Decided: maintainer, 2026-10-29 (#1553)

| Rejected | Why |
|---|---|
| Today's behaviour: silent replace in the default language, a dialog in others | Loses work without telling the author (#1349), and behaves differently by language |
| A dialog on every clash: Replace / Keep both / Cancel, plus "Add French version" in other languages | One dialog per clashing file; a decision before the author has seen anything |
| Refuse until the author chooses: the row waits with Replace / Keep both | Nothing is saved until the author picks |
| As chosen, plus "Use as French version of hero" in the row when another language is active | The row would differ by language; the detail pane shows which languages already have a version |

The link also removing `hero-2`: Decided: maintainer, 2026-10-29 (#1553)

| Rejected | Why |
|---|---|
| The link only replaces; `hero-2` stays for the author to delete | Every clash followed by the intended replace leaves an unused entry in the library |

**Known limit.** The server picks the next free name by checking, then writing: storage has no "create only if absent", so two uploads of the same name at the same moment (two tabs, two admin instances, a script) can both take `hero-2`, and one overwrites the other. A storage primitive comes if it ever bites.

Decided: maintainer, 2026-10-29 (#1553)

| Rejected | Why |
|---|---|
| Cut 2 adds a create-if-absent write to every storage provider | A new primitive across four providers is out of proportion for this round |

### M3 — Replace keeps alt and focal point, and asks the author to check them

Replace (detail pane, or the upload row's link) puts a new file of the same kind into the same asset: same name, new hash, alt text, focal point, per-use overrides and uses kept. The result shows the new image with its alt and focal point: "Check the alt text and focal point still fit the new image", with Edit alt, Edit focal point and, when AI alt is set up, Suggest; it mentions pages and fragments with their own alt for this image. It goes away when dismissed; nothing is stored. Replace changes no page manifest. It's a new operation on the asset's own file, separate from the delete dialog's "Replace with…", which points every use at another asset and is unchanged.

Decided: maintainer, 2026-10-29 (#1553)

| Rejected | Why |
|---|---|
| Show nothing | Wrong alt goes live unnoticed when the new picture shows something else |
| The note plus a "check alt" library badge until someone confirms | New stored state, and a badge that stays after the author checked |
| Confirm in the Replace dialog before saving | A decision on every replace, before the new image is in place |
| Reset the focal point to the centre | Drops a focal point that usually still fits |
| Clear alt and re-run AI | Loses work; sites without AI end up with no alt |

### M4 — Alt text is edited in the active language

As "Asset metadata edits target the active locale" above designs it: with French active, the alt field edits French alt (`hero.asset.fr.json`). Until there is one, the field shows the default alt greyed, "Using English", with "Copy English to edit"; a French alt can be cleared to fall back. An AI suggestion accepted in the detail pane fills the active language's alt, like typing. The metadata `PATCH` takes the language in the query, like the locale-bytes and suggest-alt routes (`?locale=`; "Selector parsing").

Decided: maintainer, 2026-10-29 (#1553)

| Rejected | Why |
|---|---|
| Default language only; read-only elsewhere ("Alt text is set in English") | French screen-reader users hear English alt |
| Edit anywhere, always save the default, with a label | Keeps today's trap, only labelled |
| An alt field per language at once, whatever language is active | Ignores the language switcher that drives every other screen, and grows with every language |
| French alt only through per-use alt on French pages (M1) | The same French alt retyped on every page using the image |

The upload row is different: an upload creates the image itself (M2), so its alt field and AI auto-fill fill the **default** alt, with the suggestion generated in the default language even when French is active. "Upload always prompts for default-locale alt" (i18n in the editor UX) stands. French alt is added from the detail pane.

Decided: maintainer, 2026-10-29 (#1553)

| Rejected | Why |
|---|---|
| The upload row fills the active language's alt | An image uploaded with French active could have French alt and no default, so every other language falls back to none |

Adding or removing a language version keeps that language's alt: uploading French bytes keeps the French alt already saved, and removing them deletes only the bytes, keeping the French manifest while it holds alt (as "Remove a locale bytes override" above designs). Today both drop it (`ingest-locale.ts` writes a fresh byte-only manifest; `remove-override.ts` deletes the file). Cut 3 builds this.

Decided: maintainer, 2026-10-29 (#1553)

| Rejected | Why |
|---|---|
| A separate bug that must land before cut 3, leaving cut 3's scope as it is | Cut 3 is what makes French alt common, so the fix ships with it |
| Accept the gap for now and drop "nothing can lose work" | Cuts 2 and 3 together would recreate the silent alt loss this round set out to end |

### M5 — Documents and fonts upload now

Documents (PDF, Word, Excel, PowerPoint, ZIP) upload as `kind: downloadable` and fill `downloadable()` fields. Fonts upload as `kind: font` with a short form (family name, weight, style; characters guessed from the active language) and a sample-text preview; each language adds its characters to the same family from the font's detail pane ("+ Add Japanese characters"), as "Fonts: locale manifest ADDS a variant" above designs. What exists: the resolver's dispatch by kind and the union of per-language font variants. The default manifest has no font fields or document title yet (`schema/types.ts` aliases both to `AssetManifest`), and the resolver uses the asset name as a font's family and a document's title; cuts 6 and 7 add the fields and the resolver reads, so the upload form's values take effect. This larger scope was confirmed once its cost was shown.

Decided: maintainer, 2026-10-29 (#1553)

| Rejected | Why |
|---|---|
| Documents now, fonts after Stage 1 | Arabic and CJK sites keep hand-writing `@font-face` in template code, and the built resolver stays unused |
| Fonts now, documents later | Linking a PDF, a common author task, stays impossible |
| Defer both | No download links and no per-language fonts |
| Fonts only as template files | Undoes the locked font kind and pushes per-language fonts into template code |
| Documents and fonts now, but a font's family is always its asset name and no weight or style is stored | The upload form's family, weight and style would mean nothing |

### M6 — Field options do what they say

Each option controls its per-use step: `altOverride: false` and `focalPointOverride: false` hide those parts of the picker's third step (M1); `titleOverride` and `descriptionOverride` let authors name a download link per page (M5); `variable: true` lets the picker offer only variable fonts (M5).

Decided: maintainer, 2026-10-29 (#1553)

| Rejected | Why |
|---|---|
| Keep them, marked "reserved, no effect yet" | Options that do nothing are stubs (team rule 18) |
| Remove them | M1 and M5 need them at once; re-adding later breaks templates |

### M7 — Rename is all or nothing, checked first

Rename's dialog lists the pages and fragments it will change and moves the asset's language versions with it, in one revision, for every kind (images, documents, fonts). Theme versions weren't decided here: an asset with a theme version is still refused. If the author can't edit one of them, or has unsaved edits on one, it says which and renames nothing ("Can't rename: it's used on pages, and you can't edit pages"; "you have unsaved changes on home. Save or discard them first"). Fragments count like pages because rename rewrites every reference, and M7's rule is that no use may point at a name that no longer exists. "All or nothing" covers the checks; a storage failure partway follows the "Multi-write contract" (safe order, the old name kept until every reference is rewritten). For language versions this lifts the "v1 limitation" under Rename above.

Decided: maintainer, 2026-10-29 (#1553)

| Rejected | Why |
|---|---|
| Rename what it can and report the rest | Leaves pages pointing at a name that no longer exists |
| Rename only the display name (Sanity, Contentful) | Reverses the deliberate choice that rename changes the real name and the file name in URLs |

The server makes the same check, before any write, whatever sent the request: it refuses a rename unless the caller can edit pages (`edit:pages`) and fragments (`edit:fragments`) when the asset has uses there. Roles are site-wide in v1 (`design-auth-rbac.md`), so the refusal names the kind of item, not one page.

Decided: maintainer, 2026-10-29 (#1553)

| Rejected | Why |
|---|---|
| The check stays in the dialog only | A script or the MCP server bypasses it |
| Rename keeps refusing documents and fonts that have language versions | Rename would behave differently by kind |

### UX check

A summary of M1–M7; it decides nothing new.

- **Actors:** content authors (upload, replace, alt per language, per-use alt and focal point, rename, documents); template developers (the field options, M6; fonts, M5).
- **Absence as state:** an upload under a free name looks as it does today; the "Saved as hero-2" note shows only on a clash (M2); the Replace check note shows only after a replace and goes when dismissed (M3); "Using English" shows only while a language has no alt of its own (M4).
- **Same behaviour in every language:** uploads behave the same in every language (M2); language versions are added from the detail pane (M2, M5).
- **Failure states:** a clash never replaces (M2, with the known limit for simultaneous uploads); a replace keeps alt, focal point and uses (M3); adding or removing a language version keeps its alt (M4); a rename that would leave a use unedited, or that the caller can't make, is refused before any write, on the server too (M7).

### Cut sequence

Fixes first, then features: after cuts 1–3 nothing authors do today can lose work.

Decided: maintainer, 2026-10-29 (#1553)

| Rejected | Why |
|---|---|
| By screen: upload zone, detail pane, picker, new kinds, docs | #1349's data loss is fixed with the upload-zone work, not first |
| Documents and fonts first | The silent-replace data loss stays longer |


| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 1 | Replace in place keeping alt, focal point, overrides and uses, with the check note (M3; fixes #1349) | #1334 | api + component | Medium |
| 2 | Uploads never replace: the server saves an upload under an existing name as the next free name, whatever sent it; the row's "Replace hero instead" link; the language dialog goes (M2) | 1 | api + component + e2e | Low |
| 3 | Alt in the active language in the detail pane: `PATCH ?locale=`, "Using English", Copy English, clear, AI suggestions there; the upload row keeps the default alt and suggests in the default language; adding or removing a language version keeps its alt (M4) | #1334 | api + component | Medium |
| 4 | Per-use alt and focal point in the picker's third step, with `altOverride` and `focalPointOverride` (M1, M6) | — | component + e2e | Medium-high |
| 5 | Rename, all or nothing, with language versions (M7) | — | api + component | High |
| 6 | Documents and download links, with `titleOverride` and `descriptionOverride` (M5, M6) | — | api + component | Medium |
| 7 | Fonts: upload form, per-language characters, preview, `variable` (M5, M6) | 6 | api + component | Medium |
| 8 | Docs: `docs/content-assets.md`, `docs/template-assets.md` | 1–7 | docs | Low |

Cuts 1 and 3 need [#1334](https://github.com/gazetta-studio/gazetta-studio/issues/1334): a page's publish hash ignores its assets, so without it publish reports the pages unchanged and targets keep the old picture and alt. Cut 2 needs cut 1 because its row link runs Replace and removes `hero-2`; cut 7 needs cut 6 because both teach upload a new kind. The server check in cut 2 makes M2 hold for every caller (a second tab, a script, the MCP server), not only the admin's upload zone.

Decided: maintainer, 2026-10-29 (#1553)

| Rejected | Why |
|---|---|
| Only a note that until #1334 lands, changes reach targets with `gazetta publish --force` | Cuts 1 and 3 would ship changes authors can't publish |
| Cut 2 changes only the admin's upload zone | A second tab, a script or the MCP server can still replace an image silently, which M2 says never happens |


## Distinctive choices (for reviewers coming from other CMSes)

- **Rename rewrites refs automatically.** No surveyed CMS does this. Storyblok and Tina explicitly don't support rename. Sanity/Contentful treat filename as metadata unlinked from identity. Keeping this is distinctive and worth the cost — it matches how authors think about content.
- **Delete blocked when refs > 0.** Contentful's web app takes the closest approach. Strapi has a long-standing bug-report history for dangling refs (historical example: strapi#4384, now closed but representative of the bug class). Replace-and-delete is our equivalent of Storyblok's "Replace Asset" app.
- **Uniform resolved shape for internal + external.** Templates see `{ url, srcset, width, height, alt, ... }` regardless of source. Sanity/Contentful deliver different shapes per provider. Our uniform shape simplifies template code.
- **External assets as first-class library entries.** Matches Contentful and Storyblok.
- **Locale-specific bytes as optional overrides.** One asset, one identity, optional per-locale byte overrides layered on top. Contentful localizes the whole asset (file per locale, all or nothing). Sanity doesn't localize bytes. Our model treats locale bytes the same way as locale metadata — optional additions with automatic fallback — so authors can selectively localize only the images that need it (hero with baked-in text) while sharing the rest (product photos, diagrams). No other surveyed CMS has this shape.
- **Fonts as first-class assets with union-variant resolution.** `kind: font` alongside embedded/downloadable, with locale manifests contributing additional `@font-face` variants rather than overriding. Template emits `@font-face` per variant with `unicode-range`; browser picks per character (Google Fonts' pattern for Noto Sans JP). Other CMSes treat fonts as template/theme dependencies or ignore them. Our model makes multi-script typography work correctly without template CSS gymnastics.
- **CSS and JS explicitly not asset types.** Code assets have a different rendering contract (head vs body, cascade/execution order, security surface) and belong in template code or template-exposed schema fields — not in the library. Keeps the asset model focused on media.
