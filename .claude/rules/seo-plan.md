---
paths:
  - "packages/gazetta/src/renderer.ts"
  - "packages/gazetta/src/types.ts"
  - "packages/gazetta/src/publish-rendered.ts"
  - "packages/gazetta/src/admin-api/schemas/pages.ts"
  - "apps/admin/src/client/components/PageMetadataEditor.vue"
  - "docs/seo.md"
  - "**/sitemap*"
  - "**/robots*"
---

# SEO Plan

Auto-generate everything, let authors override. The biggest gap in headless CMS SEO
isn't missing features — it's that metadata generation is left to site developers as
boilerplate. Gazetta's renderer already assembles `<head>` from template output; making
it automatically emit the right tags from `page.json` metadata eliminates the #1
complaint without adding admin UI complexity.

**Status legend:** ☐ todo · ◐ in progress · ✓ done

---

## Design principles

1. **Fallback chains, not empty fields.** Every SEO value has a computed default from
   existing data. Authors override only when they want to — pages never ship with empty
   titles or missing canonicals because the author forgot to fill in a field.

2. **Renderer owns `<head>` output.** Templates can still emit their own `head` tags;
   the renderer deduplicates (metadata tags injected first, template tags win when both
   exist). Zero boilerplate for site developers.

3. **No scoring.** Yoast-style keyword/readability scoring correlates weakly with
   rankings (r = 0.10-0.32) and encourages over-optimization. The SERP preview is
   the only feedback tool — it shows what Google will display, which is what authors
   actually need.

4. **Publish-time generation.** Sitemap and robots.txt are generated at publish time
   and stored in the target alongside pages. No runtime generation needed.

---

## What's already done

| Item | PR | Status |
|------|-----|--------|
| `PageMetadata` type (title, description, ogImage, canonical) | #185 | ✓ |
| `parsePageManifest` reads metadata from page.json | #185 | ✓ |
| API: GET/PUT /api/pages/:name includes metadata | #185 | ✓ |
| `PageMetadataSchema` in contract family (4 tests) | #185 | ✓ |
| Client `PageDetail` includes metadata | #185 | ✓ |
| Renderer injects metadata into `<head>` (with template dedup) | #185 | ✓ |
| 6 renderer tests (inject, dedup, escaping, backward compat) | #185 | ✓ |
| Starter + gazetta.studio pages have example metadata | #185 | ✓ |
| Admin metadata editor (title, desc, ogImage, canonical fields) | #186 | ✓ |
| Character counters (title 60, description 160) with color | #186 | ✓ |
| SERP preview (always light-themed Google snippet) | #186 | ✓ |
| Metadata is a pending edit: the page's one Save writes it, the unsaved-changes guard covers it, kept across reload ([design-editor-ux.md](design-editor-ux.md), "Page metadata is a pending lane") | — | ✓ |

---

## Tier 1 — closes the adoption-blocker gap

### ✓ 1.1 Fallback chains in renderer

The renderer should compute SEO values from existing data when metadata fields are
empty. Authors override only when they want different values for search vs content.

| Tag | Fallback chain |
|-----|---------------|
| `<title>` | `metadata.title` → `content.title + " — " + site.name` → page name |
| `<meta name="description">` | `metadata.description` → `content.description` → omit |
| `<link rel="canonical">` | `metadata.canonical` → `site.baseUrl + route` → omit |
| `<meta property="og:title">` | same as `<title>` chain |
| `<meta property="og:description">` | same as description chain |
| `<meta property="og:image">` | `metadata.ogImage` → `site.defaultOgImage` → omit |
| `<meta property="og:url">` | same as canonical chain |
| `<meta property="og:type">` | always `"website"` |
| `<meta name="twitter:card">` | `"summary_large_image"` when ogImage resolved, `"summary"` otherwise |
| `<meta name="robots">` | `metadata.robots` when set → omit (allow indexing) |
| `<html lang>` | `site.locale` → `"en"` |

**Implementation (done):**
- `seo.ts` extracts SEO tag resolution (SRP) — `resolveSeoTags()` computes all tags
  from metadata + content + site config fallbacks.
- `renderPage` receives `SeoContext` (site name, locale, defaultOgImage, siteUrl) via
  `RenderPageOptions.seo`.
- `siteUrl` lives on each target config (not site-level `baseUrl` — removed). Canonical
  URLs use the target's `siteUrl` since each target may serve from a different domain.
- Fallback-generated values flow into the SERP preview via the admin API.

**target config additions:**
```ts
defineSite({
  targets: {
    production: {
      siteUrl: 'https://gazetta.studio', // per-target (required for sitemap/canonical)
    },
  },
})
```

**site.config.ts additions:**
```ts
defineSite({
  locales: { default: 'en', supported: ['en'] }, // already existed (optional)
  defaultOgImage: '/images/og-default.jpg',      // new (optional)
})
```

