# Media (Assets) — Implementation

Companion to [design-media.md](design-media.md). This doc covers what we're doing with the design: v1 scope with estimates, phased alternative, out-of-v1 items, adjacent capabilities for v1.5/v2, frontier opportunities, open implementation questions, and migration from the current string-URL pattern.

See [design-media.md](design-media.md) for the design itself and [design-media-reference.md](design-media-reference.md) for fact-checked tooling and codebase-alignment details.

## v1 scope (~10–12 weeks single-dev wall-clock; less with parallelism)

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending. Step refs cite the
foundation grilling sequence (see commit log on the `media-v1-slice`
branch for diffs).

| Piece | Estimate | Status |
|---|---|---|
| StorageProvider streaming extensions (4 providers) | 1 week | ✓ steps 1, 11 |
| Asset entity model, schema helpers, Content type utility | 3 days | ✓ step 2 |
| Upload / list / delete / replace API | 1 week | ✓ steps 3, 5, 7, 8 |
| Rename API | 2-3 days | ✓ step 22 |
| Ref index (incremental write + rebuild) | 1 week | ✓ steps 12, 13 |
| Resolver + template contract (locale-aware) | 3 days | ✓ step 17 |
| **Foundation: dimensional schema (locale + theme)** | 0.5 day | ✓ step 14 |
| **Foundation: manifest types + filename composition + AssetStoragePaths** | 1 day | ✓ step 15 |
| **Foundation: manifest validators (per-kind locale variants)** | 1.5 days | ✓ step 16 |
| **Foundation: TransformAdapter + sharp + cloudflare adapters** | 1 day | ✓ step 18 |
| **Foundation: per-target upload size config** | 0.5 day | ✓ step 19 |
| **Foundation: binary-capable HistoryProvider** | 1.5 days | ✓ step 20 |
| **Foundation: asset routes wire history (upload + delete)** | 0.5 day | ✓ step 21 |
| Library UI (grid/table, search, filter, bulk, locale-aware metadata editing) | 1 week | ✓ step 5 (default-only) + ✓ step 24 (locale-aware coverage badges + detail-pane locale section); metadata editing in the active language isn't built: design-media.md M4, cut 3 |
| Asset picker (3-panel modal with resolution-chain UX) | 1 week | ✓ step 6 (default-only) + ✓ step 24 (locale-aware preview chip surfaces); the third step (per-use alt and focal point) isn't built: design-media.md M1, cut 4 |
| Focal point editor | 2 days | ✓ step 27 — click + drag + hover preview + four aspect-ratio thumbnails (1:1, 16:9, 4:5, 9:16). Hotspot rectangle (Sanity's region model) remains out of v1 |
| Alt UX (inline upload-list input + library-card no-alt badge + detail-pane editor + `altRequired` save-time enforcement) | 3 days | ✓ step 26 — multi-layer alt UX shipped (upload-list inline, library badge, detail-pane AssetAltEditor, PATCH endpoint). `altRequired` save-time enforcement deferred to v1.5 — schema introspection at save not yet wired |
| i18n manifest resolution + fallback chain + asset locale variants | 2 days | ✓ step 17 (resolver) + ✓ step 24 (UI surfaces) |
| Locale-specific bytes (upload "default vs override" flow, per-locale variant generation, detail-pane locale bytes section, remove-override action) | 1 week | ✓ step 24 — backend (24 backend) + UX (24 UX); the upload "default vs override" dialog goes: design-media.md M2, cut 2 |
| Picker accept-filter kind-compat enforcement | 1 day | ✓ step 23 |
| Font asset kind (schema helper, resolver's union-with-unicode-range semantic, upload dialog for font metadata, locale-adds-variant behavior, library font preview) | 3–4 days | ✓ step 17 (resolver dispatch + variant union); upload UI + library preview: design-media.md M5, cut 7 |
| Animated-image handling (detection via sharp `pages > 1`, first-frame poster extraction, `animated`/`duration` manifest fields) | 2 days | ✓ step 31 — sharp `pages > 1` detection + first-frame PNG poster + `animated`/`frames`/`duration`/`poster` manifest fields. New `UploadAnalyzer` abstraction (peer to `UploadPreprocessor`) provides the open extension seam for audio metadata, PDF page counts, EXIF orientation, etc. |
| Audio metadata (duration via `music-metadata`, strip-by-default metadata with opt-in preserve) | 1 day | ✓ step 32 — `audioAnalyzer` (peer of static/animated image analyzers) extracts duration via `music-metadata`. 10 audio MIMEs admitted (MP3, WAV, FLAC, Opus, AAC, M4A, OGG and their `x-` variants). Strip-by-default is a *preprocessor* concern (byte transform); deferred to v1.5 since it requires writing back through `music-metadata`'s tag writer — the analyzer reading metadata non-destructively now doesn't preclude future stripping |
| SVG sanitization specifics (DOMPurify SVG profile config, embedded base64 size limits, external-href stripping) | 1 day | ✓ step 28 — DOMPurify-based sanitizer + new `UploadPreprocessor` abstraction (open extension seam for future HEIC/EXIF/animated-GIF preprocessors). MIME sniff promotes XML→SVG when root is `<svg>` |
| RTL validation + CSS logical-properties audit for custom components | 1 day | ✓ step 25 — static CSS audit + runtime smoke for asset workflow surfaces (8 SFCs); broader admin RTL is a parallel concern |
| History integration | 1–2 days | ✓ steps 20–21 (provider widening + route wiring across upload, delete, replace, rename, locale-bytes ingest, remove-override) |
| Publish integration (transitive, dedupe) | 3 days | ✓ step 10 |
| CLI (list, info, reindex) | 3 days | ✓ step 30 — list + info shipped with SOLID restructure (separate display projection, runner, output sink interface). Shared `gazetta/format` module deduplicates `formatBytes` across CLI + admin |
| Starter example template + asset | 1 day | ✓ step 4 |
| Docs (template-assets, content-assets, migration, transform-adapters) | 3 days | ✓ step 29 — four task-oriented docs in `docs/` (template-assets, content-assets, migration, transform-adapters), each pointing back to design-media.md for theory |

### Foundation grilling notes

Steps 14–19 (committed `b5befb0`, `453653c`, `6f8a69a`, `e099ecb`,
`df04929`, `13099fd`) ship the **contracts** that v1 builds on:

- **Dimensions** are closed — `locale` + `theme` only. Adding a third
  dimension extends `DIMENSION_ORDER` and the `Selector` union; no
  filename migration is required because existing files have no value
  for the new dimension.
- **Locale-priority cross-dim fallback** is locked, non-configurable:
  `(fr, dark) → (fr, light) → (default-locale, dark)`. Locale matters
  more than visual presentation when content has to fall back.
- **Filename scheme** is locked: `{name}.asset[.{loc}][.{theme}].json`
  and `{name}-{hash}[.{loc}][.{theme}][-{w}w].{ext}`. Width comes
  AFTER the selector — the selector identifies which override; width
  is the rung in THAT override's ladder.
- **Per-kind validator dispatch** (manifest-default + LocaleManifestVariant
  with three impls + dispatch map) means a future kind = one new
  variant impl + one map entry, no edits to existing kinds.
- **TransformAdapter** owns URL composition + srcset + cache policy
  + optional server-side route. Adapter is required in resolver
  context (defaults to `sharpAdapter`); resolver code paths don't
  branch on "does an adapter exist". Future adapters slot in via
  one factory case.
- **Per-target upload cap** is data on `TargetConfig.assets`, not a
  constant. Default 50 MB; sites raise/lower per worker tier or
  workflow.
- **`source: 'internal'`** stays hardcoded in v1. External-direct
  is fully punted; widening later is a future-additive change with
  no data migration cost (existing manifests already write
  `source: 'internal'` explicitly).
- **`uploadedAt` / `uploadedBy`** only on the default manifest. Locale
  variants are derivative; audit info lives on the default.

## Phased alternative

If timing pressure, ship in two passes:

**v1a (~3 weeks):** Internal only, images + documents only, flat library, basic picker, delete-with-replace, hash-in-path URLs, variants for images. No video, no external, no focal point editor (center-only).

**v1b (~2 weeks):** Video + audio, external-direct, focal point editor, upload-time alt prompt for images, tag management.

Proxy and pin are v1.5 — ship as an additive feature after v1 stabilizes.

## Out of v1 (tracked separately)

- `external-proxy` UI + Worker proxy route + SSRF protection + refresh action
- Pin (external → internal conversion)
- Hotspot rectangle
- LQIP/blurhash
- `imgproxy` transform adapter (v1.5 — validates HMAC-signed URL contract)
- `cloudinary` / `imgix` transform adapters (community-contributed)
- Signed/private assets
- OEmbed auto-fetch
- Cross-asset dedupe
- Resumable uploads
- Video transcoding
- `gazetta gc`
- Folder UI (if tags prove insufficient)
- Concurrent-edit safety
- Animated-GIF → `<video>` transcoding (requires ffmpeg; v1 renders animated GIF as `<img>` with manifest `animated: true` + `poster` URL)
- Video duration extraction (deferred pending ffmpeg decision; manifest `duration: null` for video in v1)
- Video first-frame extraction, PDF first-page rendering, audio waveform thumbnails — all require extra deps (ffmpeg, `pdfjs-dist`)
- Font subsetting, variable-axis exposure per reference, `@font-face` preload hint generation (v2 typography polish)
- Transcripts / captions (VTT/SRT) as companion files to audio/video assets
- Override-aware rename — v1 rename refuses on assets with locale/theme overrides (clear typed error). Language versions: design-media.md M7, cut 5; theme versions stay here. Full version copies each override slice to the new name, rewrites locale manifests, deletes old slices, all in one history revision. Mechanical to add once an asset commonly carries overrides.

## Asset refs — per-edge sidecar index (v1)

design-media.md specifies a `.refs/{name}.json` aggregate index written
incrementally on every page/fragment save. The shape was reconsidered after a
measurement run and a multi-instance correctness review; the v1 implementation
uses **per-edge zero-byte sidecars** instead of an aggregate JSON file.

The delete check does not read this index: `deleteAsset` scans the loaded
site's pages and fragments (`allPageEntries` / `allFragmentEntries`) with
`scanManifestForAsset` for live refs (#1139). The sidecar is derived state
consumed by other readers, today the `gazetta assets info` CLI references
listing.

### Why we measured first

Walk-on-demand (`findAssetRefs`) used to read every page + fragment manifest
on every delete check; the walk was removed when the delete check moved to
the loaded site, and the benchmark (`perf-refs.bench.ts`) went with it. The
measurements below are kept as the record of that decision. Mean ms per
operation, walk-on-demand vs sidecar lookup, both measured against fully
populated synthetic sites:

**Read path — `findAssetRefs` (walk) vs `readRefsForAsset` (sidecar):**

| Backend         |  N=100 walk |  N=100 sidecar |  N=500 walk |  N=500 sidecar |  N=1000 walk |  N=1000 sidecar |
|-----------------|------------:|---------------:|------------:|---------------:|-------------:|----------------:|
| filesystem      |         4.7 |           0.04 |        17.9 |           0.09 |         34.3 |            0.17 |
| s3 (MinIO)      |        99.5 |           0.99 |       439.7 |           2.66 |        948.7 |            5.74 |
| azure (Azurite) |       312.4 |           4.71 |      1494.9 |           9.64 |       3263.4 |           18.22 |

**Sidecar lookup is 100–200× faster than the walk at every scale.** Azure at
N=1000: walk = 3.3s vs sidecar = 18ms.

**Write path — per-edge sidecar (`applyItemRefsDiff` w/ 3 assets) vs aggregate JSON:**

| Backend         |  N=1000 sidecar-save |  N=1000 aggregate-write |
|-----------------|---------------------:|------------------------:|
| filesystem      |                  4.3 |                     4.1 |
| s3 (MinIO)      |                  1.8 |                     1.1 |
| azure (Azurite) |                  2.3 |                     1.7 |

Per-edge sidecar writes are 1.4–1.7× the aggregate cost — the price of
N independent writes vs one. Still sub-5ms on cloud emulators; invisible
to the save handler. The tradeoff buys multi-instance correctness:
per-edge granularity means concurrent saves to different items writing
to the same asset use *different paths*, so there's no race to lose
updates.

The emulator timings undercount real cloud — every walk does ~N round-trips,
each adding 30-50ms RTT. Real S3 / Azure at N=1000 projects to 30-60s for
the walk, vs hundreds of ms for the sidecar.

**The 5-second SLA bar:** admin response should be <5s for any user-facing
operation. Walk-on-demand crosses 5s at ~150 pages on real cloud. v1 typical
sites are 50-200 pages and growing — walks WILL break the SLA in production.
Build the index now, not v1.5.

### Why per-edge sidecars over aggregate JSON

Three competing shapes considered:

| Shape | Read cost | Write cost (per save) | Multi-instance |
|---|---|---|---|
| Walk manifests (today) | ~30s real cloud at N=1000 | 0 | Correct |
| Aggregate `.refs/{name}.json` | 1 read 50ms | read+modify+write 150ms | **Drifts**; needs If-Match |
| Per-edge `.gazetta/asset-refs/{name}/{item}` | 1 readDir 50ms | 0-N file writes 0-250ms | **Correct** (granularity solves it) |

Per-edge sidecar wins on multi-instance correctness. Admin can run as a
horizontally-scaled container (Cloud Run, Fly, Kubernetes). Two instances saving
different items that both reference the same asset write to **different paths**
(`hero/pages.home` vs `hero/pages.about`). No race, no If-Match, no retry —
**granularity solves the concurrency problem**. The aggregate JSON would need
optimistic concurrency primitives (etag-based writes), which doesn't fit the
current StorageProvider contract.

Per-edge sidecars also match the existing pattern for `.uses-{frag}` and
`.tpl-{template}` sidecars — same shape, different domain.

### Storage shape — same on source and target

Targets carry full state (per design-publishing.md "self-sufficient targets"
principle). Asset-refs sidecars live on both source AND target so any target
promoted to source is immediately usable, no backfill required.

```
{root}/
├── pages/
│   └── home/
│       ├── page.json
│       ├── .uses-header                  # existing
│       ├── .uses-footer
│       ├── .tpl-page-default
│       └── .{8hex}.hash
├── assets/
│   ├── hero.asset.json
│   └── hero-{hash}.jpg
└── .gazetta/
    ├── history/                          # existing per-target undo
    └── asset-refs/                       # NEW
        └── hero/
            ├── pages.home                # zero-byte file
            └── pages.home:fr             # locale variant
```

Filename encoding: `pages.home` (slashes → dots, same `encodeRefName` as
existing sidecars). Locale variants get a `:locale` suffix.

### Update path

| Operation | Effect |
|---|---|
| Save page/fragment manifest | Diff old vs new asset refs; write/delete sidecars under `.gazetta/asset-refs/{asset}/{item}` |
| Publish | Publish flow writes asset-refs sidecars to target alongside other sidecars (same loop as `.uses-*`/`.tpl-*`) |
| Delete asset (with replace) | Replace flow rewrites refs in manifests; per-manifest save updates sidecars naturally |
| History restore (undo) | Re-derive sidecars for the restored manifest's asset refs |
| External `rm` of a manifest | Drift; reindex CLI recovers |

### Read path

`deleteAsset` does not read the sidecar directory. It scans the loaded
site's pages and fragments (`allPageEntries` / `allFragmentEntries`) with
`scanManifestForAsset`, so the returned `AssetRef[]` keeps full
`componentPath` detail from the manifests themselves (#1139).

### Drift recovery

The index is derived state. Reindex CLI (`gazetta assets reindex`) walks all
manifests and rewrites sidecars from scratch. Trigger: external manifest
mutations (text-editor edits, git pulls), or any user-suspected drift.

### Gitignore

Source-side editable target's `.gazetta/asset-refs/` is gitignored — derived
state, not authoritative. Existing rules under `**/targets/**/` extend with:

```
**/targets/**/.gazetta/asset-refs/
```

Filesystem-target dist dirs (`dist/staging`, etc.) are already covered by the
existing `dist/` gitignore.

### Not in scope

- In-memory-only design (breaks under multi-instance — every container would
  build its own Map and they'd diverge).
- Single aggregate file (`.refs.json`) — write contention serializes all saves
  AND fails multi-instance correctness without optimistic concurrency.
- SQLite — incompatible with the StorageProvider abstraction's "everything is
  bytes at a path" contract.
- Converting `index/fragments.json` (cache-purge index) to sidecars — different
  problem (single-writer publish-time aggregate, not multi-writer save-time
  incremental). Aggregate JSON is correct for that use case; leave it as-is.

## Adjacent capabilities reserved for v1.5 / v2

From competitor research (Sanity, Payload, Strapi, Storyblok, Directus, Contentful), the following features ship in most mainstream CMSes. Not in v1, but acknowledged so we don't miss them at v2 planning time.

| Feature | Competitors shipping it | Notes |
|---|---|---|
| ✓ **AI alt-text adapter** (shipped in v1.5) | Strapi (Growth default), Storyblok (Growth plan and up); Directus 11.16 uses a similar 3-provider adapter for AI-assistant attachments, not alt text | Universal expectation in 2026. Three providers shipped: Anthropic, OpenAI, Ollama. See [`design-ai.md`](design-ai.md) and [`design-ai-implementation.md`](design-ai-implementation.md). |
| **Paste-URL / import-from-URL upload** | Payload (`pasteURL` w/ allowList), Strapi (`strapi.fetch`) | Low-cost convenience. Safer than "download then re-upload." Needs SSRF allowlist from day one. |
| **MIME allowlist + magic-bytes validation** | Directus (hardened across 3 releases in Q1 2026) | Security. Cheap to ship right the first time. Pair with the existing `file-type` MIME sniffing. |
| **Asset versions with "sync all usage"** | Sanity (2026 — Asset Versions in Media Library) | Our replace-and-delete destroys history; versioning preserves it. Fits our content-addressed model naturally — each byte change is already a new hash. |
| **Custom metadata fields ("aspects")** | Sanity, Payload, Strapi, Storyblok, Directus | Our tags are flat. Aspects are a structured superset (photographer, shoot date, license, expiry). Enables the license-tracking frontier bet below. |
| **In-admin crop rectangle (not just focal)** | Every competitor | Sharp pipeline already handles crop. Sanity's hotspot pattern is the reference — a rectangle is what editors reach for, not a point. |
| **Scheduled asset publish / unpublish** | Storyblok | Integrates with our publish primitive — one new field, no new model. |
| **Soft-delete / trash / restore** | Payload (trashed docs), Storyblok (Deleted assets tab) | Our delete is hard but gated. Soft-delete is additive convenience. |

## Frontier opportunities

Three bets that would be genuinely novel in 2026 CMS space. Each extends primitives we already have rather than adding new categories.

**1. Cross-target asset-metadata merge with three-way diff.**
Every competitor centralizes their media library (Sanity's Media Library sits outside datasets; Payload uploads live in a single DB). None document what happens when `publish staging → prod` touches an asset with divergent metadata on both targets (different alt, different focal, new tag on staging only). They sidestep by centralizing. Our stateless-CMS + peer-target model *forces* an answer — and the answer, exposed as UI, is a category-of-one differentiator.

Implementation: extend the sidecar content-hash pattern to metadata-level hashing; on publish, present a per-field three-way diff (base ancestor, source, destination) with per-field pick. Scope: ~2-3 weeks backend + ~2 weeks UX.

Strengthens our real differentiator (stateless + multi-target) rather than catching up to centralized CMSes.

**2. Image-quality regression detection at variant generation.**
Run SSIM (or DSSIM) between a new variant and its prior version; warn on >2% degradation. Catches sharp version upgrades that silently degrade quality, JPEG-of-JPEG re-uploads, and adapter misconfiguration. Nobody ships this as a default — every competitor fails silently when a replacement is worse than the original.

Implementation: ~3-5 days with `ssim.js` or `image-ssim`. Lives as an opt-in admin warning, not a publish block.

**3. License / rights aspect with publish-time enforcement.**
Once aspects (custom metadata) ship, add a reserved `license` aspect with expiry date. Publish-time check blocks operations that would include an expired-license asset and reports which pages are affected. Pairs the new aspect with our existing ref-tracking — implementation is mostly a ref query with a date filter.

Scope: ~1 week after aspects exist. Enterprise-grade compliance feature at near-zero infra cost.

## Open implementation questions

1. **Picker-vs-Vue-store integration.** React rjsf widget calling into Vue admin shell's asset library store. Event-bus bridge is simplest; implementation detail.
2. **Variant generation timeout / failure policy.** Hard timeout per asset? Queue for retry? Skip and mark failed? Implementation-time decision.
3. **R2 range request semantics.** R2 public buckets support single-byte-range requests (return 206). Multi-range is not supported. Verify against `<video>` seeking before relying on it; test with a real clip, not a small sample.
4. **Clipboard paste API across browsers.** Safari behaves differently from Chrome; test early.
5. **Reindex against very large targets.** 10,000+ assets stretches the linear scan. Pagination/batching strategy needed at that scale.
6. **History integration surface.** Gazetta already has `history.ts`, `history-recorder.ts`, `history-restorer.ts`, and the `/api/history` route. The asset work extends this surface rather than building it — audit the existing recorder API before estimating the integration effort.
7. **Worker request billing.** Cloudflare Workers requests are billed even on cache hits (the Worker runs before cache). Sites hosting the admin or serving assets through Workers should expect per-request costs at load.
8. **RTL validation.** Library modal, picker modal, and detail pane need verification with Arabic active. Starter has Arabic content; test RTL flips for grid, sidebar, metadata-field alignment, focal-point editor crosshair direction. PrimeVue v4 RTL support is largely automatic but custom components need CSS logical properties audit.

## Migration from current string-URL pattern

Existing templates use `z.string()` for image URLs. Coexistence path:

- `z.string()` continues to work — templates receive a string URL, emit as-is
- Authors migrate per-template when ready: change schema to `embeddedAsset({ accept: ['image'] })`, update content files (string URL → `{ _asset: "..." }` where the name points to a library entry — internal or external), update template to consume resolved shape
- No automatic migration tool in v1; recipe documented in `docs/template-assets.md`

Starter site (`examples/starter`) ships one template migrated to the new pattern as a working example.
