---
paths:
  - "packages/gazetta/src/runtime/archive-marker.ts"
  - "packages/gazetta/src/runtime/redirects-emit.ts"
  - "packages/gazetta/src/cli/index.ts"
  - "packages/gazetta/src/admin-api/routes/publish.ts"
---

# Redirects (reference)

How Gazetta serves URL redirects. **Reference doc, NOT a foundational
dimension** — redirects are not their own design pass; they emerge as
a consumer surface from `design-soft-delete.md` (rename → 301) and a
deferred future surface from `design-scheduling.md` (302 / scheduled).
This doc consolidates the redirect-related concerns that operators
need to navigate without re-reading three docs.

**Status**: design pass not needed. The shipped surface is described
here. Future redirect features (302, scheduled, manual via admin UI)
are catalogued in "Future surfaces" below with pointers to the docs
that own them.

**Companion docs:**
- [`design-soft-delete.md`](design-soft-delete.md) — owner of the 301
  rename redirect, the HTML comment marker mechanism, and the
  `_redirects` host-glue exception.
- [`design-scheduling.md`](design-scheduling.md) — future owner of 302
  / time-bounded / scheduled redirect lifecycle (deferred per
  `design-soft-delete.md` Q14).
- [`docs/seo-plan.md`](../../docs/seo-plan.md) — Tier 2 punch-list
  entry: manual redirect creation in admin UI; the mechanism (HTML
  marker / archive-only manifest) supports it today, the UI surface is
  deferred.
- [`feature-design-process.md`](feature-design-process.md) — defines
  reference docs vs design docs vs ADRs. This file is in the
  reference-doc category alongside `design-config.md`,
  `design-logging.md`, etc.

## What ships in v1

### 301 redirects from rename

When an operator renames a page (`pages/landing` → `pages/welcome`),
the soft-delete primitive ([`design-soft-delete.md`](design-soft-delete.md))
composes the rename as:

1. Archive the old name (`landing`) with `aliasOf: 'welcome'`
2. Create the new name (`welcome`) as a live page
3. Flatten any earlier aliases pointing at the old name (Q3 lock)

The archived `landing` page is published as a single-line HTML file
carrying a comment marker:

```
<!-- gazetta:archived alias=welcome -->
```

Worker-served target types (static-with-worker, ESI, dynamic) read the
first 200 bytes of `pages/landing/index.html`, see the marker, and
emit `301 Moved Permanently` to `/welcome` in the request's language
(`/fr/landing` → `/fr/welcome`) — no
composition, no body served. Cache headers on the 301 response strip
strong caching (`Cache-Control: max-age=300`) so unarchive propagates
quickly.

For plain-static targets (no worker — Cloudflare Pages plain assets,
GitHub Pages, S3 static-website), the marker mechanism doesn't fire.
Those targets opt into the `_redirects` host-glue file
(`targets.X.redirects: { format: 'cloudflare' | 'netlify' | 'json' }`)
which the publish flow emits at the target root by walking archived
manifests. Cloudflare Pages and Netlify both honor the file at the
site root; the `json` format is for custom integrations.