**Changes to `PageMetadata` type:**
- Added `robots?: string` (free-text: `"noindex"`, `"nofollow"`, `"noindex, nofollow"`)
- ogTitle/ogDescription kept OUT — fallback chain handles it.

---

### ✓ 1.2 sitemap.xml generation on publish

Generate `sitemap.xml` at publish time from published pages. Store in target root.

**What goes in (done):**
- One `<url>` per page with `<loc>` (absolute URL from target `siteUrl` + derived route)
- `<lastmod>` from `.pub` sidecar timestamp (date-only per spec)
- Skip dynamic routes (template patterns like `/blog/:slug` aren't crawlable)
- Skip pages with `metadata.robots` containing `"noindex"` (via `.pub-*-noindex` sidecar)

**Requirements (met):**
- Target `siteUrl` must be set (returns null without it)
- Generated per-target from target sidecars (reflects what's actually published)

**Format:**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://gazetta.studio/</loc>
    <lastmod>2026-04-17</lastmod>
  </url>
  <url>
    <loc>https://gazetta.studio/docs</loc>
    <lastmod>2026-04-17</lastmod>
  </url>
</urlset>
```

---

### ✓ 1.3 robots.txt on publish

**Strategy (done):** if `sites/{name}/robots.txt` exists, copy it to target root. Otherwise,
generate a default:

```
User-agent: *
Allow: /

Sitemap: {siteUrl}/sitemap.xml
```

The `Sitemap:` line is only included when `siteUrl` is available. Skipped entirely for
subpath deployments (Google ignores robots.txt at non-root paths).

---

### ✓ 1.4 Admin UI: noindex toggle + SERP preview with fallbacks

- Added "Hide from search engines" toggle → sets `metadata.robots = "noindex"` (done)
- SERP preview shows fallback-generated values (title with site name suffix) (done)
- "noindex" badge shown on SERP preview when page is excluded (done)
- SEO editor shown only on page root, not on child components (done)

---

## Tier 2 — expected (next pass, not this one)

| Item | Why deferred |
|------|-------------|
| JSON-LD Article schema auto-generation | Template authors need to opt in per content type; not a renderer-level default |
| Redirect management (`redirects` in site.config.ts + Hono middleware) | Separate feature, not SEO metadata |
| Metadata validation warnings (missing title, duplicate titles) | Useful but not blocking; SERP preview covers the visual case |
| OG image preview in editor (thumbnail of the OG image URL) | Nice polish, not essential |

## Tier 3 — future (validated as overkill for now)

| Item | Why not now |
|------|-----------|
| Keyword/readability scoring | Weakly correlated with rankings; encourages over-optimization |
| AI meta generation | Requires LLM integration; build when there are users asking |
| AI crawler controls (GPTBot, ClaudeBot blocks) | robots.txt already supports this manually; UI controls are premature |
| llms.txt generation | No adoption among major AI platforms; too early |
| Social card preview (Twitter/LinkedIn card rendering) | SERP preview is sufficient for now |
| hreflang management | Depends on i18n feature (separate feature-gaps.md item) |
| SEO audit dashboard | Enterprise feature; no users to validate against |

---

## Explicit non-goals

| Skip | Why |
|------|-----|
| Separate ogTitle / ogDescription fields | Research: authors rarely differentiate. Fallback chain handles it. Add later if requested. |
| Per-field translation of metadata | Depends on i18n feature |
| Structured data editor UI | Template `head` field handles this; no CMS does inline schema.org editing well |
| Content scoring (Yoast-style green/red dots) | Weakly correlated with rankings; risk of keyword-stuffing |

---

## PR sequence

All Tier 1 items landed in a single branch (#187):

| PR | Scope | Status |
|----|-------|--------|
| **#187** | Renderer fallback chains, sitemap.xml, robots.txt, admin noindex toggle + SERP preview with fallbacks, siteUrl on targets, .pub sidecars, listSidecars perf fix | ✓ |

---

## Research sources

- [DatoCMS SEO Fields](https://www.datocms.com/docs/content-modelling/seo-fields) — fallback chain pattern
- [Payload CMS SEO Plugin](https://payloadcms.com/docs/plugins/seo) — auto-generation functions
- [8 Minimum SEO Requirements for a CMS](https://www.newmediacampaigns.com/page/the-8-minimum-requirements-for-seo-features-in-a-cms)
- [Content Scoring Tools Correlation](https://searchengineland.com/content-scoring-tools-work-but-only-for-the-first-gate-in-googles-pipeline-469871) — weak r = 0.10-0.32
- [Structured Data for AI Search](https://www.stackmatix.com/blog/structured-data-ai-search) — 2.5x citation lift
- [Headless CMS SEO Challenges](https://hmdigitalsolution.com/headless-cms-seo-challenges-guide/)
- [Google Sitemap Best Practices](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
- [llms.txt Adoption Status](https://higoodie.com/blog/llms-txt-robots-txt-ai-optimization/) — too early