The file has one row per language the target publishes, with the
prefixes its routes use (`/landing  /welcome  301` and
`/fr/landing  /fr/welcome  301`), so plain-static sites redirect the
same way worker sites do (decided 2026-10-22, #1124). Today's code
writes default-language rows only
([#1130](https://github.com/gazetta-studio/gazetta-studio/issues/1130)).

### 410 Gone for archived items without aliasOf

A page archived without `aliasOf` is a pure soft-delete — the URL
should return `410 Gone`, not `404 Not Found`. The two HTTP status
codes carry different SEO semantics: 410 tells crawlers the URL is
permanently retired (drop from index), 404 implies "we couldn't find
it but maybe it'll come back" (keep the URL in the crawl queue).

Same mechanism: HTML marker `<!-- gazetta:archived gone -->` on
worker-served targets; `_redirects` 410 row on plain-static targets
that support it (Cloudflare Pages and Netlify both do).

Plain-static hosts that don't support 410 status codes (basic S3
static website, etc.) fall to natural 404 behavior. The capability
gap is surfaced at four points (per `design-soft-delete.md` Q10):
boot validate, author-time modal, validator scanner, publish gate.

### What about manual redirects?

The mechanism supports redirect-without-archive: an operator can
manually create `pages/promo/page.json` with `archived: true,
aliasOf: 'products/featured'`. The page becomes "live as an archived
redirect" — same publish flow, same marker emit. No active content,
just a redirect.

This works today via direct manifest editing. **Admin UI for manual
redirect creation is deferred** (per `seo-plan.md` Tier 2 punch-list
+ `design-soft-delete.md` future directions). The mechanism is the
mechanism; what's missing is a "Create redirect →" form in the admin.

### Status code: only 301 in v1

Renames produce **permanent (301)** redirects exclusively. This is a
locked invariant per `design-soft-delete.md` Q14:

> Renames produce 301; never 302. "I renamed this; the rename is
> permanent." Don't break this expectation later.

Temporary (302), scheduled, and time-bounded redirects are deferred —
see "Future surfaces" below.

## What does NOT ship in v1

| Feature | Owner doc | Status | Trigger |
|---|---|---|---|
| Temporary (302) redirects | `design-soft-delete.md` Q14 (deferred) + future `design-scheduling.md` extension | Reserved | Concrete operator demand for time-bounded redirects |
| Scheduled redirects (activate at date) | `design-scheduling.md` (single-shot action; not yet implemented) | Reserved | Cuts 1-12 of `design-scheduling-implementation.md` ship; redirect lifecycle then composes |
| A/B test redirects (per-cohort) | None — strategic non-fit | Out | No documented demand; experimentation is its own domain |
| Manual redirect creation in admin UI | `seo-plan.md` Tier 2 + `design-soft-delete.md` future directions | Deferred | Concrete operator demand; mechanism exists |
| Redirect chains (multi-hop) | `design-soft-delete.md` Q3 (flatten lock) | Out | Locked invariant — flatten on rename eliminates chains; would require revising Q3 |
| Versioned aliases (`@header-v1` + `@header-v2` simultaneously) | `design-soft-delete.md` future directions | Out | Strategic-bet level; would require revising Q3 flatten |
| `redirects` field in `site.config.ts` (operator-managed list) | None | Reserved | Concrete operator demand; manifest-per-redirect via archive-only manifests is the v1 escape hatch |

## Forward-compat invariants

These invariants are locked in `design-soft-delete.md` Q14 and any
future redirect lifecycle design must respect them:

1. **Renames produce 301, never 302.** Author intent is "this is the
   permanent new home"; later changes to make it temporary would
   violate that contract.
2. **Archive without `aliasOf` produces 410, not 404.** Search-engine
   semantics matter; a future "soft 404" mode would have to be
   explicit operator opt-in.
3. **Manifests are the data, sidecars are derived.** Future
   scheduling fields go on the manifest (per the
   no-publish-time-aggregates principle in
   `feature-design-process.md`).
4. **HTML marker grammar is extensible.** New marker variants
   (e.g., `<!-- gazetta:archived alias=X status=302 expires=... -->`)
   land additively without breaking existing parsers.
5. **Capability-gap UX surfaced at four points.** Future
   redirect-lifecycle features inherit the four-point pattern (boot
   validate / author modal / scanner / publish gate) for plain-static
   targets that can't support time-based behavior.

## Operator config

Per-target `redirects` config — only relevant for plain-static
targets without a worker:

```ts
import { cloudflareWorkersDeploy, defineSite, filesystemStorage, r2Storage } from 'gazetta'

defineSite({
  targets: {
    // Worker-served — uses the HTML marker mechanism; redirects field
    // is unnecessary here (the worker reads the marker directly).
    production: {
      type: 'dynamic',
      storage: r2Storage({ /* ... */ }),
      deploy: cloudflareWorkersDeploy({
        apiToken: process.env.CLOUDFLARE_API_TOKEN!,
        accountId: '...',
        name: 'my-site',
        bucket: 'my-site',
      }),
      siteUrl: 'https://mysite.com',
    },

    // Plain-static deploy on Cloudflare Pages — no worker; redirects
    // field tells the publish flow to emit a `_redirects` file.
    'pages-static': {
      storage: r2Storage({ /* ... */ }),
      type: 'static',
      siteUrl: 'https://static.mysite.com',
      redirects: { format: 'cloudflare' },
    },

    // Custom integration — emit `redirects.json` for a CDN script
    // to consume.
    'custom-static': {
      storage: filesystemStorage({ path: './dist/static' }),
      type: 'static',
      redirects: { format: 'json' },
    },
  },
})
```

When `redirects.format` is unset (or set to `'none'`), no file is
emitted. Worker-served targets ignore the field — they read markers
directly.

## Wire format

Cloudflare Pages / Netlify (`format: 'cloudflare'` or `'netlify'`):

```
/old-page    /new-page    301
/retired     /            410
```

Sorted alphabetically by source for determinism (same input → same
file → host CDN cache hits when republishing).

JSON (`format: 'json'`):

```json
{
  "redirects": [
    { "from": "/old-page", "to": "/new-page", "status": 301 }
  ],
  "gone": [
    { "path": "/retired", "status": 410 }
  ]
}
```

## Cross-target divergence

A target's `redirects` field is per-target — operators publishing to
multiple targets configure each independently. Worker-served targets
don't need it (they have HTML markers); plain-static targets opt in.
The publish pipeline emits per-target during the per-target publish
phase.

A page can be archived on the source but not yet on a destination
target (e.g., `local` was archived; `production` hasn't been
republished yet). **Current code:** `_redirects` is rebuilt from the
source's archived manifests at every publish, so it picks up archives
that were never published to that target and drops purged ones at the
next publish of anything. **Decided** ([`design-target-removal.md`](design-target-removal.md)
Q6): `_redirects` is built from per-page archive sidecars on the
target, so it lists exactly the archives the target holds, and a purged
archive keeps its row until its removal is published (Q5).

## Foundational checks

This is a reference doc, not a foundational dimension. The redirect
mechanism's foundational checks are answered by its owners:

- **Archive flow** — `design-soft-delete.md` Q10 (HTML marker), Q11
  (validation: `dangling-alias`, `referenced-archived-without-alias`)
- **Multi-instance** — same as soft-delete: per-edge HTML markers on
  page files; `_redirects` is a publish-time artifact regenerated
  deterministically from manifests
- **Cache** — 301/410 responses get `Cache-Control: max-age=300` to
  let unarchive propagate quickly; `_redirects` itself is host-cached
  per the host's CDN rules (Cloudflare Pages serves it with the
  default CDN cache headers)
- **Audit** — redirect emission is mechanical bookkeeping; not its
  own audit event. The triggering `archive` / `unarchive` / `rename`
  audit events (per `design-audit.md` + `design-soft-delete.md` Q8)
  carry the user intent
- **Capability-gap UX** — four-point pattern (boot validate / author
  modal / scanner / publish gate) per `design-soft-delete.md` Q10

## Future surfaces

The redirect surface grows in two known directions:

1. **Manual redirect UI** — admin form for "create a redirect from /A
   to /B" without renaming an existing page. The mechanism exists
   (archive-only manifest); the UI form would land as part of the
   editor papercut cluster (Tier 1, demand-driven).

2. **302 / scheduled redirects** — when `design-scheduling.md`'s
   single-shot actions ship (`redirect-activate`, `redirect-expire`),
   redirect lifecycle composes. Manifest extends with optional
   `schedule: { ... }`; HTML marker grammar extends with
   `status=302 expires=...` form. Per-action capability check at fire
   time (per `design-scheduling.md` Q5 lock).

Both are additive to the v1 mechanism. No revision needed.
